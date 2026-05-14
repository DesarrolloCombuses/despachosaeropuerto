/* global L, supabase */
(function () {
    "use strict";

    // ============== Service Worker (PWA) ==============
    if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
            navigator.serviceWorker.register("./sw.js")
                .then(function (reg) {
                    console.log("[PWA] Service Worker registrado", reg.scope);
                    // Detectar actualizaciones del SW
                    reg.addEventListener("updatefound", function () {
                        const nuevo = reg.installing;
                        if (!nuevo) return;
                        nuevo.addEventListener("statechange", function () {
                            if (nuevo.state === "installed" && navigator.serviceWorker.controller) {
                                mostrarBotonActualizar(nuevo);
                            }
                        });
                    });
                })
                .catch(function (err) { console.warn("[PWA] SW falló:", err); });
            // Si el SW activo cambia (se actualizó), recargamos
            navigator.serviceWorker.addEventListener("controllerchange", function () {
                if (window._actualizandoSW) return;
                window._actualizandoSW = true;
                window.location.reload();
            });
        });
    }

    function mostrarBotonActualizar(worker) {
        let banner = document.getElementById("updateBanner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "updateBanner";
            banner.className = "update-banner";
            banner.innerHTML = `
                <span>Nueva versión disponible</span>
                <button type="button" class="btn-update">Actualizar</button>
            `;
            document.body.appendChild(banner);
            banner.querySelector("button").addEventListener("click", function () {
                worker.postMessage("SKIP_WAITING");
            });
        }
    }

    const cfg = window.APP_CONFIG;
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
        document.getElementById("tablaBox").innerHTML =
            '<div class="loading">Falta configuración en config.js</div>';
        return;
    }

    const client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
        },
    });

    let currentUser = null;
    let appStarted = false;

    // Estado global
    let rows = [];
    let selectedItin = null; // null = todos
    let map = null;
    let markersLayer = null;
    let markersByVehicleId = {};
    let realtimeChannel = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000; // ms, sube con backoff hasta 30s
    let activeTab = "mapa";
    let despachos = [];
    let despachosFiltroActivos = true;
    let despachosLoading = false;
    let realizados = [];
    let realizadosFiltroActivos = true;
    let realizadosChannel = null;
    let realizadosPage = 1;
    let realizadosSearch = "";
    const REALIZADOS_PAGE_SIZE = 25;
    const CANCEL_WINDOW_MS = 60 * 60 * 1000; // 1 hora

    // ============== Tabs ==============
    function initTabs() {
        document.querySelectorAll(".tab").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const target = btn.getAttribute("data-tab");
                setActiveTab(target);
            });
        });
    }

    function setActiveTab(name) {
        activeTab = name;
        document.querySelectorAll(".tab").forEach(function (btn) {
            const isActive = btn.getAttribute("data-tab") === name;
            btn.classList.toggle("active", isActive);
            btn.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        document.querySelectorAll(".pane").forEach(function (pane) {
            pane.classList.toggle("active", pane.id === "pane" + capitalize(name));
        });
        // Leaflet necesita invalidateSize si el contenedor cambió de visibilidad
        if (name === "mapa" && map) {
            setTimeout(function () {
                map.invalidateSize();
                if (!window._fitDone && rows.length) {
                    autoFitMap();
                }
            }, 50);
        }
        // Cargar despachos cuando se entra a esa pestaña (si no se ha cargado todavía)
        if (name === "despachos" && !despachos.length && !despachosLoading) {
            cargarDespachos();
        }
        if (name === "realizados") {
            cargarRealizados();
        }
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ============== Mapa ==============
    function initMap() {
        map = L.map("map", { zoomControl: true }).setView(
            [cfg.MAP_CENTER.lat, cfg.MAP_CENTER.lng],
            cfg.MAP_ZOOM
        );
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        markersLayer = L.layerGroup().addTo(map);
    }

    function busMarkerIcon(row) {
        const cls = row.listo ? "bus-marker" : "bus-marker bus-espera";
        const label = escapeHtml(String(row.interno || row.vehicle_id || ""));
        return L.divIcon({
            className: "",
            html: `<div class="${cls}">${label}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
        });
    }

    function autoFitMap() {
        const bounds = [];
        rows.forEach(function (r) {
            if (r.lat != null && r.lon != null) {
                const lat = Number(r.lat), lon = Number(r.lon);
                if (isFinite(lat) && isFinite(lon)) bounds.push([lat, lon]);
            }
        });
        if (bounds.length) {
            map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
            window._fitDone = true;
        }
    }

    function renderMap() {
        if (!map) return;
        markersLayer.clearLayers();
        markersByVehicleId = {};
        rows.forEach(function (row) {
            if (row.lat == null || row.lon == null) return;
            const lat = Number(row.lat);
            const lon = Number(row.lon);
            if (!isFinite(lat) || !isFinite(lon)) return;
            const marker = L.marker([lat, lon], { icon: busMarkerIcon(row) });
            marker.bindPopup(popupHtml(row));
            marker.addTo(markersLayer);
            markersByVehicleId[row.vehicle_id] = marker;
        });
        if (!window._fitDone && activeTab === "mapa") {
            autoFitMap();
        }
    }

    function popupHtml(row) {
        const hace = humanizeAge(row.hora_llegada);
        const estado = row.listo ? "LISTO" : "ESPERA";
        const cls = row.listo ? "listo" : "espera";
        return `
            <div style="font-size:13px;min-width:180px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                <div style="font-weight:900;color:#2b33ff;font-size:16px;margin-bottom:6px;">
                    Bus ${escapeHtml(row.interno || row.vehicle_id || "")}
                </div>
                <div style="margin-bottom:4px;"><b>${escapeHtml(row.itinerario || "")}</b></div>
                <div style="margin-bottom:4px;">Posición: <b>#${row.posicion ?? "-"}</b></div>
                <div style="margin-bottom:4px;">Llegada: <b>${escapeHtml(formatHora(row.hora_llegada))}</b></div>
                <div style="margin-bottom:6px;color:#6b7280;font-size:12px;">${escapeHtml(hace)}</div>
                <span class="estado-pill ${cls}">${estado}</span>
            </div>
        `;
    }

    // ============== Stats ==============
    function updateStats() {
        const total = rows.length;
        const listos = rows.filter(function (r) { return r.listo; }).length;
        const espera = total - listos;

        document.getElementById("statTotal").textContent = String(total);
        document.getElementById("statListos").textContent = String(listos);
        document.getElementById("statEspera").textContent = String(espera);

        document.getElementById("miniTotal").textContent = String(total);
        document.getElementById("miniListos").textContent = String(listos);
        document.getElementById("miniEspera").textContent = String(espera);

        document.getElementById("tabListasBadge").textContent = String(total);
    }

    // ============== Tabla y chips ==============
    function renderChipsAndTable() {
        const grupos = {};
        rows.forEach(function (r) {
            const k = r.itinerario || "Sin itinerario";
            (grupos[k] = grupos[k] || []).push(r);
        });
        Object.values(grupos).forEach(function (arr) {
            arr.sort(function (a, b) {
                return (a.posicion || 9999) - (b.posicion || 9999);
            });
        });

        const itins = Object.keys(grupos).sort();
        const total = rows.length;

        // Chips
        if (selectedItin && !itins.includes(selectedItin)) selectedItin = null;
        const chipsBox = document.getElementById("chips");
        const chipsHtml = [
            `<button type="button" class="chip ${selectedItin === null ? "active" : ""}" data-itin="">
                Todos<span class="chip-count">${total}</span>
            </button>`,
        ].concat(itins.map(function (itin) {
            return `<button type="button" class="chip ${selectedItin === itin ? "active" : ""}" data-itin="${escapeHtml(itin)}">
                ${escapeHtml(itin)}<span class="chip-count">${grupos[itin].length}</span>
            </button>`;
        })).join("");
        chipsBox.innerHTML = chipsHtml;
        chipsBox.querySelectorAll(".chip").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const val = btn.getAttribute("data-itin");
                selectedItin = val ? val : null;
                renderChipsAndTable();
            });
        });

        // Tabla
        const visible = selectedItin === null ? itins : itins.filter(function (i) { return i === selectedItin; });
        const tablaBox = document.getElementById("tablaBox");
        if (!visible.length) {
            tablaBox.innerHTML = '<div class="loading">Sin buses en la geocerca</div>';
            return;
        }
        tablaBox.innerHTML = visible.map(function (itin) {
            const items = grupos[itin];
            const filas = items.map(function (r) {
                const hace = humanizeAge(r.hora_llegada);
                const estadoCls = r.listo ? "listo" : "espera";
                const estadoTxt = r.listo ? "LISTO" : "ESPERA";
                return `
                    <tr class="bus-row" data-vehicle-id="${escapeHtml(r.vehicle_id || "")}" tabindex="0" role="button" aria-label="Asignar itinerario al bus ${escapeHtml(r.interno || "")}">
                        <td class="pos">${r.posicion ?? "-"}</td>
                        <td class="hora">${escapeHtml(formatHora(r.hora_llegada))}</td>
                        <td class="hace">${escapeHtml(hace)}</td>
                        <td class="interno">${escapeHtml(r.interno || "")}</td>
                        <td><span class="estado-pill ${estadoCls}">${estadoTxt}</span></td>
                        <td>
                            <button type="button" class="btn-assign" data-action="assign" data-vehicle-id="${escapeHtml(r.vehicle_id || "")}">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                                </svg>
                                Asignar
                            </button>
                        </td>
                    </tr>
                `;
            }).join("");
            return `
                <div class="itin-group">
                    <div class="itin-head">
                        ${escapeHtml(itin)}
                        <span class="itin-count">${items.length}</span>
                    </div>
                    <table class="arrivals">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Hora</th>
                                <th>Hace</th>
                                <th>Bus</th>
                                <th>Estado</th>
                                <th>Acción</th>
                            </tr>
                        </thead>
                        <tbody>${filas}</tbody>
                    </table>
                </div>
            `;
        }).join("");

        // Click/tap en cualquier parte de la fila abre el modal de asignar.
        // Esto resuelve móviles donde la columna del botón está oculta.
        function abrirDesdeFila(tr) {
            const vid = tr.getAttribute("data-vehicle-id");
            if (!vid) return;
            const row = rows.find(function (r) { return r.vehicle_id === vid; });
            if (row) openAssignModal(row);
        }
        tablaBox.querySelectorAll("tr.bus-row").forEach(function (tr) {
            tr.addEventListener("click", function () { abrirDesdeFila(tr); });
            tr.addEventListener("keydown", function (ev) {
                if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    abrirDesdeFila(tr);
                }
            });
        });
    }

    // ============== Modal asignar itinerario ==============
    function openAssignModal(row) {
        const modal = document.getElementById("assignModal");
        document.getElementById("assignBus").textContent = row.interno || row.vehicle_id || "—";
        document.getElementById("assignDriver").textContent = row.driver_id || "—";
        const select = document.getElementById("assignItin");
        const EXCLUIDOS = ["4413"]; // Aeropuerto-Exposiciones
        const itins = (cfg.ITINERARIOS || []).filter(function (i) {
            return i.grupo === "AEROPUERTO" && !EXCLUIDOS.includes(i.id);
        });
        select.innerHTML =
            '<option value="">— Seleccionar itinerario —</option>' +
            itins.map(function (i) {
                return `<option value="${escapeHtml(i.id)}">${escapeHtml(i.nombre)}</option>`;
            }).join("");
        // Preseleccionar si el itinerario actual del bus coincide con alguno conocido
        const match = itins.find(function (i) { return i.nombre === row.itinerario; });
        if (match) select.value = match.id;
        document.getElementById("assignObs").value = "";
        document.getElementById("assignError").hidden = true;
        document.getElementById("assignSubmit").dataset.vehicleId = row.vehicle_id || "";
        document.getElementById("assignSubmit").dataset.driverId = row.driver_id || "";
        modal.hidden = false;
    }

    function closeAssignModal() {
        document.getElementById("assignModal").hidden = true;
    }

    async function submitAssign(ev) {
        ev.preventDefault();
        const submitBtn = document.getElementById("assignSubmit");
        const errorBox = document.getElementById("assignError");
        const mId = submitBtn.dataset.vehicleId;
        const drvId = submitBtn.dataset.driverId;
        const itinerary = document.getElementById("assignItin").value;
        const observaciones = document.getElementById("assignObs").value.trim();

        if (!mId) {
            errorBox.textContent = "Falta el ID del bus.";
            errorBox.hidden = false;
            return;
        }
        if (!itinerary) {
            errorBox.textContent = "Selecciona un itinerario.";
            errorBox.hidden = false;
            return;
        }
        if (!drvId) {
            errorBox.textContent = "Este bus no tiene conductor registrado.";
            errorBox.hidden = false;
            return;
        }

        // Datos del bus seleccionado (para guardar en despachos_realizados)
        const row = rows.find(function (r) { return r.vehicle_id === mId; });
        const itinObj = (cfg.ITINERARIOS || []).find(function (i) { return i.id === itinerary; });

        // Confirmación previa al envío a Sonar
        const driverNombre = document.getElementById("assignDriver")?.textContent || "—";
        const detalleHtml = `
            <div><strong>Bus:</strong> ${escapeHtml(row?.interno || mId)}</div>
            <div><strong>Conductor:</strong> ${escapeHtml(driverNombre)}</div>
            <div><strong>Itinerario:</strong> ${escapeHtml(itinObj?.nombre || itinerary)}</div>
            ${observaciones ? `<div><strong>Observación:</strong> ${escapeHtml(observaciones)}</div>` : ""}
        `;
        const okDespachar = await mostrarConfirmacion({
            titulo: "Confirmar despacho",
            mensaje: "Se enviará la orden a Sonar y quedará registrada en Despachos realizados.",
            detalle: detalleHtml,
            textoConfirmar: "Sí, despachar",
            textoCancelar: "Revisar",
            tipo: "info",
        });
        if (!okDespachar) return;

        errorBox.hidden = true;
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando...";

        try {
            const resp = await fetch(cfg.SONAR_DISPATCH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apikey: cfg.SUPABASE_ANON_KEY,
                    Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({ mId, itinerary, drvId, observaciones }),
            });
            const data = await resp.json().catch(function () { return {}; });
            if (!resp.ok || data.success === false) {
                throw new Error(data.message || data.error || ("HTTP " + resp.status));
            }

            const regId = data?.data?.regId || "";
            // Guardar despacho en tabla despachos_realizados (si tenemos regId)
            if (regId) {
                try {
                    const { error } = await client.from(cfg.TABLA_REALIZADOS).insert({
                        reg_id: regId,
                        vehicle_id: mId,
                        interno: row?.interno || mId,
                        placa: "",
                        itinerario_id: itinerary,
                        itinerario: itinObj?.nombre || "",
                        driver_id: drvId,
                        observaciones: observaciones,
                        pasajeros: 0,
                        created_by: currentUser?.id || null,
                    });
                    if (error) console.warn("Insert despachos_realizados falló:", error);
                } catch (e) {
                    console.warn("No se pudo guardar el despacho local:", e);
                }
            }

            closeAssignModal();
            showToast("ok", `Despacho asignado${regId ? " · regId: " + regId : ""}`);
        } catch (err) {
            errorBox.textContent = "Error: " + (err.message || String(err));
            errorBox.hidden = false;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Asignar";
        }
    }

    function initModal() {
        const modal = document.getElementById("assignModal");
        modal.querySelectorAll("[data-close]").forEach(function (btn) {
            btn.addEventListener("click", closeAssignModal);
        });
        modal.addEventListener("click", function (ev) {
            if (ev.target === modal) closeAssignModal();
        });
        document.addEventListener("keydown", function (ev) {
            if (ev.key === "Escape" && !modal.hidden) closeAssignModal();
        });
        document.getElementById("assignForm").addEventListener("submit", submitAssign);
    }

    // ============== Toast ==============
    let toastTimer = null;
    function showToast(kind, msg) {
        const toast = document.getElementById("toast");
        toast.className = "toast toast-" + kind;
        toast.textContent = "";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "18");
        icon.setAttribute("height", "18");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "2.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("d", kind === "ok" ? "M5 13l4 4L19 7" : "M12 9v4m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z");
        icon.appendChild(path);
        toast.appendChild(icon);
        toast.appendChild(document.createTextNode(msg));
        toast.hidden = false;
        requestAnimationFrame(function () { toast.classList.add("show"); });
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove("show");
            setTimeout(function () { toast.hidden = true; }, 250);
        }, 4500);
    }

    // ============== Modal de confirmación ==============
    function mostrarConfirmacion(opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            const modal = document.getElementById("confirmModal");
            const titleEl = document.getElementById("confirmTitle");
            const msgEl = document.getElementById("confirmMessage");
            const detailEl = document.getElementById("confirmDetail");
            const iconEl = document.getElementById("confirmIcon");
            const btnOk = document.getElementById("confirmAccept");
            const btnCancel = document.getElementById("confirmCancel");
            if (!modal) {
                // Fallback si por alguna razón no está montado
                resolve(window.confirm(opts.mensaje || "¿Confirmar?"));
                return;
            }

            titleEl.textContent = opts.titulo || "¿Confirmar acción?";
            msgEl.textContent = opts.mensaje || "Esta acción se realizará a continuación.";

            if (opts.detalle) {
                detailEl.innerHTML = opts.detalle;
                detailEl.hidden = false;
            } else {
                detailEl.innerHTML = "";
                detailEl.hidden = true;
            }

            const tipo = opts.tipo || "warn"; // warn | danger | info
            iconEl.className = "confirm-icon confirm-icon-" + tipo;

            btnOk.textContent = opts.textoConfirmar || "Confirmar";
            btnCancel.textContent = opts.textoCancelar || "Cancelar";
            btnOk.className = "btn " + (tipo === "danger" ? "btn-danger" : "btn-primary");

            function cerrar(valor) {
                modal.hidden = true;
                btnOk.removeEventListener("click", onOk);
                btnCancel.removeEventListener("click", onCancel);
                modal.removeEventListener("click", onBackdrop);
                document.removeEventListener("keydown", onKey);
                resolve(valor);
            }
            function onOk() { cerrar(true); }
            function onCancel() { cerrar(false); }
            function onBackdrop(ev) { if (ev.target === modal) cerrar(false); }
            function onKey(ev) {
                if (ev.key === "Escape") cerrar(false);
                if (ev.key === "Enter") cerrar(true);
            }

            btnOk.addEventListener("click", onOk);
            btnCancel.addEventListener("click", onCancel);
            modal.addEventListener("click", onBackdrop);
            document.addEventListener("keydown", onKey);

            modal.hidden = false;
            setTimeout(function () { btnOk.focus(); }, 50);
        });
    }

    // ============== Utilidades ==============
    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatHora(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function humanizeAge(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
        if (mins < 60) return `hace ${mins} min`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `hace ${h} h ${m} min`;
    }

    function setConnection(state) {
        const el = document.getElementById("connection");
        el.className = "badge";
        if (state === "ok") {
            el.classList.add("badge-ok");
            el.textContent = "En vivo";
        } else if (state === "offline") {
            el.classList.add("badge-err");
            el.textContent = "Sin internet";
        } else if (state === "err") {
            el.classList.add("badge-err");
            el.textContent = "Sin conexión";
        } else if (state === "reconnecting") {
            el.classList.add("badge-warn");
            el.textContent = "Reconectando...";
        } else {
            el.classList.add("badge-warn");
            el.textContent = "Conectando...";
        }
    }

    function setLastUpdate() {
        document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
    }

    // ============== Despachos ==============
    function despachoIsoUtc(d) {
        // Sonar devuelve initDate/initTime en HORA LOCAL COLOMBIA (UTC-5),
        // a pesar de que su campo se llame "UTC_datetime". Marcamos -05:00
        // para que JS lo interprete bien sin importar la zona del navegador.
        const date = String(d.initDate || "").trim();
        const time = String(d.initTime || "").trim();
        if (!date) return null;
        const t = time || "00:00:00";
        return `${date}T${t}-05:00`;
    }

    function despachoEstado(d) {
        // lcanceled / lcanceledbyuser → cancelado
        // lrunning="true" → activo en ruta
        // lclose="true" + no cancelado → completado
        const canceled = String(d.lcanceled).toLowerCase() === "true" || String(d.lcanceledbyuser).toLowerCase() === "true";
        const running = String(d.lrunning).toLowerCase() === "true";
        const closed = String(d.lclose).toLowerCase() === "true";
        if (canceled) return { txt: "CANCELADO", cls: "cancelado" };
        if (running) return { txt: "EN RUTA", cls: "activo" };
        if (closed) return { txt: "COMPLETADO", cls: "listo" };
        return { txt: "PENDIENTE", cls: "espera" };
    }

    async function cargarDespachos() {
        if (despachosLoading) return;
        if (!navigator.onLine) {
            document.getElementById("despachosBox").innerHTML =
                '<div class="loading">Sin conexión. Conéctate a internet para ver despachos.</div>';
            return;
        }
        despachosLoading = true;
        const box = document.getElementById("despachosBox");
        const subtitle = document.getElementById("despachosSubtitle");
        if (subtitle) subtitle.textContent = "Cargando últimas " + cfg.DESPACHOS_LOOKBACK_HORAS + " horas...";
        try {
            const ahora = new Date();
            const inicio = new Date(ahora.getTime() - (cfg.DESPACHOS_LOOKBACK_HORAS || 5) * 60 * 60 * 1000);
            const resp = await fetch(cfg.SONAR_DESPACHOS_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fecha_inicio: inicio.toISOString(),
                    fecha_fin: ahora.toISOString(),
                }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                throw new Error(data.message || "Error " + resp.status);
            }
            despachos = (data.despachos || []).slice();
            // Ordenar por hora desc (más reciente arriba)
            despachos.sort(function (a, b) {
                const ta = despachoIsoUtc(a) || "";
                const tb = despachoIsoUtc(b) || "";
                return tb.localeCompare(ta);
            });
            renderDespachos();
        } catch (err) {
            console.error(err);
            box.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message || String(err))}</div>`;
            if (subtitle) subtitle.textContent = "Error al cargar";
        } finally {
            despachosLoading = false;
        }
    }

    function normalizarItinerario(s) {
        return String(s || "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "") // quita tildes
            .toLowerCase()
            .trim();
    }

    function renderDespachos() {
        const box = document.getElementById("despachosBox");
        const subtitle = document.getElementById("despachosSubtitle");
        const badge = document.getElementById("tabDespachosBadge");

        // Filtro por lista blanca de itinerarios (config.js)
        const permitidos = new Set((cfg.DESPACHOS_ITINERARIOS_PERMITIDOS || []).map(normalizarItinerario));
        const despachosFiltrados = permitidos.size
            ? despachos.filter(function (d) { return permitidos.has(normalizarItinerario(d.itDesc)); })
            : despachos;

        const visibles = despachosFiltroActivos
            ? despachosFiltrados.filter(function (d) {
                  const canceled = String(d.lcanceled).toLowerCase() === "true" || String(d.lcanceledbyuser).toLowerCase() === "true";
                  return !canceled;
              })
            : despachosFiltrados;

        if (badge) badge.textContent = String(visibles.length);

        if (subtitle) {
            const totalSinFiltro = despachos.length;
            const totalFiltrado = despachosFiltrados.length;
            const partes = [`${visibles.length} mostrados`];
            if (despachosFiltroActivos) partes.push(`${totalFiltrado} totales del itinerario`);
            if (permitidos.size) partes.push(`${totalSinFiltro} despachos totales`);
            partes.push(`últimas ${cfg.DESPACHOS_LOOKBACK_HORAS} h`);
            subtitle.textContent = partes.join(" · ");
        }

        if (!visibles.length) {
            box.innerHTML = '<div class="loading">No hay despachos en este rango</div>';
            return;
        }

        const filas = visibles.map(function (d) {
            const iso = despachoIsoUtc(d);
            const hora = iso ? formatHora(iso) : (d.initTime || "");
            const hace = iso ? humanizeAge(iso) : "";
            const estado = despachoEstado(d);
            return `
                <tr>
                    <td class="hora">${escapeHtml(hora)}</td>
                    <td class="hace">${escapeHtml(hace)}</td>
                    <td class="interno">
                        ${escapeHtml(d.mDesc || d.interno || "")}
                        <span class="placa-tag">${escapeHtml(d.mPlaca || d.placa || "")}</span>
                    </td>
                    <td>${escapeHtml(d.itDesc || "")}</td>
                    <td class="conductor-cell" title="${escapeHtml(d.drName || "")}">${escapeHtml(d.drName || "—")}</td>
                    <td><span class="estado-pill ${estado.cls}">${estado.txt}</span></td>
                </tr>
            `;
        }).join("");

        box.innerHTML = `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Hace</th>
                        <th>Bus</th>
                        <th>Itinerario</th>
                        <th>Conductor</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;
    }

    // ============== Realizados (despachos_realizados) ==============
    async function cargarRealizados() {
        try {
            const { data, error } = await client
                .from(cfg.TABLA_REALIZADOS)
                .select("*")
                .order("created_at", { ascending: false })
                .limit(500);
            if (error) throw error;
            realizados = data || [];
            renderRealizados();
        } catch (err) {
            console.warn("Error cargando realizados:", err);
            const box = document.getElementById("realizadosBox");
            if (box) box.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message || String(err))}</div>`;
        }
    }

    function suscribirRealizadosRealtime() {
        if (realizadosChannel) return;
        realizadosChannel = client
            .channel("despachos_realizados_changes")
            .on("postgres_changes", { event: "*", schema: "public", table: cfg.TABLA_REALIZADOS }, function () {
                cargarRealizados();
            })
            .subscribe();
    }

    function detenerRealizadosRealtime() {
        if (realizadosChannel) {
            try { client.removeChannel(realizadosChannel); } catch (_) {}
            realizadosChannel = null;
        }
    }

    function realizadoMatchesSearch(r, q) {
        if (!q) return true;
        const campos = [
            r.interno, r.placa, r.itinerario, r.itinerario_id,
            r.estado, r.reg_id, r.vehicle_id, r.driver_id,
            r.observaciones, r.created_by,
        ];
        for (let i = 0; i < campos.length; i++) {
            const v = campos[i];
            if (v != null && String(v).toLowerCase().includes(q)) return true;
        }
        return false;
    }

    function renderRealizados() {
        const box = document.getElementById("realizadosBox");
        const subtitle = document.getElementById("realizadosSubtitle");
        const badge = document.getElementById("tabRealizadosBadge");
        const pager = document.getElementById("realizadosPager");
        const pagerInfo = document.getElementById("pagerInfo");
        const pagerPrev = document.getElementById("pagerPrev");
        const pagerNext = document.getElementById("pagerNext");
        if (!box) return;

        const q = (realizadosSearch || "").toLowerCase().trim();
        let visibles = realizadosFiltroActivos
            ? realizados.filter(function (r) { return r.estado === "ACTIVO"; })
            : realizados.slice();
        if (q) visibles = visibles.filter(function (r) { return realizadoMatchesSearch(r, q); });

        if (badge) badge.textContent = String(visibles.length);
        if (subtitle) {
            const activos = realizados.filter(function (r) { return r.estado === "ACTIVO"; }).length;
            const cancelados = realizados.length - activos;
            subtitle.textContent = `${activos} activos · ${cancelados} cancelados · ${realizados.length} totales`;
        }

        if (!visibles.length) {
            box.innerHTML = q
                ? '<div class="loading">No hay resultados para tu búsqueda</div>'
                : '<div class="loading">No hay despachos realizados todavía</div>';
            if (pager) pager.hidden = true;
            return;
        }

        // Paginación
        const totalPaginas = Math.max(1, Math.ceil(visibles.length / REALIZADOS_PAGE_SIZE));
        if (realizadosPage > totalPaginas) realizadosPage = totalPaginas;
        if (realizadosPage < 1) realizadosPage = 1;
        const inicio = (realizadosPage - 1) * REALIZADOS_PAGE_SIZE;
        const paginaItems = visibles.slice(inicio, inicio + REALIZADOS_PAGE_SIZE);

        if (pager) {
            pager.hidden = totalPaginas <= 1;
            if (pagerInfo) {
                pagerInfo.textContent =
                    `Página ${realizadosPage} de ${totalPaginas} · ${visibles.length} registros`;
            }
            if (pagerPrev) pagerPrev.disabled = realizadosPage <= 1;
            if (pagerNext) pagerNext.disabled = realizadosPage >= totalPaginas;
        }

        const ahora = Date.now();
        const filas = paginaItems.map(function (r) {
            const hora = formatHora(r.created_at);
            const hace = humanizeAge(r.created_at);
            const isCancelado = r.estado !== "ACTIVO";
            const estadoCls = isCancelado ? "cancelado-est" : "activo";
            const estadoTxt = isCancelado ? "CANCELADO" : "ACTIVO";
            const creadoMs = new Date(r.created_at).getTime();
            const expirado = Number.isFinite(creadoMs) && (ahora - creadoMs) > CANCEL_WINDOW_MS;

            let accionHtml;
            if (isCancelado) {
                accionHtml = '<span class="muted" style="font-size:11px;">—</span>';
            } else if (expirado) {
                accionHtml = '<span class="muted" title="No se puede cancelar después de 1 hora" style="font-size:11px;">Expirado</span>';
            } else {
                accionHtml = `<button type="button" class="btn-cancelar" data-action="cancelar"
                    data-id="${escapeHtml(r.id)}"
                    data-reg-id="${escapeHtml(r.reg_id)}"
                    data-mid="${escapeHtml(r.vehicle_id || "")}">Cancelar</button>`;
            }

            return `
                <tr data-id="${escapeHtml(r.id)}" data-reg-id="${escapeHtml(r.reg_id)}" data-mid="${escapeHtml(r.vehicle_id || "")}">
                    <td class="hora">${escapeHtml(hora)}</td>
                    <td class="hace">${escapeHtml(hace)}</td>
                    <td class="interno">
                        ${escapeHtml(r.interno || "")}
                    </td>
                    <td>${escapeHtml(r.itinerario || "")}</td>
                    <td>
                        <input type="number" min="0" max="999" class="pasajeros-input"
                            value="${escapeHtml(r.pasajeros ?? 0)}"
                            ${isCancelado ? "disabled" : ""}
                            data-id="${escapeHtml(r.id)}">
                    </td>
                    <td><span class="estado-pill ${estadoCls}">${estadoTxt}</span></td>
                    <td>${accionHtml}</td>
                </tr>
            `;
        }).join("");

        box.innerHTML = `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Hace</th>
                        <th>Bus</th>
                        <th>Itinerario</th>
                        <th>Pasajeros</th>
                        <th>Estado</th>
                        <th>Acción</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;

        // Listeners para edición de pasajeros (auto-save al cambiar)
        box.querySelectorAll(".pasajeros-input").forEach(function (input) {
            input.addEventListener("change", async function () {
                const id = input.dataset.id;
                const nuevo = parseInt(input.value, 10);
                if (!Number.isFinite(nuevo) || nuevo < 0) {
                    input.value = "0";
                    return;
                }
                input.classList.add("saving");
                try {
                    const { error } = await client
                        .from(cfg.TABLA_REALIZADOS)
                        .update({ pasajeros: nuevo })
                        .eq("id", id);
                    if (error) throw error;
                    input.classList.remove("saving");
                    input.classList.add("saved");
                    setTimeout(function () { input.classList.remove("saved"); }, 1500);
                    const r = realizados.find(function (x) { return x.id === id; });
                    if (r) r.pasajeros = nuevo;
                } catch (err) {
                    input.classList.remove("saving");
                    showToast("err", "Error guardando pasajeros: " + (err.message || err));
                }
            });
        });

        // Listeners para cancelar
        box.querySelectorAll('[data-action="cancelar"]').forEach(function (btn) {
            btn.addEventListener("click", async function () {
                const id = btn.dataset.id;
                const regId = btn.dataset.regId;
                const mId = btn.dataset.mid;
                const reg = realizados.find(function (x) { return x.id === id; });
                // Doble verificación: bloquea si pasó la ventana de 1h
                if (reg?.created_at) {
                    const ageMs = Date.now() - new Date(reg.created_at).getTime();
                    if (Number.isFinite(ageMs) && ageMs > CANCEL_WINDOW_MS) {
                        showToast("err", "No se puede cancelar: pasó más de 1 hora desde el despacho");
                        renderRealizados();
                        return;
                    }
                }
                const detalleHtml = `
                    <div><strong>Bus:</strong> ${escapeHtml(reg?.interno || mId)}</div>
                    <div><strong>Itinerario:</strong> ${escapeHtml(reg?.itinerario || "—")}</div>
                    <div><strong>Despachado:</strong> ${escapeHtml(formatHora(reg?.created_at))} · ${escapeHtml(humanizeAge(reg?.created_at))}</div>
                `;
                const ok = await mostrarConfirmacion({
                    titulo: "Cancelar despacho",
                    mensaje: "Esta acción anula el despacho en Sonar y no se puede deshacer.",
                    detalle: detalleHtml,
                    textoConfirmar: "Sí, cancelar despacho",
                    textoCancelar: "Volver",
                    tipo: "danger",
                });
                if (!ok) return;

                btn.disabled = true;
                btn.textContent = "Cancelando...";
                try {
                    const resp = await fetch(cfg.SONAR_CANCEL_URL, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            apikey: cfg.SUPABASE_ANON_KEY,
                            Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
                        },
                        body: JSON.stringify({
                            mId,
                            regId,
                            comments: "Cancelado desde web",
                            dispatchId: id,
                            canceledBy: currentUser?.email || "unknown",
                            vehicle: { interno: reg?.interno, placa: reg?.placa },
                            dispatch: { itinerario: reg?.itinerario, itinerario_id: reg?.itinerario_id },
                        }),
                    });
                    const data = await resp.json().catch(function () { return {}; });
                    if (!resp.ok || data.success === false) {
                        throw new Error(data.message || ("HTTP " + resp.status));
                    }
                    // Marcar como cancelado en la tabla
                    await client.from(cfg.TABLA_REALIZADOS).update({
                        estado: "CANCELADO",
                        cancelled_at: new Date().toISOString(),
                        cancel_response: data?.data || null,
                    }).eq("id", id);
                    showToast("ok", "Despacho cancelado");
                } catch (err) {
                    showToast("err", "Error: " + (err.message || err));
                    btn.disabled = false;
                    btn.textContent = "Cancelar";
                }
            });
        });
    }

    function initRealizadosControles() {
        const chk = document.getElementById("filterRealizadosActivos");
        if (chk) {
            chk.addEventListener("change", function () {
                realizadosFiltroActivos = chk.checked;
                realizadosPage = 1;
                renderRealizados();
            });
        }
        const search = document.getElementById("searchRealizados");
        if (search) {
            let t = null;
            search.addEventListener("input", function () {
                clearTimeout(t);
                t = setTimeout(function () {
                    realizadosSearch = search.value || "";
                    realizadosPage = 1;
                    renderRealizados();
                }, 200);
            });
        }
        const pPrev = document.getElementById("pagerPrev");
        const pNext = document.getElementById("pagerNext");
        if (pPrev) {
            pPrev.addEventListener("click", function () {
                if (realizadosPage > 1) {
                    realizadosPage--;
                    renderRealizados();
                }
            });
        }
        if (pNext) {
            pNext.addEventListener("click", function () {
                realizadosPage++;
                renderRealizados();
            });
        }
    }

    // ============== Carga inicial + Realtime ==============
    async function cargarInicial() {
        if (!navigator.onLine) {
            setConnection("offline");
            return;
        }
        try {
            const { data, error } = await client
                .from(cfg.TABLA)
                .select("*")
                .order("itinerario", { ascending: true })
                .order("posicion", { ascending: true });
            if (error) throw error;
            rows = data || [];
            updateStats();
            renderChipsAndTable();
            renderMap();
            setLastUpdate();
            reconnectDelay = 2000;
        } catch (err) {
            console.error("Error cargando datos:", err);
            const tablaBox = document.getElementById("tablaBox");
            if (!rows.length) {
                tablaBox.innerHTML =
                    `<div class="loading">Sin datos. Reintentando...</div>`;
            }
            setConnection(navigator.onLine ? "err" : "offline");
            programarReintento();
        }
    }

    function suscribirRealtime() {
        if (realtimeChannel) {
            try { client.removeChannel(realtimeChannel); } catch (_) { /* noop */ }
            realtimeChannel = null;
        }
        realtimeChannel = client
            .channel("llegadas_104_changes")
            .on("postgres_changes", { event: "*", schema: "public", table: cfg.TABLA }, function () {
                cargarInicial();
            })
            .subscribe(function (status) {
                if (status === "SUBSCRIBED") {
                    setConnection("ok");
                    reconnectDelay = 2000;
                } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                    setConnection(navigator.onLine ? "reconnecting" : "offline");
                    programarReintento();
                }
            });
    }

    function programarReintento() {
        if (reconnectTimer) return;
        if (!navigator.onLine) return;
        const wait = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        console.log(`Reintentando en ${wait}ms...`);
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            cargarInicial();
            suscribirRealtime();
        }, wait);
    }

    // ============== Detección online/offline ==============
    window.addEventListener("online", function () {
        console.log("Conexión recuperada");
        setConnection("reconnecting");
        reconnectDelay = 2000;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        cargarInicial();
        suscribirRealtime();
    });

    window.addEventListener("offline", function () {
        console.log("Sin internet");
        setConnection("offline");
    });

    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && navigator.onLine) {
            cargarInicial();
            if (!realtimeChannel || realtimeChannel.state !== "joined") {
                suscribirRealtime();
            }
        }
    });

    // Refresca "hace X min" cada minuto sin volver a pedir datos.
    setInterval(function () {
        renderChipsAndTable();
        if (despachos.length) renderDespachos();
    }, 60000);

    // Auto-refresh de despachos cada 2 minutos si estás en la pestaña
    setInterval(function () {
        if (activeTab === "despachos" && navigator.onLine) cargarDespachos();
    }, 120000);

    function initDespachosControles() {
        const btn = document.getElementById("btnRefreshDespachos");
        if (btn) btn.addEventListener("click", cargarDespachos);
        const chk = document.getElementById("filterActivos");
        if (chk) {
            chk.addEventListener("change", function () {
                despachosFiltroActivos = chk.checked;
                renderDespachos();
            });
        }
    }

    // ============== AUTH ==============
    function initAuth() {
        const form = document.getElementById("loginForm");
        const errorBox = document.getElementById("loginError");
        const submitBtn = document.getElementById("loginSubmit");
        const btnLogout = document.getElementById("btnLogout");

        if (form) {
            form.addEventListener("submit", async function (ev) {
                ev.preventDefault();
                errorBox.hidden = true;
                submitBtn.disabled = true;
                submitBtn.textContent = "Entrando...";
                const email = document.getElementById("loginEmail").value.trim();
                const password = document.getElementById("loginPass").value;
                console.log("[LOGIN] Intentando con:", email);
                try {
                    const { data, error } = await client.auth.signInWithPassword({ email, password });
                    console.log("[LOGIN] Respuesta:", { user: data?.user?.email, error });
                    if (error) throw error;
                    if (!data?.user) throw new Error("Sin usuario en la respuesta");
                    // Forzar transición a la app sin esperar onAuthStateChange
                    currentUser = data.user;
                    actualizarUiAuth();
                    if (!appStarted) startApp();
                    console.log("[LOGIN] App iniciada");
                } catch (err) {
                    console.error("[LOGIN] Error:", err);
                    // Mostrar el mensaje real de Supabase para diagnosticar
                    const msg = err?.message || String(err);
                    errorBox.textContent = msg;
                    errorBox.hidden = false;
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Entrar";
                }
            });
        }

        if (btnLogout) {
            btnLogout.addEventListener("click", async function () {
                const ok = await mostrarConfirmacion({
                    titulo: "Cerrar sesión",
                    mensaje: "Volverás a la pantalla de inicio de sesión. Tu trabajo en curso se guardó automáticamente.",
                    detalle: currentUser?.email
                        ? `<div><strong>Usuario:</strong> ${escapeHtml(currentUser.email)}</div>`
                        : "",
                    textoConfirmar: "Cerrar sesión",
                    textoCancelar: "Seguir trabajando",
                    tipo: "warn",
                });
                if (!ok) return;
                await client.auth.signOut();
            });
        }

        // Detectar cambios de sesión (login, logout, refresh)
        client.auth.onAuthStateChange(function (event, session) {
            console.log("[AUTH] Evento:", event, "user:", session?.user?.email);
            currentUser = session?.user || null;
            actualizarUiAuth();
            if (currentUser && !appStarted) startApp();
            if (!currentUser) detenerRealizadosRealtime();
        });

        // Verificar sesión actual al cargar
        client.auth.getSession().then(function (res) {
            currentUser = res.data?.session?.user || null;
            actualizarUiAuth();
            if (currentUser) startApp();
        });
    }

    function actualizarUiAuth() {
        const loginScreen = document.getElementById("loginScreen");
        const btnLogout = document.getElementById("btnLogout");
        if (currentUser) {
            loginScreen.hidden = true;
            btnLogout.hidden = false;
            btnLogout.title = `Cerrar sesión (${currentUser.email})`;
        } else {
            loginScreen.hidden = false;
            btnLogout.hidden = true;
        }
    }

    function startApp() {
        if (appStarted) return;
        appStarted = true;
        initTabs();
        initMap();
        initModal();
        initDespachosControles();
        initRealizadosControles();
        if (navigator.onLine) {
            cargarInicial();
            suscribirRealtime();
            suscribirRealizadosRealtime();
            cargarRealizados();
        } else {
            setConnection("offline");
        }
    }

    initAuth();
})();

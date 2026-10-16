/* global L, supabase */
(function () {
    "use strict";

    // Operaciones contra Sonar que no se pueden cortar a la mitad (ver
    // recargarCuandoSeaSeguro). Va aquí arriba porque el SW la consulta.
    let operacionesEnCurso = 0;

    // ============== Service Worker (PWA) ==============
    if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
            // updateViaCache:"none" evita que el navegador use su caché HTTP normal
            // (GitHub Pages sirve sw.js con Cache-Control: max-age=600) para decidir
            // si hay un service worker nuevo -- sin esto, una actualización recién
            // publicada puede tardar hasta 10 min en siquiera notarse.
            navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
                .then(function (reg) {
                    console.log("[PWA] Service Worker registrado", reg.scope);

                    // Cuando se instala un SW nuevo, mostramos un banner
                    // informando al usuario. Si no actúa en 10 s, lo aplicamos solo.
                    function activarSiInstalado(worker) {
                        if (!worker) return;
                        if (worker.state === "installed" && navigator.serviceWorker.controller) {
                            mostrarBannerActualizar(worker);
                        }
                    }
                    // Caso 1: ya hay un worker en "waiting" al cargar
                    activarSiInstalado(reg.waiting);
                    // Caso 2: detectamos una actualización mientras la app está abierta
                    reg.addEventListener("updatefound", function () {
                        const nuevo = reg.installing;
                        if (!nuevo) return;
                        nuevo.addEventListener("statechange", function () {
                            activarSiInstalado(nuevo);
                        });
                    });
                    // Revisar actualizaciones cuando la pestaña vuelve a primer plano
                    document.addEventListener("visibilitychange", function () {
                        if (document.visibilityState === "visible") {
                            reg.update().catch(function () { /* sin red, ignorar */ });
                        }
                    });
                    // Y cada 3 minutos: la pantalla del despachador se queda
                    // abierta y visible todo el día, sin recargar ni cambiar de
                    // pestaña, así que nunca se enteraba de una versión nueva.
                    setInterval(function () {
                        reg.update().catch(function () { /* sin red, ignorar */ });
                    }, 3 * 60 * 1000);
                })
                .catch(function (err) { console.warn("[PWA] SW falló:", err); });
            // Cuando el SW activo cambia (auto-update), recargamos una vez
            navigator.serviceWorker.addEventListener("controllerchange", function () {
                if (window._actualizandoSW) return;
                window._actualizandoSW = true;
                recargarCuandoSeaSeguro();
            });
        });
    }

    // La recarga por versión nueva es obligatoria, pero no en mitad de un
    // despacho: si Sonar ya aceptó la orden y la página se recarga antes de
    // guardarla en despachos_realizados, el despacho queda sin registro. Con una
    // ventana abierta (asignar, despacho manual, confirmación) o una operación
    // en curso, se espera y se vuelve a intentar.
    function recargarCuandoSeaSeguro() {
        const ventanaAbierta = document.querySelector(".modal-backdrop:not([hidden])");
        if (ventanaAbierta || operacionesEnCurso > 0) {
            setTimeout(recargarCuandoSeaSeguro, 2000);
            return;
        }
        window.location.reload();
    }

    function mostrarBannerActualizar(worker) {
        if (document.getElementById("updateBanner")) return; // ya hay uno
        const banner = document.createElement("div");
        banner.id = "updateBanner";
        banner.className = "update-banner";
        banner.innerHTML = `
            <span id="updateMsg">Nueva versión disponible · se actualizará en <b id="updateCount">10</b>s</span>
            <button type="button" class="btn-update">Actualizar ahora</button>
        `;
        document.body.appendChild(banner);

        let restante = 10;
        const countEl = banner.querySelector("#updateCount");
        const tick = setInterval(function () {
            restante -= 1;
            if (countEl) countEl.textContent = String(Math.max(0, restante));
            if (restante <= 0) {
                clearInterval(tick);
                aplicar();
            }
        }, 1000);

        function aplicar() {
            clearInterval(tick);
            const msg = document.getElementById("updateMsg");
            if (msg) msg.textContent = "Actualizando...";
            const btn = banner.querySelector(".btn-update");
            if (btn) btn.disabled = true;
            try { worker.postMessage("SKIP_WAITING"); } catch (_) { /* noop */ }
        }

        banner.querySelector("button").addEventListener("click", aplicar);
    }

    const cfg = window.APP_CONFIG;

    // Quitar el splash y pintar la versión en cuanto el DOM esté listo.
    // Con scripts deferred esto se ejecuta justo antes de DOMContentLoaded.
    function listoUiInicial() {
        const v = document.getElementById("appVersion");
        if (v && cfg && cfg.APP_VERSION) v.textContent = cfg.APP_VERSION;
        document.body.classList.add("app-ready");
        const splash = document.getElementById("appSplash");
        if (splash) setTimeout(function () { splash.remove(); }, 250);
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", listoUiInicial, { once: true });
    } else {
        listoUiInicial();
    }
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
    let ocultos = new Set(); // ids (vehicle_id+llegada_aeropuerto) ocultados a mano de la lista de espera
    let posiciones = []; // flota completa en vivo (sonar_posiciones)
    let selectedItin = null; // null = todos
    let mapaBusqueda = ""; // filtro de texto del mapa (interno/placa/mid)
    let mapaFiltroEstado = "todos"; // "todos" | "andando" | "detenido"
    let mapaFiltroZona = null; // null | "patio_azul" | "subiendo" | "bajando" -- click en un mini-stat
    let map = null;
    let markersLayer = null;
    let markersByVehicleId = {}; // buses en fila
    let markersFlotaByMid = {}; // resto de la flota
    let turnoStopEls = {}; // línea de turno: vehicle_id -> elemento DOM
    let realtimeChannel = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000; // ms, sube con backoff hasta 30s
    let activeTab = "mapa";
    let despachos = [];
    let despachosFiltroActivos = true;
    let despachosLoading = false;
    let vehiculos = [];
    let vehiculosLoading = null;
    let conductores = [];
    let conductoresLoading = null;
    let realizados = [];
    let realizadosFiltroActivos = true;
    let realizadosChannel = null;
    let realizadosPage = 1;
    let realizadosSearch = "";
    const REALIZADOS_PAGE_SIZE = 25;
    let vuelos = [];
    let vuelosLoading = false;
    let resumenDirecciones = []; // en vivo, desde resumen_direcciones_actual
    let direccionVehiculos = []; // en vivo, desde direccion_vehiculo_actual (una fila por bus)
    let puntosAhora = []; // en vivo, desde puntos_ahora: la cuenta del programa por punto (vienen / están)
    let puntosIntentado = false; // ya se pidió puntos_ahora una vez (antes, los contadores no muestran el respaldo)
    let internosFlota = {}; // mid -> interno de los 51 buses (enturne_flota), para el filtro del mapa
    let sumasDirecciones = null; // { subiendo, bajando } de resumen_direcciones_actual: respaldo de los contadores
    let turnos = []; // programación de HOY, desde programacion_turnos
    let turnosLoading = false;
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
            }, 50);
        }
        // Cargar despachos cuando se entra a esa pestaña (si no se ha cargado todavía)
        if (name === "despachos" && !despachos.length && !despachosLoading) {
            cargarDespachos();
        }
        if (name === "realizados") {
            cargarRealizados();
        }
        if (name === "vuelos" && !vuelos.length && !vuelosLoading) {
            cargarVuelos();
        }
        if (name === "subida") {
            if (!realizados.length) cargarRealizados();
            if (!resumenDirecciones.length) cargarResumenDirecciones();
        }
        if (name === "mapa") {
            cargarPuntos();
            if (!resumenDirecciones.length) cargarResumenDirecciones();
            if (!direccionVehiculos.length) cargarDireccionVehiculos();
        }
        if (name === "turnos" && !turnos.length && !turnosLoading) {
            cargarTurnos();
        }
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ============== Mapa ==============
    function initMap() {
        // El zoom va abajo a la derecha: en su sitio de siempre (arriba a la
        // izquierda) tapaba el contador "En fila" de la franja de arriba.
        map = L.map("map", { zoomControl: false }).setView(
            [cfg.MAP_CENTER.lat, cfg.MAP_CENTER.lng],
            cfg.MAP_ZOOM
        );
        L.control.zoom({ position: "bottomright" }).addTo(map);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        markersLayer = L.layerGroup().addTo(map);
        dibujarGeocercas();
    }

    function initMapaControles() {
        const buscar = document.getElementById("mapaBuscarBus");
        if (buscar) {
            buscar.addEventListener("input", function () {
                mapaBusqueda = buscar.value || "";
                renderMap();
                if (mapaBusqueda.trim()) ajustarVistaAFiltroDebounced();
            });
        }
        const filtro = document.getElementById("mapaFiltroEstado");
        if (filtro) {
            filtro.addEventListener("change", function () {
                mapaFiltroEstado = filtro.value || "todos";
                renderMap();
            });
        }
        function alternarFiltroZona(valor) {
            mapaFiltroZona = (mapaFiltroZona === valor) ? null : valor;
            document.querySelectorAll(".mini-stat--filtro").forEach(function (e) {
                e.classList.toggle("activo", e.getAttribute("data-filtro") === mapaFiltroZona);
            });
            renderMap();
            if (mapaFiltroZona) ajustarVistaAFiltro();
        }
        document.querySelectorAll(".mini-stat--filtro").forEach(function (el) {
            el.addEventListener("click", function () {
                alternarFiltroZona(el.getAttribute("data-filtro"));
            });
            el.addEventListener("keydown", function (ev) {
                if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    alternarFiltroZona(el.getAttribute("data-filtro"));
                }
            });
        });
    }

    // Dibuja las geocercas configuradas como referencia visual. Solo
    // informativas: la evaluación de entradas/salidas la hace el backend
    // (despachosautomaticos), esta web pública no la recalcula.
    function dibujarGeocercas() {
        const viejas = L.layerGroup();
        (cfg.GEOCERCAS || []).forEach(function (g) {
            if (!Array.isArray(g.puntos) || !g.puntos.length) return;
            L.polygon(g.puntos, {
                color: g.color,
                weight: 2,
                dashArray: "6 4",
                fillColor: g.color,
                fillOpacity: 0.08,
            }).bindPopup(g.etiqueta || g.nombre).addTo(viejas);
        });
        viejas.addTo(map);

        // El mapa del programa de enturnes, con su misma forma de
        // mostrar las cosas. Por cada punto de llegada van tres capas:
        //
        //   1. la RAYA de llegada (o el circulo, donde no hay raya): lo que el bus
        //      tiene que cruzar para entrar a la fila;
        //   2. el circulo de espera: si se aleja de ahi mas de 30 min, pierde el turno;
        //   3. una ETIQUETA con el nombre, del color del punto.
        //
        // La etiqueta es lo importante para poder verlo: las zonas son chiquitas
        // (Patio Azul mide 119 metros) y alejado el mapa no se ven, pero la etiqueta
        // se ve siempre, a cualquier acercamiento.
        const nuevas = L.layerGroup();

        (cfg.PUNTOS_ENTURNES || []).forEach(function (p) {
            // El circulo de espera, punteado y casi transparente: es referencia, no estorbo.
            L.circle([p.lat, p.lon], {
                radius: p.zona_m, color: p.color, weight: 1,
                dashArray: "6 6", fillOpacity: 0.03,
            }).bindTooltip("Zona de espera de " + escapeHtml(p.nombre) + " · " + p.zona_m + " m")
              .addTo(nuevas);

            // La raya de llegada, gruesa: es la que decide.
            if (Array.isArray(p.linea) && p.linea.length === 2) {
                L.polyline(p.linea, { color: p.color, weight: 8, opacity: 0.9 })
                    .bindTooltip("Raya de llegada de " + escapeHtml(p.nombre))
                    .addTo(nuevas);
            } else if (p.radio_m) {
                L.circle([p.lat, p.lon], {
                    radius: p.radio_m, color: p.color, weight: 3, fillOpacity: 0.15,
                }).bindTooltip("Llegada a " + escapeHtml(p.nombre)).addTo(nuevas);
            }

            // La etiqueta con el nombre.
            L.marker([p.lat, p.lon], {
                interactive: false,
                icon: L.divIcon({
                    className: "etiqueta-punto",
                    html: '<span style="background:' + p.color + '">' + escapeHtml(p.nombre) + "</span>",
                    iconSize: null,
                }),
            }).addTo(nuevas);
        });

        // Las zonas dibujadas a mano, del color de su punto.
        (cfg.ZONAS_ENTURNES || []).forEach(function (z) {
            if (!Array.isArray(z.puntos) || !z.puntos.length) return;
            L.polygon(z.puntos, {
                color: z.color, weight: 3, fillColor: z.color, fillOpacity: 0.14,
            }).bindPopup("<strong>" + escapeHtml(z.nombre) + "</strong><br>Zona dibujada de " +
                         escapeHtml(z.punto || "")).addTo(nuevas);
        });

        if ((cfg.PUNTOS_ENTURNES || []).length || (cfg.ZONAS_ENTURNES || []).length) {
            nuevas.addTo(map);
            // Abajo a la izquierda: arriba a la derecha tapaba el buscador de buses.
            L.control.layers(null, {
                "Puntos y zonas del programa": nuevas,
                "Geocercas de antes": viejas,
            }, { collapsed: false, position: "bottomleft" }).addTo(map);
        }
    }

    // Ray-casting: true si [lat,lon] está dentro de poligono (array de [lat,lng]).
    // Mismo algoritmo que usa el backend (app/utils/geo.py::punto_en_poligono).
    function puntoEnPoligono(lat, lon, poligono) {
        let dentro = false;
        for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
            const yi = poligono[i][0], xi = poligono[i][1];
            const yj = poligono[j][0], xj = poligono[j][1];
            const intersecta = ((yi > lat) !== (yj > lat)) &&
                (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi);
            if (intersecta) dentro = !dentro;
        }
        return dentro;
    }

    // Cuenta buses (en fila + resto de la flota, sin duplicar) dentro de la
    // geocerca "patio azul" -- refleja la presencia real, sin importar el
    // buscador/filtro de estado que solo afecta lo dibujado en el mapa.
    function contarEnPatioAzul() {
        const patioAzul = (cfg.GEOCERCAS || []).find(function (g) { return g.nombre === "patio azul"; });
        if (!patioAzul || !Array.isArray(patioAzul.puntos)) return null;

        const posicionesPorMid = mapaPosicionesPorMid();
        const idsEnFila = new Set(rows.map(function (r) { return r.vehicle_id; }));
        const vistos = new Set();
        let contador = 0;

        rows.forEach(function (row) {
            if (vistos.has(row.vehicle_id)) return;
            vistos.add(row.vehicle_id);
            const fresca = posicionesPorMid[row.vehicle_id];
            const lat = fresca ? Number(fresca.lat) : Number(row.lat);
            const lon = fresca ? Number(fresca.lon) : Number(row.lon);
            if (isFinite(lat) && isFinite(lon) && puntoEnPoligono(lat, lon, patioAzul.puntos)) contador++;
        });

        posiciones.forEach(function (p) {
            if (!p.mid || idsEnFila.has(p.mid) || vistos.has(p.mid)) return;
            vistos.add(p.mid);
            const lat = Number(p.lat), lon = Number(p.lon);
            if (isFinite(lat) && isFinite(lon) && puntoEnPoligono(lat, lon, patioAzul.puntos)) contador++;
        });

        return contador;
    }

    // Flecha que indica el sentido de marcha real (rumbo GPS 0-360°, tal como
    // lo reporta sonar_posiciones.course) -- solo se muestra si el bus está
    // en movimiento, porque parado el rumbo del GPS deja de ser confiable.
    function direccionArrowHtml(course, speed, modificador) {
        const mov = estadoMovimiento(speed);
        const grados = Number(course);
        if (!mov || mov.cls !== "activo" || !isFinite(grados)) return "";
        return `<div class="marker-arrow ${modificador}" style="transform:rotate(${grados}deg)"></div>`;
    }

    function busMarkerIcon(row) {
        const label = escapeHtml(String(row.interno || row.vehicle_id || ""));
        const flecha = direccionArrowHtml(row._course, row._speed, "marker-arrow--fila");
        return L.divIcon({
            className: "",
            html: `<div class="marker-shell"><div class="bus-marker">${label}</div>${flecha}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
        });
    }

    function fleetDotIcon(label, course, speed) {
        const flecha = direccionArrowHtml(course, speed, "marker-arrow--flota");
        return L.divIcon({
            className: "",
            html: `<div class="marker-shell"><div class="fleet-marker">${escapeHtml(String(label || ""))}</div>${flecha}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        });
    }

    // Actualiza un marcador existente en vez de destruirlo y recrearlo (evita
    // el parpadeo de todo el mapa en cada refresco de posiciones/turnos).
    function upsertMarker(store, key, lat, lon, icon, popupContent, zIndexOffset) {
        let marker = store[key];
        if (marker) {
            marker.setLatLng([lat, lon]);
            marker.setIcon(icon);
            marker.setPopupContent(popupContent);
        } else {
            marker = L.marker([lat, lon], { icon: icon, zIndexOffset: zIndexOffset || 0 });
            marker.bindPopup(popupContent);
            marker.addTo(markersLayer);
            store[key] = marker;
        }
        return marker;
    }

    function removeMarkersNotIn(store, idsVigentes) {
        Object.keys(store).forEach(function (key) {
            if (!idsVigentes.has(key)) {
                markersLayer.removeLayer(store[key]);
                delete store[key];
            }
        });
    }

    // Umbral de velocidad (km/h) para considerar un bus "andando" -- por debajo
    // se toma como ruido de GPS de un bus parado, no movimiento real (mismo
    // umbral que ya usa la app de escritorio).
    const VELOCIDAD_MOVIMIENTO_KMH = 3;

    // Qué valor de "direccion" (resumen_direcciones_actual y
    // direccion_vehiculo_actual) es SUBIENDO y cuál BAJANDO, como se dice en la
    // operación: subir es ir hacia Medellín. Ojo, es al revés de lo que sugiere
    // el nombre del valor. Contadores, filtro del mapa y resumen leen de aquí.
    const DIRECCION_SUBIENDO = "aeropuerto_medellin";
    const DIRECCION_BAJANDO = "medellin_aeropuerto";

    // La cuenta del programa (puntos_ahora): cada 30 s publica, por punto, cuántos
    // buses vienen por la carretera y cuántos están en él (y en qué zona). Aquí subir
    // es ir hacia Medellín: los que vienen a un punto de abajo (Almacentro, Nutibara,
    // Exposiciones, Terminal Norte) van SUBIENDO y los que vienen al Aeropuerto van
    // BAJANDO. Si el dato tiene más de cfg.PUNTOS_VIEJO_SEG (el programa no está
    // publicando), devuelve null y los contadores vuelven a la cuenta de antes.
    const ZONA_PATIO = "Patio Azul";
    function cuentaDelPrograma() {
        if (!puntosAhora.length) return null;
        const foto = puntosAhora.reduce(function (max, r) {
            return r.foto_en && r.foto_en > max ? r.foto_en : max;
        }, "");
        const edadSeg = foto ? (Date.now() - new Date(foto).getTime()) / 1000 : Infinity;
        if (!(edadSeg <= (cfg.PUNTOS_VIEJO_SEG || 180))) return null;
        const c = {
            foto: foto, patio: 0, subiendo: 0, bajando: 0,
            sinArrancarSubiendo: 0, sinArrancarBajando: 0,
            detalleSubiendo: [], restoAeropuerto: [],
            internosPatio: new Set(), internosSubiendo: new Set(), internosBajando: new Set(),
        };
        puntosAhora.forEach(function (r) {
            const buses = r.buses || {};
            if (r.sentido === "sube") {          // vienen al Aeropuerto: BAJANDO
                c.bajando += r.vienen || 0;
                c.sinArrancarBajando += r.vienen_sin_arrancar || 0;
                (buses.vienen || []).forEach(function (b) { c.internosBajando.add(String(b.interno)); });
                const zonas = r.por_zona || {};
                c.patio = zonas[ZONA_PATIO] || 0;
                (buses.estan || []).forEach(function (b) {
                    if (b.zona === ZONA_PATIO) c.internosPatio.add(String(b.interno));
                });
                Object.keys(zonas).forEach(function (z) {
                    if (z !== ZONA_PATIO && zonas[z]) c.restoAeropuerto.push(z + " " + zonas[z]);
                });
            } else if (r.sentido === "baja") {   // vienen a un punto de abajo: SUBIENDO
                c.subiendo += r.vienen || 0;
                c.sinArrancarSubiendo += r.vienen_sin_arrancar || 0;
                if (r.vienen) c.detalleSubiendo.push(r.punto + " " + r.vienen);
                (buses.vienen || []).forEach(function (b) { c.internosSubiendo.add(String(b.interno)); });
            }
        });
        return c;
    }

    // Los tres contadores del mapa que dependen de la cuenta del programa. El número de
    // "En fila" no cambia: sigue saliendo de la fila del aeropuerto (updateStats).
    function actualizarMiniStats() {
        const patio = document.getElementById("miniPatioAzul");
        const sube = document.getElementById("miniSubiendo");
        const baja = document.getElementById("miniBajando");
        const c = cuentaDelPrograma();
        if (c) {
            const dato = "Dato del programa de las " + formatHora(c.foto);
            const ademas = function (n) {
                return n ? ` · además ${n} despachado${n === 1 ? "" : "s"} que todavía no arranca${n === 1 ? "" : "n"} de otro punto` : "";
            };
            if (patio) {
                patio.textContent = String(c.patio);
                patio.parentElement.title = `En Patio Azul ahora: ${c.patio}` +
                    (c.restoAeropuerto.length ? ` · en el resto del aeropuerto: ${c.restoAeropuerto.join(", ")}` : "") +
                    `. ${dato}.`;
            }
            if (sube) {
                sube.textContent = String(c.subiendo);
                sube.parentElement.title = "Por la carretera hacia Medellín: " +
                    (c.detalleSubiendo.length ? c.detalleSubiendo.join(" · ") : "ninguno") +
                    ademas(c.sinArrancarSubiendo) + `. ${dato}.`;
            }
            if (baja) {
                baja.textContent = String(c.bajando);
                baja.parentElement.title = `Por la carretera hacia el aeropuerto: ${c.bajando}` +
                    ademas(c.sinArrancarBajando) + `. ${dato}.`;
            }
            return;
        }
        // Mientras llega la primera respuesta, nada: si no, al abrir se vería un instante la cuenta vieja.
        if (!puntosIntentado) return;
        // Respaldo: el programa no ha publicado en los últimos minutos.
        const respaldo = "Cuenta de respaldo: el programa no ha publicado en los últimos " +
            Math.round((cfg.PUNTOS_VIEJO_SEG || 180) / 60) + " minutos.";
        if (patio) {
            const enPatioAzul = contarEnPatioAzul();
            patio.textContent = enPatioAzul == null ? "—" : String(enPatioAzul);
            patio.parentElement.title = respaldo;
        }
        if (sube) {
            sube.textContent = sumasDirecciones ? String(sumasDirecciones.subiendo) : "—";
            sube.parentElement.title = respaldo;
        }
        if (baja) {
            baja.textContent = sumasDirecciones ? String(sumasDirecciones.bajando) : "—";
            baja.parentElement.title = respaldo;
        }
    }

    function mapaPosicionesPorMid() {
        const mapa = {};
        posiciones.forEach(function (p) {
            if (p && p.mid) mapa[p.mid] = p;
        });
        return mapa;
    }

    function estadoMovimiento(speed) {
        const v = Number(speed);
        if (!isFinite(v)) return null;
        return v > VELOCIDAD_MOVIMIENTO_KMH
            ? { txt: "Andando", cls: "activo" }
            : { txt: "Detenido", cls: "cancelado" };
    }

    // Filtros del mapa (buscador de texto + estado andando/detenido). Solo
    // afectan qué se dibuja en el mapa -- los contadores de otras pestañas
    // siguen mostrando el total real, sin filtrar.
    function coincideBusquedaMapa(valores) {
        const q = mapaBusqueda.trim().toLowerCase();
        if (!q) return true;
        return valores.some(function (v) { return v != null && String(v).toLowerCase().includes(q); });
    }

    function pasaFiltroEstadoMapa(speed) {
        if (mapaFiltroEstado === "todos") return true;
        const mov = estadoMovimiento(speed);
        if (!mov) return false; // sin dato de velocidad: no entra en ningún filtro específico
        return mapaFiltroEstado === "andando" ? mov.cls === "activo" : mov.cls === "cancelado";
    }

    function renderMap() {
        if (!map) return;

        const posicionesPorMid = mapaPosicionesPorMid();
        const idsEnFila = new Set(rows.map(function (r) { return r.vehicle_id; }));
        // vehiculossonar es la fuente "correcta" pero hoy está vacía; despachos_realizados
        // ya tiene el mismo mapeo mid->interno cubriendo toda la flota, así que se usa
        // como respaldo (y vehiculossonar manda si algún día se llena).
        // enturne_flota (los 51 buses del programa) va en medio: tiene a todos, también a
        // los que no han tenido despacho hoy.
        const internoPorMid = {};
        realizados.forEach(function (r) { if (r.vehicle_id && r.interno) internoPorMid[r.vehicle_id] = r.interno; });
        Object.keys(internosFlota).forEach(function (mid) { internoPorMid[mid] = internosFlota[mid]; });
        vehiculos.forEach(function (v) { if (v.mid && v.interno) internoPorMid[v.mid] = v.interno; });

        // Filtro por click en un mini-stat (patio azul / subiendo / bajando). Muestra
        // justo los buses que cuenta el programa en ese contador (puntos_ahora). Si el
        // programa no está publicando, se filtra como antes: la dirección de
        // direccion_vehiculo_actual (running=Y en Sonar) y el Patio Azul dibujado.
        const cuenta = cuentaDelPrograma();
        const direccionPorMid = direccionVehiculosPorMid();
        const patioAzulPuntos = ((cfg.GEOCERCAS || []).find(function (g) { return g.nombre === "patio azul"; }) || {}).puntos;
        function pasaFiltroZonaMapa(mid, lat, lon, interno) {
            if (!mapaFiltroZona) return true;
            if (cuenta) {
                const lista = mapaFiltroZona === "patio_azul" ? cuenta.internosPatio
                    : mapaFiltroZona === "subiendo" ? cuenta.internosSubiendo : cuenta.internosBajando;
                return interno != null && lista.has(String(interno));
            }
            if (mapaFiltroZona === "patio_azul") {
                return Array.isArray(patioAzulPuntos) && puntoEnPoligono(lat, lon, patioAzulPuntos);
            }
            const dir = direccionPorMid[mid];
            if (!dir) return false;
            return mapaFiltroZona === "subiendo" ? dir === DIRECCION_SUBIENDO : dir === DIRECCION_BAJANDO;
        }

        // Resto de la flota (de fondo, con zIndex negativo para quedar
        // siempre debajo de los buses en fila).
        const idsFlota = new Set();
        posiciones.forEach(function (p) {
            if (!p.mid || idsEnFila.has(p.mid)) return;
            const lat = Number(p.lat), lon = Number(p.lon);
            if (!isFinite(lat) || !isFinite(lon)) return;
            const interno = internoPorMid[p.mid];
            if (!coincideBusquedaMapa([interno, p.plate, p.mid])) return;
            if (!pasaFiltroEstadoMapa(p.speed)) return;
            if (!pasaFiltroZonaMapa(p.mid, lat, lon, interno)) return;
            idsFlota.add(p.mid);
            const label = interno || p.plate || p.mid;
            upsertMarker(markersFlotaByMid, p.mid, lat, lon, fleetDotIcon(label, p.course, p.speed), fleetPopupHtml(p, interno), -1000);
        });
        removeMarkersNotIn(markersFlotaByMid, idsFlota);

        // Buses en fila: se usa la posición más fresca de sonar_posiciones
        // cuando está disponible; si no, la que ya trae enturnamiento_actual.
        const idsFila = new Set();
        rows.forEach(function (row) {
            const fresca = posicionesPorMid[row.vehicle_id];
            row._speed = fresca ? fresca.speed : null;
            row._course = fresca ? fresca.course : null;
            if (!coincideBusquedaMapa([row.interno, row.vehicle_id, fresca ? fresca.plate : null])) return;
            if (!pasaFiltroEstadoMapa(row._speed)) return;
            let lat = fresca ? Number(fresca.lat) : Number(row.lat);
            let lon = fresca ? Number(fresca.lon) : Number(row.lon);
            if (!isFinite(lat) || !isFinite(lon)) {
                lat = Number(row.lat);
                lon = Number(row.lon);
            }
            if (!isFinite(lat) || !isFinite(lon)) return;
            if (!pasaFiltroZonaMapa(row.vehicle_id, lat, lon, row.interno || internoPorMid[row.vehicle_id])) return;
            idsFila.add(row.vehicle_id);
            upsertMarker(markersByVehicleId, row.vehicle_id, lat, lon, busMarkerIcon(row), popupHtml(row), 0);
        });
        removeMarkersNotIn(markersByVehicleId, idsFila);

        actualizarMiniStats();
    }

    // Centra/hace zoom sobre los marcadores visibles ahora mismo (después de
    // aplicar buscador y/o filtro de zona) -- se llama solo desde acciones del
    // usuario (buscar, click en un mini-stat), nunca desde el refresco
    // periódico, para no mover el mapa mientras el usuario lo está mirando.
    function ajustarVistaAFiltro() {
        if (!map) return;
        const puntos = Object.values(markersByVehicleId)
            .concat(Object.values(markersFlotaByMid))
            .map(function (m) { return m.getLatLng(); });
        if (!puntos.length) return;
        if (puntos.length === 1) {
            map.setView(puntos[0], Math.max(map.getZoom(), 16));
        } else {
            map.fitBounds(L.latLngBounds(puntos), { padding: [40, 40], maxZoom: 16 });
        }
    }

    let mapaFitTimer = null;
    function ajustarVistaAFiltroDebounced() {
        if (mapaFitTimer) clearTimeout(mapaFitTimer);
        mapaFitTimer = setTimeout(ajustarVistaAFiltro, 400);
    }

    function popupHtml(row) {
        const hace = humanizeAge(row.llegada_aeropuerto);
        const mov = estadoMovimiento(row._speed);
        return `
            <div style="font-size:13px;min-width:180px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                <div style="font-weight:900;color:#2b33ff;font-size:16px;margin-bottom:6px;">
                    Bus ${escapeHtml(row.interno || row.vehicle_id || "")}
                </div>
                <div style="margin-bottom:4px;"><b>${escapeHtml(row.itinerario || "")}</b></div>
                <div style="margin-bottom:4px;">Posición: <b>#${row._posGrupo ?? "-"}</b></div>
                <div style="margin-bottom:4px;">Llegada: <b>${escapeHtml(formatHora(row.llegada_aeropuerto))}</b></div>
                ${mov ? `<div style="margin-bottom:4px;"><span class="estado-pill ${mov.cls}">${mov.txt}</span></div>` : ""}
                <div style="color:#6b7280;font-size:12px;">${escapeHtml(hace)}</div>
            </div>
        `;
    }

    function fleetPopupHtml(p, interno) {
        const hace = humanizeAge(p.updated_at);
        const velocidad = (typeof p.speed === "number") ? `${p.speed} km/h` : "—";
        const mov = estadoMovimiento(p.speed);
        const titulo = interno ? `Bus ${interno}` : (p.plate || p.mid || "");
        return `
            <div style="font-size:13px;min-width:170px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                <div style="font-weight:900;color:#4f46e5;font-size:15px;margin-bottom:2px;">
                    ${escapeHtml(titulo)}
                </div>
                ${interno && p.plate ? `<div style="margin-bottom:4px;color:#6b7280;font-size:12px;">${escapeHtml(p.plate)}</div>` : ""}
                <div style="margin-bottom:4px;">Velocidad: <b>${escapeHtml(velocidad)}</b> ${mov ? `<span class="estado-pill ${mov.cls}">${mov.txt}</span>` : ""}</div>
                <div style="margin-bottom:4px;">${escapeHtml(p.address || "")}</div>
                <div style="color:#6b7280;font-size:12px;">${escapeHtml(hace)}</div>
            </div>
        `;
    }

    // ============== Stats ==============
    function updateStats() {
        const total = rows.length;
        document.getElementById("statTotal").textContent = String(total);
        document.getElementById("miniTotal").textContent = String(total);
        document.getElementById("tabListasBadge").textContent = String(total);
    }

    // ============== Tabla y chips ==============
    function renderChipsAndTable() {
        const posicionesPorMid = mapaPosicionesPorMid();
        const grupos = {};
        rows.forEach(function (r) {
            const k = r.itinerario || "Sin itinerario";
            (grupos[k] = grupos[k] || []).push(r);
        });
        Object.values(grupos).forEach(function (arr) {
            // "turno" es el orden FIFO global (por hora real de llegada al
            // aeropuerto, con corroboración GPS); acá solo reordenamos cada
            // grupo por ese mismo criterio y numeramos 1..N DENTRO del grupo
            // (misma posición "por itinerario" que mostraba esta tabla antes).
            arr.sort(function (a, b) {
                return (a.turno || 9999) - (b.turno || 9999);
            });
            arr.forEach(function (r, idx) { r._posGrupo = idx + 1; });
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
                const hace = humanizeAge(r.llegada_aeropuerto);
                const fresca = posicionesPorMid[r.vehicle_id];
                const mov = estadoMovimiento(fresca ? fresca.speed : null);
                const puesto = puestoPorInterno(r.interno);
                return `
                    <tr class="bus-row" data-vehicle-id="${escapeHtml(r.vehicle_id || "")}" tabindex="0" role="button" aria-label="Asignar itinerario al bus ${escapeHtml(r.interno || "")}">
                        <td class="pos">${r._posGrupo ?? "-"}</td>
                        <td class="hora">${escapeHtml(formatHora(r.llegada_aeropuerto))}</td>
                        <td class="hace">${escapeHtml(hace)}</td>
                        <td class="interno">${escapeHtml(r.interno || "")}</td>
                        <td>${escapeHtml(puesto || "—")}</td>
                        <td class="col-estado">
                            ${mov ? `<span class="estado-pill ${mov.cls}">${mov.txt}</span>` : '<span class="estado-vacio">—</span>'}
                            <button type="button" class="btn-icon-hide" data-action="ocultar"
                                data-vehicle-id="${escapeHtml(r.vehicle_id || "")}"
                                data-interno="${escapeHtml(r.interno || "")}"
                                data-llegada="${escapeHtml(r.llegada_aeropuerto || "")}"
                                title="Ocultar de la lista" aria-label="Ocultar bus ${escapeHtml(r.interno || "")} de la lista">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <path d="M3 3l18 18M10.58 10.58a2 2 0 002.83 2.83M9.88 4.6A9.77 9.77 0 0112 4.5c5 0 9 4.5 9 7.5a10.6 10.6 0 01-2.16 3.19M6.1 6.1C3.87 7.66 2 9.86 2 12c0 3 4 7.5 9 7.5 1.09 0 2.13-.2 3.09-.56"
                                        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </td>
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
                                <th>Puesto</th>
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

        // Ocultar de la lista: para casos donde Sonar todavía no refleja que el
        // bus ya no está esperando turno (ej. está andando lejos, sin GPS en el
        // aeropuerto, sin despacho nuevo). No cancela ni despacha nada -- solo
        // oculta ESE arribo puntual (vehicle_id + llegada_aeropuerto), así que
        // si el mismo bus vuelve a llegar de verdad más tarde, sí aparece.
        tablaBox.querySelectorAll('[data-action="ocultar"]').forEach(function (btn) {
            btn.addEventListener("click", async function (ev) {
                ev.stopPropagation();
                const vid = btn.getAttribute("data-vehicle-id");
                const interno = btn.getAttribute("data-interno");
                const llegada = btn.getAttribute("data-llegada");
                if (!vid) return;
                const ok = await mostrarConfirmacion({
                    titulo: "Ocultar de la lista",
                    mensaje: "Esto solo lo quita de esta lista de espera -- no cancela ni despacha nada en Sonar. Si el bus vuelve a llegar de verdad, aparece de nuevo.",
                    detalle: `<div><strong>Bus:</strong> ${escapeHtml(interno || vid)}</div>`,
                    textoConfirmar: "Sí, ocultar",
                    textoCancelar: "Volver",
                    tipo: "warn",
                });
                if (!ok) return;

                btn.disabled = true;
                try {
                    const idOculto = claveOculto(vid, llegada);
                    const { error } = await client.from(cfg.TABLA_ENTURNAMIENTO_OCULTOS).upsert({
                        id: idOculto,
                        vehicle_id: vid,
                        interno: interno || null,
                        llegada_aeropuerto: llegada || null,
                        oculto_por: currentUser?.email || "unknown",
                    });
                    if (error) throw error;
                    ocultos.add(idOculto);
                    showToast("ok", "Bus ocultado de la lista");
                    cargarInicial();
                } catch (err) {
                    showToast("err", "Error: " + (err.message || err));
                    btn.disabled = false;
                }
            });
        });
    }

    // ============== Línea de turno (animada) ==============
    // Franja horizontal con el orden FIFO real (global, no por itinerario).
    // Reutiliza el mismo elemento DOM por bus entre renders y usa la técnica
    // FLIP para animar el reacomodo cuando cambia el orden, en vez de
    // redibujar todo de golpe.
    function renderTurnoLine() {
        const wrap = document.getElementById("turnoLine");
        if (!wrap) return;

        const ordenados = rows.slice().sort(function (a, b) {
            return (a.turno || 9999) - (b.turno || 9999);
        });

        const antes = {};
        Object.keys(turnoStopEls).forEach(function (vid) {
            antes[vid] = turnoStopEls[vid].getBoundingClientRect().left;
        });

        const idsNuevos = new Set(ordenados.map(function (r) { return r.vehicle_id; }));
        Object.keys(turnoStopEls).forEach(function (vid) {
            if (!idsNuevos.has(vid)) {
                turnoStopEls[vid].remove();
                delete turnoStopEls[vid];
            }
        });

        if (!ordenados.length) {
            wrap.innerHTML = '<div class="turno-empty">Sin buses en fila</div>';
            turnoStopEls = {};
            return;
        }
        if (wrap.querySelector(".turno-empty")) wrap.innerHTML = "";

        ordenados.forEach(function (row, idx) {
            const vid = row.vehicle_id;
            let el = turnoStopEls[vid];
            if (!el) {
                el = document.createElement("div");
                el.className = "turno-stop";
                el.innerHTML =
                    '<span class="turno-tag"></span>' +
                    '<span class="turno-badge"></span>' +
                    '<span class="turno-wait"></span>';
                el.addEventListener("click", function () {
                    const actual = rows.find(function (r) { return r.vehicle_id === vid; });
                    if (actual) openAssignModal(actual);
                });
                turnoStopEls[vid] = el;
            }
            el.classList.toggle("next", idx === 0);
            el.querySelector(".turno-tag").textContent = idx === 0 ? "Próximo" : "";
            el.querySelector(".turno-badge").textContent = row.interno || vid;
            el.querySelector(".turno-wait").textContent = humanizeAge(row.llegada_aeropuerto);
            el.title = row.itinerario || "";
            wrap.appendChild(el); // reinserta en el orden correcto (mueve si ya estaba)
        });

        // FLIP: aplicar la posición anterior como transform y soltarla para
        // que el navegador anime el desplazamiento al lugar nuevo.
        requestAnimationFrame(function () {
            Object.keys(turnoStopEls).forEach(function (vid) {
                const el = turnoStopEls[vid];
                const anteriorLeft = antes[vid];
                if (anteriorLeft == null) return; // elemento nuevo, sin animación de movimiento
                const nuevoLeft = el.getBoundingClientRect().left;
                const delta = anteriorLeft - nuevoLeft;
                if (Math.abs(delta) < 1) return;
                el.style.transition = "none";
                el.style.transform = `translateX(${delta}px)`;
                requestAnimationFrame(function () {
                    el.style.transition = "";
                    el.style.transform = "";
                });
            });
        });
    }

    // ============== Modal asignar itinerario ==============

    // El conductor del despacho.
    //
    // El número que trae la fila (driver_id) es el ID del conductor EN SONAR,
    // no la cédula, aunque se le parezca: el 735 sale con 61254297 y ese es el
    // ID. Con la lista de conductores se traduce a nombre, para que el
    // despachador vea a quién está despachando y no un número pelado.
    function conductorPorDrId(drId) {
        const d = String(drId == null ? "" : drId).trim();
        if (!d) return null;
        return conductores.find(function (c) {
            return String(c.dr_id || "").trim() === d;
        }) || null;
    }

    function openAssignModal(row) {
        const modal = document.getElementById("assignModal");
        document.getElementById("assignBus").textContent = row.interno || row.vehicle_id || "—";

        // --- Conductor -------------------------------------------------
        // El número que trae la fila (driver_id) es el ID del conductor EN
        // SONAR, no la cédula, aunque se le parezca: el 735 sale con 61254297
        // y ese es el ID. Con la hoja de conductores se traduce a nombre, para
        // que el despachador vea a quién despacha y no un número pelado.
        //
        // Si Sonar no sabe quién va manejando (el conductor no se conectó en
        // el equipo del bus), desde aquí NO se despacha: se manda al despacho
        // manual, que es donde se escoge el conductor a mano.
        // Ojo con el "0": Sonar dice 0 cuando nadie se conectó. Nuestra fila ya
        // lo deja vacío, pero el 0 es justo lo que se coló 116 veces en los
        // despachos por la tabla vieja, donde sí llegaba como texto "0".
        let drvFila = String(row.driver_id || "").trim();
        if (drvFila === "0") drvFila = "";
        const quien = conductorPorDrId(drvFila);
        const estatico = document.getElementById("assignDriver");
        const sinConductor = document.getElementById("assignSinConductor");
        const botonAsignar = document.getElementById("assignSubmit");
        if (drvFila) {
            estatico.hidden = false;
            estatico.textContent = quien ? (quien.nombre + " · ID " + drvFila) : drvFila;
            sinConductor.hidden = true;
            botonAsignar.hidden = false;
        } else {
            estatico.hidden = true;
            sinConductor.hidden = false;
            botonAsignar.hidden = true;   // sin conductor no hay nada que asignar
        }
        // El botón de abajo necesita saber de qué bus se trata.
        document.getElementById("assignIrManual").dataset.interno =
            String(row.interno || "");

        const select = document.getElementById("assignItin");
        const EXCLUIDOS = ["4413", "3385"]; // Aeropuerto-Exposiciones, Aeropuerto-San Diego-Tunel
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
        document.getElementById("assignSubmit").dataset.driverId = drvFila;
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
        const drvId = String(submitBtn.dataset.driverId || "").trim();
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
            errorBox.textContent = "Este bus no trae conductor. Use Despacho manual.";
            errorBox.hidden = false;
            return;
        }

        // Datos del bus seleccionado (para guardar en despachos_realizados)
        const row = rows.find(function (r) { return r.vehicle_id === mId; });
        const itinObj = (cfg.ITINERARIOS || []).find(function (i) { return i.id === itinerary; });

        // Confirmación previa al envío a Sonar
        const resuelto = conductorPorDrId(drvId);
        const driverNombre = resuelto
            ? (resuelto.nombre + " · ID " + drvId)
            : (document.getElementById("assignDriver")?.textContent || drvId || "—");
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

        // Botón "Ir a despacho manual": cierra este modal y abre el otro ya
        // con el bus puesto, para no volver a escribirlo. Los dos ofrecen los
        // mismos tres itinerarios del aeropuerto, así que no se pierde nada.
        const irManual = document.getElementById("assignIrManual");
        if (irManual) {
            irManual.addEventListener("click", async function () {
                const interno = irManual.dataset.interno || "";
                closeAssignModal();
                const tareas = [];
                if (!vehiculos.length) tareas.push(cargarVehiculos());
                if (!conductores.length) tareas.push(cargarConductores());
                if (tareas.length) await Promise.all(tareas);
                abrirManualModal();
                if (interno) {
                    document.getElementById("manualInterno").value = interno;
                    actualizarCamposVehiculo();
                    // El foco va al conductor, que es lo único que falta.
                    document.getElementById("manualConductor").focus();
                }
            });
        }
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
        return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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
        document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false });
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

    // ============== Vuelos (vuelos_mde) ==============
    function vueloTimestamp(v) {
        if (v.operation_time) {
            const t = new Date(v.operation_time).getTime();
            if (!isNaN(t)) return t;
        }
        if (v.fecha) {
            const hora = String(v.hora || "00:00").trim();
            const horaCompleta = hora.length === 5 ? hora + ":00" : hora;
            const t = new Date(`${v.fecha}T${horaCompleta}`).getTime();
            if (!isNaN(t)) return t;
        }
        return Infinity; // sin hora conocida: al final
    }

    function vueloHora(v) {
        const ts = vueloTimestamp(v);
        if (ts === Infinity) return v.hora || "—";
        return new Date(ts).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false });
    }

    // Códigos reales vistos en vuelos_mde.estado_code (más confiable que
    // matchear el texto de "estado", que trae tildes).
    const VUELO_ESTADO_CLASES = {
        OT: "listo",     // A tiempo
        LD: "listo",     // Aterrizó
        DP: "listo",     // Salió
        BD: "activo",    // Abordando
        ER: "activo",    // En ruta
        LC: "activo",    // Último llamado
        CL: "activo",    // Cerrado (gate cerrado, a punto de salir)
        DL: "espera",    // Demorado
        CN: "cancelado", // Cancelado
        PR: "cancelado", // Programado (gris neutro: todavía no hay novedad)
    };

    function vueloEstadoPill(v) {
        const code = String(v.estado_code || "").toUpperCase();
        const cls = VUELO_ESTADO_CLASES[code] || "cancelado";
        return { txt: v.estado || v.estado_code || "—", cls: cls };
    }

    // Ventana alrededor de "ahora": vuelos recién aterrizados (todavía relevantes
    // para el despacho de buses) hasta un par de horas adelante. Se recalcula en
    // cada carga, así que se va moviendo sola con el reloj.
    const VUELOS_VENTANA_ATRAS_MS = 60 * 60 * 1000; // 1h hacia atrás
    const VUELOS_VENTANA_ADELANTE_MS = 2 * 60 * 60 * 1000; // 2h hacia adelante

    function fechaLocalStr(d) {
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    async function cargarVuelos() {
        if (vuelosLoading) return;
        if (!navigator.onLine) {
            document.getElementById("vuelosBox").innerHTML =
                '<div class="loading">Sin conexión. Conéctate a internet para ver vuelos.</div>';
            return;
        }
        vuelosLoading = true;
        const box = document.getElementById("vuelosBox");
        const subtitle = document.getElementById("vuelosSubtitle");
        if (subtitle) subtitle.textContent = "Cargando...";
        try {
            const ahora = new Date();
            const desde = new Date(ahora.getTime() - VUELOS_VENTANA_ATRAS_MS);
            const hasta = new Date(ahora.getTime() + VUELOS_VENTANA_ADELANTE_MS);
            // La ventana puede cruzar la medianoche (ej. a las 11:30pm, "+2h" ya es
            // del día siguiente) -- se consultan todas las fechas que toca, no solo
            // la de hoy, para no perder vuelos ya cruzada la medianoche.
            const fechas = Array.from(new Set([fechaLocalStr(desde), fechaLocalStr(ahora), fechaLocalStr(hasta)]));
            const { data, error } = await client
                .from(cfg.TABLA_VUELOS)
                .select("*")
                .eq("tipo", "llegada")
                .in("fecha", fechas);
            if (error) throw error;
            // vuelos_mde es un log de eventos: cada cambio de estado de un vuelo
            // agrega una fila nueva (mismo "vuelo", distinto operation_time), no
            // una fila por vuelo. Nos quedamos solo con el estado más reciente de
            // cada vuelo para mostrar un tablero, no un historial.
            const masRecientePorVuelo = {};
            (data || []).forEach(function (v) {
                // La fecha va en la clave: un mismo número de vuelo se repite día a
                // día (confirmado en datos reales), y sin la fecha dos ocurrencias
                // distintas se mezclaban -- la de mañana (con operation_time más
                // futuro) le ganaba a la de hoy y la sacaba de la ventana visible.
                const clave = (v.vuelo || v.id) + "|" + (v.fecha || "");
                const actual = masRecientePorVuelo[clave];
                if (!actual || vueloTimestamp(v) > vueloTimestamp(actual)) {
                    masRecientePorVuelo[clave] = v;
                }
            });
            vuelos = Object.values(masRecientePorVuelo)
                .filter(function (v) {
                    const ts = vueloTimestamp(v);
                    return ts >= desde.getTime() && ts <= hasta.getTime();
                })
                .sort(function (a, b) { return vueloTimestamp(a) - vueloTimestamp(b); });
            renderVuelos();
        } catch (err) {
            console.error(err);
            box.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message || String(err))}</div>`;
            if (subtitle) subtitle.textContent = "Error al cargar";
        } finally {
            vuelosLoading = false;
        }
    }

    function renderVuelos() {
        const box = document.getElementById("vuelosBox");
        const subtitle = document.getElementById("vuelosSubtitle");
        const badge = document.getElementById("tabVuelosBadge");
        if (!box) return;

        if (badge) badge.textContent = String(vuelos.length);
        if (subtitle) subtitle.textContent = `${vuelos.length} vuelos · última hora y próximas 2 horas`;

        if (!vuelos.length) {
            box.innerHTML = '<div class="loading">No hay vuelos de llegada en este rango de horas</div>';
            return;
        }

        const filas = vuelos.map(function (v) {
            const estado = vueloEstadoPill(v);
            return `
                <tr>
                    <td class="hora">${escapeHtml(vueloHora(v))}</td>
                    <td class="interno">${escapeHtml(v.vuelo || "—")}</td>
                    <td>${escapeHtml(v.aerolinea || "—")}</td>
                    <td>${escapeHtml(v.ciudad || "—")}</td>
                    <td>${escapeHtml(v.puerta || "—")}</td>
                    <td><span class="estado-pill ${estado.cls}">${escapeHtml(estado.txt)}</span></td>
                </tr>
            `;
        }).join("");

        box.innerHTML = `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Vuelo</th>
                        <th>Aerolínea</th>
                        <th>Origen</th>
                        <th>Puerta</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;
    }

    // ============== Turnos (programacion_turnos, solo hoy) ==============
    function nombrePorDni(dni) {
        if (!dni) return "";
        const c = conductores.find(function (x) { return x.cedula && String(x.cedula) === String(dni); });
        return c ? c.nombre : "";
    }

    function formatHoraSimple(h) {
        if (!h) return "—";
        return String(h).slice(0, 5); // "HH:MM:SS" -> "HH:MM"
    }

    async function cargarTurnos() {
        if (turnosLoading) return;
        if (!navigator.onLine) {
            document.getElementById("turnosBox").innerHTML =
                '<div class="loading">Sin conexión. Conéctate a internet para ver los turnos.</div>';
            return;
        }
        turnosLoading = true;
        const box = document.getElementById("turnosBox");
        const subtitle = document.getElementById("turnosSubtitle");
        if (subtitle) subtitle.textContent = "Cargando...";
        try {
            if (!conductores.length) await cargarConductores();
            const hoy = fechaLocalStr(new Date());
            const { data, error } = await client
                .from(cfg.TABLA_PROGRAMACION_TURNOS)
                .select("*")
                .eq("fecha", hoy)
                .order("hora_entrada", { ascending: true, nullsFirst: false });
            if (error) throw error;
            turnos = data || [];
            renderTurnos();
            renderChipsAndTable(); // refresca la columna "Puesto" de Listas si ya estaba pintada
        } catch (err) {
            console.error(err);
            box.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message || String(err))}</div>`;
            if (subtitle) subtitle.textContent = "Error al cargar";
        } finally {
            turnosLoading = false;
        }
    }

    function puestoPorInterno(interno) {
        if (!interno) return "";
        const t = turnos.find(function (x) {
            return x.vehiculo && String(x.vehiculo).trim() === String(interno).trim();
        });
        return t ? (t.puesto || "") : "";
    }

    function renderTurnos() {
        const box = document.getElementById("turnosBox");
        const subtitle = document.getElementById("turnosSubtitle");
        const badge = document.getElementById("tabTurnosBadge");
        if (!box) return;

        if (badge) badge.textContent = String(turnos.length);
        if (subtitle) subtitle.textContent = `${turnos.length} turnos programados hoy`;

        if (!turnos.length) {
            box.innerHTML = '<div class="loading">No hay turnos programados para hoy</div>';
            return;
        }

        const filas = turnos.map(function (t) {
            const nombre = nombrePorDni(t.dni);
            return `
                <tr>
                    <td>${escapeHtml(t.turno != null ? String(t.turno) : "—")}</td>
                    <td class="hora">${escapeHtml(formatHoraSimple(t.hora_entrada))} – ${escapeHtml(formatHoraSimple(t.hora_salida))}</td>
                    <td>${escapeHtml(nombre || ("DNI " + (t.dni || "—")))}</td>
                    <td class="interno">${escapeHtml(t.vehiculo || "—")}</td>
                    <td>${escapeHtml(t.base || "—")}</td>
                    <td>${escapeHtml(t.puesto || "—")}</td>
                </tr>
            `;
        }).join("");

        box.innerHTML = `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Turno</th>
                        <th>Horario</th>
                        <th>Conductor</th>
                        <th>Vehículo</th>
                        <th>Base</th>
                        <th>Puesto</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;
    }

    function initTurnosControles() {
        const btn = document.getElementById("btnRefreshTurnos");
        if (btn) btn.addEventListener("click", cargarTurnos);
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
            renderSubida();
            renderMap();
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
                    <td>
                        <input type="text" class="observaciones-input"
                            value="${escapeHtml(r.observaciones || "")}"
                            placeholder="Sin observaciones"
                            maxlength="500"
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
                        <th>Observaciones</th>
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

        // Listeners para edición de observaciones (auto-save con debounce + en blur)
        box.querySelectorAll(".observaciones-input").forEach(function (input) {
            let t = null;
            async function guardar() {
                const id = input.dataset.id;
                const nuevo = (input.value || "").trim();
                const r = realizados.find(function (x) { return x.id === id; });
                if (r && (r.observaciones || "") === nuevo) return; // sin cambios reales
                input.classList.add("saving");
                try {
                    const { error } = await client
                        .from(cfg.TABLA_REALIZADOS)
                        .update({ observaciones: nuevo })
                        .eq("id", id);
                    if (error) throw error;
                    input.classList.remove("saving");
                    input.classList.add("saved");
                    setTimeout(function () { input.classList.remove("saved"); }, 1500);
                    if (r) r.observaciones = nuevo;
                } catch (err) {
                    input.classList.remove("saving");
                    showToast("err", "Error guardando observación: " + (err.message || err));
                }
            }
            // Auto-save 700ms después de dejar de escribir
            input.addEventListener("input", function () {
                clearTimeout(t);
                t = setTimeout(guardar, 700);
            });
            // Y al perder el foco, garantizado
            input.addEventListener("blur", function () {
                clearTimeout(t);
                guardar();
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
                // Aquí ya no hay ventana abierta que frene una recarga por
                // versión nueva (Asignar y Despacho manual sí la tienen).
                operacionesEnCurso++;
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
                } finally {
                    operacionesEnCurso--;
                }
            });
        });
    }

    // ============== Listas de subida (despachos_realizados agrupados) ==============
    function esHoy(fechaIso) {
        if (!fechaIso) return false;
        const d = new Date(fechaIso);
        const ahora = new Date();
        return d.getFullYear() === ahora.getFullYear() &&
            d.getMonth() === ahora.getMonth() &&
            d.getDate() === ahora.getDate();
    }

    // Conteo en vivo (no derivado de despachos_realizados, que no se actualiza
    // solo cuando el bus termina el viaje) de "en camino ahora" por dirección e
    // itinerario -- lo calcula y sincroniza despachosautomaticos cada 2 minutos
    // desde el despacho más reciente de cada bus en Sonar (running=Y).
    async function cargarResumenDirecciones() {
        if (!navigator.onLine) return;
        try {
            const { data, error } = await client.from(cfg.TABLA_RESUMEN_DIRECCIONES).select("*");
            if (error) throw error;
            resumenDirecciones = data || [];
            renderResumenDirecciones();
        } catch (err) {
            console.warn("Error cargando resumen de direcciones:", err);
        }
    }

    // Mismo dato que cargarResumenDirecciones, pero una fila por vehículo --
    // permite filtrar los marcadores del mapa por dirección (ver mapaFiltroZona).
    async function cargarDireccionVehiculos() {
        if (!navigator.onLine) return;
        try {
            const { data, error } = await client.from(cfg.TABLA_DIRECCION_VEHICULOS).select("*");
            if (error) throw error;
            direccionVehiculos = data || [];
            renderMap();
        } catch (err) {
            console.warn("Error cargando dirección de vehículos:", err);
        }
    }

    // La cuenta del programa por punto (puntos_ahora). El programa la renueva cada 30 s;
    // aquí se pide cada 15 s mientras se ve el mapa. Si falla, se deja la anterior:
    // cuentaDelPrograma() la descarta sola cuando se pone vieja.
    async function cargarPuntos() {
        if (!navigator.onLine || !cfg.TABLA_PUNTOS) return;
        try {
            const { data, error } = await client.from(cfg.TABLA_PUNTOS)
                .select("punto,orden,sentido,vienen,vienen_sin_arrancar,estan,en_fila,por_salir,por_zona,buses,foto_en")
                .order("orden", { ascending: true });
            if (error) throw error;
            puntosAhora = data || [];
        } catch (err) {
            console.warn("Error cargando la cuenta de los puntos:", err);
        }
        puntosIntentado = true;
        renderMap();
    }

    // mid -> interno de toda la flota, para que el filtro del mapa encuentre también a los
    // buses que no han tenido despacho hoy (la cuenta del programa dice el interno).
    async function cargarInternosFlota() {
        if (!navigator.onLine || !cfg.TABLA_FLOTA) return;
        try {
            const { data, error } = await client.from(cfg.TABLA_FLOTA).select("mid,interno");
            if (error) throw error;
            const mapa = {};
            (data || []).forEach(function (r) { if (r.mid && r.interno) mapa[r.mid] = String(r.interno); });
            internosFlota = mapa;
            renderMap();
        } catch (err) {
            console.warn("Error cargando los internos de la flota:", err);
        }
    }

    function direccionVehiculosPorMid() {
        const mapa = {};
        direccionVehiculos.forEach(function (r) { if (r.vehicle_id) mapa[r.vehicle_id] = r.direccion; });
        return mapa;
    }

    function renderResumenDirecciones() {
        const subiendo = {};
        const bajando = {};
        resumenDirecciones.forEach(function (r) {
            const itin = r.itinerario || "Sin itinerario";
            const grupo = r.direccion === DIRECCION_SUBIENDO ? subiendo : bajando;
            grupo[itin] = (grupo[itin] || 0) + (r.cantidad || 0);
        });

        function sumar(grupo) {
            return Object.keys(grupo).reduce(function (s, k) { return s + grupo[k]; }, 0);
        }
        // Los contadores del mapa salen de la cuenta del programa; esto queda de respaldo.
        sumasDirecciones = { subiendo: sumar(subiendo), bajando: sumar(bajando) };
        actualizarMiniStats();

        const boxes = document.querySelectorAll("[data-resumen-box]");
        if (!boxes.length) return;

        function renderColumna(titulo, grupo) {
            const entradas = Object.keys(grupo)
                .map(function (itin) { return [itin, grupo[itin]]; })
                .sort(function (a, b) { return b[1] - a[1]; });
            const total = entradas.reduce(function (s, e) { return s + e[1]; }, 0);
            const filas = entradas.length
                ? entradas.map(function (e) {
                    return `<div class="resumen-fila"><span>${escapeHtml(e[0])}</span><span class="tab-badge">${e[1]}</span></div>`;
                }).join("")
                : '<div class="resumen-vacio">Nadie en camino en esta dirección</div>';
            return `
                <div class="resumen-col">
                    <h4>${titulo}<span class="tab-badge">${total}</span></h4>
                    ${filas}
                </div>
            `;
        }

        const masReciente = resumenDirecciones.reduce(function (max, r) {
            return r.updated_at && r.updated_at > max ? r.updated_at : max;
        }, "");
        const notaTexto = masReciente ? `En vivo · actualizado ${humanizeAge(masReciente)}` : "";
        document.querySelectorAll("[data-resumen-nota]").forEach(function (nota) {
            nota.textContent = notaTexto;
        });

        const html =
            renderColumna("↑ Subiendo · hacia Medellín", subiendo) +
            renderColumna("↓ Bajando · hacia aeropuerto", bajando);
        boxes.forEach(function (box) { box.innerHTML = html; });
    }

    function renderSubida() {
        const box = document.getElementById("subidaBox");
        const subtitle = document.getElementById("subidaSubtitle");
        const badge = document.getElementById("tabSubidaBadge");
        if (!box) return;

        const permitidos = new Set((cfg.SUBIDA_ITINERARIOS_PERMITIDOS || []).map(normalizarItinerario));
        const visibles = realizados.filter(function (r) {
            return r.estado === "ACTIVO" && esHoy(r.created_at) &&
                (!permitidos.size || permitidos.has(normalizarItinerario(r.itinerario)));
        });

        if (badge) badge.textContent = String(visibles.length);

        if (!visibles.length) {
            if (subtitle) subtitle.textContent = "0 despachos activos hoy";
            box.innerHTML = '<div class="loading">No hay despachos activos hoy</div>';
            return;
        }

        if (subtitle) {
            subtitle.textContent = `${visibles.length} despachos activos hoy`;
        }

        // Lista única ordenada por hora descendente (más reciente arriba),
        // sin separar por itinerario -- ya viene como columna en cada fila.
        const ordenados = visibles.slice().sort(function (a, b) {
            return new Date(b.created_at) - new Date(a.created_at);
        });

        const filas = ordenados.map(function (r) {
            return `
                <tr>
                    <td class="hora">${escapeHtml(formatHora(r.created_at))}</td>
                    <td class="interno">
                        ${escapeHtml(r.interno || "")}
                        ${r.placa ? `<span class="placa-tag">${escapeHtml(r.placa)}</span>` : ""}
                    </td>
                    <td>${escapeHtml(r.itinerario || "")}</td>
                    <td>${r.pasajeros != null ? escapeHtml(String(r.pasajeros)) : "0"}</td>
                </tr>
            `;
        }).join("");

        box.innerHTML = `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Bus</th>
                        <th>Itinerario</th>
                        <th>Pasajeros</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;
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

    // ============== Ocultos manuales (enturnamiento_ocultos) ==============
    // Clave por arribo puntual (no solo por bus): si el mismo vehicle_id vuelve
    // a llegar de verdad más tarde (nuevo llegada_aeropuerto), ya no coincide
    // con lo oculto y reaparece solo -- ocultar un caso puntual no destierra al
    // bus para siempre de la lista.
    function claveOculto(vehicleId, llegada) {
        return String(vehicleId || "") + "|" + String(llegada || "");
    }

    async function cargarOcultos() {
        if (!navigator.onLine) return;
        try {
            const { data, error } = await client.from(cfg.TABLA_ENTURNAMIENTO_OCULTOS).select("id");
            if (error) throw error;
            ocultos = new Set((data || []).map(function (r) { return r.id; }));
        } catch (err) {
            console.warn("Error cargando ocultos:", err);
        }
    }

    // ============== Carga inicial + Realtime ==============
    async function cargarInicial() {
        if (!navigator.onLine) {
            setConnection("offline");
            return;
        }
        try {
            // La tabla nueva (enturne_filas) guarda las filas de TODOS
            // los puntos -- aeropuerto, Almacentro, Nutibara... Esta pantalla es solo la
            // del aeropuerto, asi que se pide nada mas ese punto. Si cfg.SOLO_PUNTO no
            // esta puesto (la tabla vieja), pide todo como siempre.
            let consulta = client.from(cfg.TABLA).select("*");
            if (cfg.SOLO_PUNTO) consulta = consulta.eq("punto", cfg.SOLO_PUNTO);
            const { data, error } = await consulta
                .order("itinerario", { ascending: true })
                .order("turno", { ascending: true });
            if (error) throw error;
            rows = (data || []).filter(function (r) {
                return !ocultos.has(claveOculto(r.vehicle_id, r.llegada_aeropuerto));
            });
            updateStats();
            renderChipsAndTable();
            renderTurnoLine();
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

    async function cargarPosiciones() {
        if (!navigator.onLine) return;
        try {
            const { data, error } = await client.from(cfg.TABLA_POSICIONES).select("*");
            if (error) throw error;
            posiciones = data || [];
            renderMap();
            renderChipsAndTable();
        } catch (err) {
            console.warn("Error cargando posiciones de flota:", err);
        }
    }

    function suscribirRealtime() {
        if (realtimeChannel) {
            try { client.removeChannel(realtimeChannel); } catch (_) { /* noop */ }
            realtimeChannel = null;
        }
        realtimeChannel = client
            .channel("enturnamiento_changes")
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
            cargarPosiciones();
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
        cargarPosiciones();
        suscribirRealtime();
    });

    window.addEventListener("offline", function () {
        console.log("Sin internet");
        setConnection("offline");
    });

    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && navigator.onLine) {
            cargarInicial();
            cargarPosiciones();
            if (appStarted) cargarPuntos();
            if (!realtimeChannel || realtimeChannel.state !== "joined") {
                suscribirRealtime();
            }
        }
    });

    // Posición de toda la flota: no tiene canal Realtime propio, se refresca por polling.
    setInterval(function () {
        if (navigator.onLine) cargarPosiciones();
    }, 15000);

    // Refresca "hace X min" cada minuto sin volver a pedir datos.
    setInterval(function () {
        renderChipsAndTable();
        renderTurnoLine();
        if (despachos.length) renderDespachos();
    }, 60000);

    // Auto-refresh de despachos cada 2 minutos si estás en la pestaña
    setInterval(function () {
        if (activeTab === "despachos" && navigator.onLine) cargarDespachos();
    }, 120000);

    // Auto-refresh de vuelos cada minuto si estás en la pestaña
    setInterval(function () {
        if (activeTab === "vuelos" && navigator.onLine) cargarVuelos();
    }, 60000);

    // Auto-refresh de turnos cada minuto si estás en la pestaña (refleja
    // entrada_ts/salida_ts en vivo a medida que los conductores marcan)
    setInterval(function () {
        if (activeTab === "turnos" && navigator.onLine) cargarTurnos();
    }, 60000);

    // Auto-refresh de ocultos cada minuto (para que si otro operador oculta un
    // bus, también desaparezca de tu lista sin recargar la página)
    setInterval(function () {
        if (navigator.onLine) cargarOcultos().then(cargarInicial);
    }, 60000);

    // Auto-refresh del resumen de direcciones cada 30s si estás en Mapa o Subida
    // (el backend lo sincroniza cada 2 min, esto solo evita esperar hasta el
    // próximo cambio de pestaña para verlo).
    setInterval(function () {
        if ((activeTab === "mapa" || activeTab === "subida") && navigator.onLine) cargarResumenDirecciones();
        if (activeTab === "mapa" && navigator.onLine) cargarDireccionVehiculos();
    }, 30000);

    // La cuenta del programa (Patio azul, Subiendo, Bajando) cada 15 s mientras se ve el
    // mapa: el programa la renueva cada 30 s, así nunca se ve con más de 45 s de atraso.
    setInterval(function () {
        if (appStarted && activeTab === "mapa" && navigator.onLine) cargarPuntos();
    }, 15000);

    // Los internos de la flota casi no cambian: cada 5 minutos alcanza.
    setInterval(function () {
        if (appStarted && navigator.onLine) cargarInternosFlota();
    }, 300000);

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

    function initVuelosControles() {
        const btn = document.getElementById("btnRefreshVuelos");
        if (btn) btn.addEventListener("click", cargarVuelos);
    }

    // ============== Despacho manual ==============
    function parseCsv(text) {
        // Parser CSV mínimo: maneja comillas dobles y comas dentro de comillas.
        const rows = [];
        let i = 0, field = "", row = [], inQuotes = false;
        while (i < text.length) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += c; i++; continue;
            }
            if (c === '"') { inQuotes = true; i++; continue; }
            if (c === ",") { row.push(field); field = ""; i++; continue; }
            if (c === "\r") { i++; continue; }
            if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
            field += c; i++;
        }
        if (field.length || row.length) { row.push(field); rows.push(row); }
        if (!rows.length) return [];
        const headers = rows.shift().map(function (h) { return h.trim(); });
        return rows
            .filter(function (r) { return r.some(function (v) { return v && v.trim().length; }); })
            .map(function (r) {
                const obj = {};
                headers.forEach(function (h, idx) { obj[h] = (r[idx] || "").trim(); });
                return obj;
            });
    }

    async function cargarConductores() {
        if (conductoresLoading) return conductoresLoading;
        conductoresLoading = (async function () {
            try {
                const resp = await fetch(cfg.CONDUCTORES_CSV_URL, { cache: "no-store" });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const text = await resp.text();
                const filas = parseCsv(text);
                conductores = filas
                    .filter(function (c) {
                        return c.dr_id && c.nombre &&
                            (c.status || "").toUpperCase() === "ENABLED";
                    })
                    .sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es"); });
            } catch (err) {
                console.warn("Error cargando conductores:", err);
                conductores = [];
            } finally {
                conductoresLoading = null;
            }
        })();
        return conductoresLoading;
    }

    async function cargarVehiculos() {
        if (vehiculosLoading) return vehiculosLoading;
        vehiculosLoading = (async function () {
            try {
                const { data, error } = await client
                    .from(cfg.TABLA_VEHICULOS)
                    .select('"ID","INTERNO","Placa"')
                    .order("INTERNO", { ascending: true });
                if (error) throw error;
                vehiculos = (data || [])
                    .filter(function (v) { return v && v.ID; })
                    .map(function (v) {
                        return { mid: v.ID, interno: v.INTERNO, placa: v.Placa };
                    });
                renderMap();
            } catch (err) {
                console.warn("Error cargando vehículos:", err);
                vehiculos = [];
            } finally {
                vehiculosLoading = null;
            }
        })();
        return vehiculosLoading;
    }

    function normalizar(s) {
        return String(s == null ? "" : s)
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .trim();
    }

    function buscarVehiculoPorInterno(val) {
        const v = normalizar(val);
        if (!v) return null;
        return vehiculos.find(function (x) {
            return normalizar(x.interno) === v;
        }) || null;
    }

    function buscarConductorPorNombre(val) {
        const v = normalizar(val);
        if (!v) return null;
        return conductores.find(function (c) {
            return normalizar(c.nombre) === v;
        }) || null;
    }

    // ===== Combobox genérico (input + dropdown filtrable) =====
    function setupCombobox(opts) {
        // opts: { input, list, getItems, getValue, matches(item, q), renderItem(item), onSelect(item) }
        const input = opts.input;
        const list = opts.list;
        let activeIndex = -1;
        let resultados = [];

        function abrir() {
            const q = input.value;
            const items = opts.getItems();
            resultados = q.trim()
                ? items.filter(function (it) { return opts.matches(it, q); })
                : items.slice(0, 100);
            renderLista();
            list.hidden = false;
        }

        function cerrar() {
            list.hidden = true;
            activeIndex = -1;
        }

        function renderLista() {
            if (!resultados.length) {
                list.innerHTML = '<div class="combobox-empty">Sin resultados</div>';
                return;
            }
            list.innerHTML = resultados.slice(0, 50).map(function (it, idx) {
                const html = opts.renderItem(it);
                return `<div class="combobox-item${idx === activeIndex ? " active" : ""}" role="option" data-idx="${idx}">${html}</div>`;
            }).join("");
        }

        function seleccionar(idx) {
            const it = resultados[idx];
            if (!it) return;
            input.value = opts.getValue(it);
            cerrar();
            if (opts.onSelect) opts.onSelect(it);
        }

        input.addEventListener("focus", abrir);
        input.addEventListener("input", function () {
            activeIndex = -1;
            abrir();
            if (opts.onChange) opts.onChange();
        });
        input.addEventListener("keydown", function (ev) {
            if (list.hidden) {
                if (ev.key === "ArrowDown" || ev.key === "Enter") { abrir(); ev.preventDefault(); }
                return;
            }
            if (ev.key === "ArrowDown") {
                activeIndex = Math.min(resultados.length - 1, activeIndex + 1);
                renderLista();
                ev.preventDefault();
            } else if (ev.key === "ArrowUp") {
                activeIndex = Math.max(0, activeIndex - 1);
                renderLista();
                ev.preventDefault();
            } else if (ev.key === "Enter") {
                if (activeIndex >= 0) {
                    seleccionar(activeIndex);
                    ev.preventDefault();
                }
            } else if (ev.key === "Escape") {
                cerrar();
            }
        });
        // Click en un item del dropdown
        list.addEventListener("mousedown", function (ev) {
            const el = ev.target.closest(".combobox-item");
            if (!el) return;
            ev.preventDefault(); // evita perder el foco antes del click
            const idx = parseInt(el.dataset.idx, 10);
            if (Number.isFinite(idx)) seleccionar(idx);
        });
        // Cerrar al hacer clic fuera
        document.addEventListener("mousedown", function (ev) {
            if (!list.hidden && !input.parentElement.contains(ev.target)) cerrar();
        });

        return { abrir, cerrar };
    }

    function extraerBase(email) {
        if (!email) return "";
        const m = String(email).match(/BASE\s*\d+/i);
        return m ? m[0].toUpperCase().replace(/\s+/, " ") : "";
    }

    function actualizarCamposVehiculo() {
        const inputInterno = document.getElementById("manualInterno");
        const inputMid = document.getElementById("manualMid");
        const v = buscarVehiculoPorInterno(inputInterno.value);
        inputMid.value = v ? v.mid : "";
    }

    function actualizarCamposConductor() {
        const inputCond = document.getElementById("manualConductor");
        const inputDrvId = document.getElementById("manualDriverId");
        const inputBase = document.getElementById("manualBase");
        const c = buscarConductorPorNombre(inputCond.value);
        inputDrvId.value = c ? c.dr_id : "";
        inputBase.value = c ? extraerBase(c.email) : "";
    }

    function abrirManualModal() {
        const modal = document.getElementById("manualModal");
        const selItin = document.getElementById("manualItin");

        // Itinerarios permitidos para despacho manual
        const PERMITIDOS = ["4501", "4503", "4507"];
        const itins = (cfg.ITINERARIOS || []).filter(function (i) { return PERMITIDOS.includes(i.id); });
        selItin.innerHTML = '<option value="">Selecciona itinerario...</option>' +
            itins.map(function (i) {
                return `<option value="${escapeHtml(i.id)}">${escapeHtml(i.nombre)} (${escapeHtml(i.grupo)})</option>`;
            }).join("");

        document.getElementById("manualInterno").value = "";
        document.getElementById("manualMid").value = "";
        document.getElementById("manualBase").value = "";
        document.getElementById("manualConductor").value = "";
        document.getElementById("manualDriverId").value = "";
        document.getElementById("manualObs").value = "";
        document.getElementById("manualError").hidden = true;

        const aviso = [];
        if (!vehiculos.length) aviso.push("Sin vehículos cargados");
        if (!conductores.length) aviso.push("Sin conductores cargados");
        if (aviso.length) {
            const err = document.getElementById("manualError");
            err.textContent = aviso.join(" · ") + " — revisa la conexión / RLS";
            err.hidden = false;
        }

        modal.hidden = false;
        setTimeout(function () { document.getElementById("manualInterno").focus(); }, 50);
    }

    function cerrarManualModal() {
        document.getElementById("manualModal").hidden = true;
    }

    async function submitManual(ev) {
        ev.preventDefault();
        const submitBtn = document.getElementById("manualSubmit");
        const errorBox = document.getElementById("manualError");

        // Vehículo (resuelto por interno)
        const internoVal = document.getElementById("manualInterno").value.trim();
        const v = buscarVehiculoPorInterno(internoVal);
        const mId = v ? v.mid : "";
        const interno = v ? String(v.interno || "") : internoVal;
        const placa = v ? String(v.placa || "") : "";

        // Conductor (resuelto por nombre)
        const condVal = document.getElementById("manualConductor").value.trim();
        const c = buscarConductorPorNombre(condVal);
        const drvId = c ? c.dr_id : "";
        const driverNombre = c ? c.nombre : condVal;

        const itinerary = document.getElementById("manualItin").value;
        const observaciones = document.getElementById("manualObs").value.trim();

        if (!mId) { errorBox.textContent = "Selecciona un interno válido de la lista (MID requerido)."; errorBox.hidden = false; return; }
        if (!drvId) { errorBox.textContent = "Selecciona un conductor válido de la lista (Driver ID requerido)."; errorBox.hidden = false; return; }
        if (!itinerary) { errorBox.textContent = "Selecciona un itinerario."; errorBox.hidden = false; return; }

        const itinObj = (cfg.ITINERARIOS || []).find(function (i) { return i.id === itinerary; });

        const detalleHtml = `
            <div><strong>Bus:</strong> ${escapeHtml(interno || mId)}${placa ? ` <span class="placa-tag">${escapeHtml(placa)}</span>` : ""}</div>
            <div><strong>Conductor:</strong> ${escapeHtml(driverNombre)} (${escapeHtml(drvId)})</div>
            <div><strong>Itinerario:</strong> ${escapeHtml(itinObj?.nombre || itinerary)}</div>
            ${observaciones ? `<div><strong>Observación:</strong> ${escapeHtml(observaciones)}</div>` : ""}
        `;
        const ok = await mostrarConfirmacion({
            titulo: "Confirmar despacho manual",
            mensaje: "Se enviará la orden a Sonar y quedará registrada en Despachos realizados.",
            detalle: detalleHtml,
            textoConfirmar: "Sí, despachar",
            textoCancelar: "Revisar",
            tipo: "info",
        });
        if (!ok) return;

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
            if (regId) {
                try {
                    const { error } = await client.from(cfg.TABLA_REALIZADOS).insert({
                        reg_id: regId,
                        vehicle_id: mId,
                        interno: interno || mId,
                        placa: placa,
                        itinerario_id: itinerary,
                        itinerario: itinObj?.nombre || "",
                        driver_id: drvId,
                        observaciones: observaciones,
                        pasajeros: 0,
                        created_by: currentUser?.id || null,
                    });
                    if (error) console.warn("Insert despachos_realizados (manual) falló:", error);
                } catch (e) {
                    console.warn("No se pudo guardar el despacho manual local:", e);
                }
            }

            cerrarManualModal();
            showToast("ok", `Despacho manual asignado${regId ? " · regId: " + regId : ""}`);
        } catch (err) {
            errorBox.textContent = "Error: " + (err.message || String(err));
            errorBox.hidden = false;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Enviar despacho";
        }
    }

    function initManualModal() {
        const modal = document.getElementById("manualModal");
        if (!modal) return;
        modal.querySelectorAll("[data-close]").forEach(function (btn) {
            btn.addEventListener("click", cerrarManualModal);
        });
        modal.addEventListener("click", function (ev) {
            if (ev.target === modal) cerrarManualModal();
        });
        document.addEventListener("keydown", function (ev) {
            if (ev.key === "Escape" && !modal.hidden) cerrarManualModal();
        });
        document.getElementById("manualForm").addEventListener("submit", submitManual);

        // Combobox de vehículos: filtra por interno o placa
        const inputInterno = document.getElementById("manualInterno");
        const listInterno = inputInterno.parentElement.querySelector(".combobox-list");
        setupCombobox({
            input: inputInterno,
            list: listInterno,
            getItems: function () { return vehiculos; },
            getValue: function (v) { return v.interno != null ? String(v.interno) : ""; },
            matches: function (v, q) {
                const n = normalizar(q);
                return normalizar(v.interno).includes(n) ||
                    normalizar(v.placa).includes(n) ||
                    normalizar(v.mid).includes(n);
            },
            renderItem: function (v) {
                return `<span class="combobox-item-title">${escapeHtml(v.interno || "")}</span>` +
                    `<span class="combobox-item-meta">${escapeHtml(v.placa || "")} · MID ${escapeHtml(v.mid)}</span>`;
            },
            onSelect: actualizarCamposVehiculo,
            onChange: actualizarCamposVehiculo,
        });

        // Combobox de conductores: filtra por nombre o cédula
        const inputCond = document.getElementById("manualConductor");
        const listCond = inputCond.parentElement.querySelector(".combobox-list");
        setupCombobox({
            input: inputCond,
            list: listCond,
            getItems: function () { return conductores; },
            getValue: function (c) { return c.nombre || ""; },
            matches: function (c, q) {
                const n = normalizar(q);
                return normalizar(c.nombre).includes(n) ||
                    normalizar(c.cedula).includes(n) ||
                    normalizar(c.dr_id).includes(n);
            },
            renderItem: function (c) {
                const base = extraerBase(c.email);
                const meta = [c.cedula ? "Cédula " + c.cedula : "", base, "ID " + c.dr_id].filter(Boolean).join(" · ");
                return `<span class="combobox-item-title">${escapeHtml(c.nombre)}</span>` +
                    `<span class="combobox-item-meta">${escapeHtml(meta)}</span>`;
            },
            onSelect: actualizarCamposConductor,
            onChange: actualizarCamposConductor,
        });

        const btn = document.getElementById("btnManualDispatch");
        if (btn) {
            btn.addEventListener("click", async function () {
                const tareas = [];
                if (!vehiculos.length) tareas.push(cargarVehiculos());
                if (!conductores.length) tareas.push(cargarConductores());
                if (tareas.length) await Promise.all(tareas);
                abrirManualModal();
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
        const btnManual = document.getElementById("btnManualDispatch");
        if (currentUser) {
            loginScreen.hidden = true;
            btnLogout.hidden = false;
            btnLogout.title = `Cerrar sesión (${currentUser.email})`;
            if (btnManual) btnManual.hidden = false;
        } else {
            loginScreen.hidden = false;
            btnLogout.hidden = true;
            if (btnManual) btnManual.hidden = true;
        }
    }

    function startApp() {
        if (appStarted) return;
        appStarted = true;
        initTabs();
        initMap();
        initMapaControles();
        initModal();
        initManualModal();
        initDespachosControles();
        initRealizadosControles();
        initVuelosControles();
        initTurnosControles();
        if (navigator.onLine) {
            cargarOcultos().then(cargarInicial); // ocultos primero, para no parpadear un bus ya oculto
            cargarPosiciones();
            suscribirRealtime();
            suscribirRealizadosRealtime();
            cargarRealizados();
            cargarVehiculos();
            cargarConductores();
            cargarResumenDirecciones();
            cargarDireccionVehiculos();
            cargarPuntos();
            cargarInternosFlota();
            cargarTurnos();
        } else {
            setConnection("offline");
        }
    }

    initAuth();
})();

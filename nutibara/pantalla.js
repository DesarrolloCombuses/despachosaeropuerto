/* Pantalla Nutibara (página web): cada 20 segundos le pide a Supabase dónde van los buses del 4503
   (función nutibara_pantalla, solo lee, sin conductores) y calcula aquí mismo cuánto les falta (tiempos.js). */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const REFRESCO_MS = 20000;
  const DATO_VIEJO_MS = 3 * 60000;   // si el programa de enturnes no publica hace más de esto: aviso arriba
  const RECARGAR_MS = 6 * 3600000;   // cada 6 horas se recarga sola, para tomar los cambios de la página
  const DESTINO = [6.252824, -75.567134];

  let T = null;
  let RECORRIDO = null;
  let ultimo = null;        // lo último que llegó de Supabase
  let ultimoOk = null;      // cuándo llegó (reloj del servidor)
  let desfase = 0;          // reloj del servidor − reloj de este televisor
  const ahora = () => Date.now() + desfase;
  const { horaBonita } = window.TiemposNutibara;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function actualizarReloj() {
    document.getElementById('reloj').textContent = horaBonita(ahora());
  }

  // ---- Mapa ----
  const mapa = L.map('mapa', { zoomControl: false }).setView(DESTINO, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(mapa);
  L.marker(DESTINO, {
    icon: L.divIcon({
      className: '',
      html: '<div class="pin-destino-wrap"><div class="pin-destino">🚩</div><span class="etiqueta-destino">Nutibara</span></div>',
      iconSize: [120, 32], iconAnchor: [16, 30],
    }),
  }).addTo(mapa);

  function iconoBus(numero, clase) {
    return L.divIcon({ className: '', html: `<div class="pin-bus ${clase}">${esc(numero)}</div>`, iconSize: [40, 28], iconAnchor: [20, 14] });
  }
  const marcadores = {};
  let encuadre = '';

  function dibujarRecorrido(r) {
    if (!r || !r.ruta || !r.ruta.length) return;
    L.polyline(r.ruta, { color: '#167a3d', weight: 5, opacity: 0.55 }).addTo(mapa);
    (r.hitos || []).forEach(h => {
      if (h.nombre !== 'Aeropuerto' && h.nombre !== 'Túnel') return;   // los del centro ya se ven en el mapa
      const i = Math.min(r.ruta.length - 1, Math.round(h.progreso * (r.ruta.length - 1)));
      L.circleMarker(r.ruta[i], { radius: 5, color: '#0e5a2c', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .bindTooltip(h.nombre, { permanent: true, direction: 'top', className: 'tip-hito' }).addTo(mapa);
    });
  }

  function actualizarMapa(buses) {
    const vistos = new Set();
    buses.forEach(b => {
      if (b.lat == null || b.lon == null) return;
      vistos.add(b.numero);
      const ll = b.ll || {};
      const clase = ll.estado === 'llegando' || ll.estado === 'en_nutibara' ? 'pin-llegando'
        : (ll.estado === 'en_camino' || ll.estado === 'aeropuerto') ? '' : 'pin-gris';
      const popup = `<b>Bus ${esc(b.numero)}</b> · ${esc(b.placa || '')}` + (ll.hora ? `<br>Llega: ${esc(ll.hora)}` : '');
      if (marcadores[b.numero]) {
        marcadores[b.numero].setLatLng([b.lat, b.lon]).setIcon(iconoBus(b.numero, clase)).setPopupContent(popup);
      } else {
        marcadores[b.numero] = L.marker([b.lat, b.lon], { icon: iconoBus(b.numero, clase) }).addTo(mapa).bindPopup(popup);
      }
    });
    Object.keys(marcadores).forEach(id => { if (!vistos.has(id)) { mapa.removeLayer(marcadores[id]); delete marcadores[id]; } });
    // se vuelve a encuadrar solo si cambió qué buses hay (para no saltar cada 20 s)
    const quienes = Object.keys(marcadores).sort().join(',');
    if (quienes !== encuadre) {
      encuadre = quienes;
      const puntos = [DESTINO, ...Object.values(marcadores).map(m => m.getLatLng())];
      if (puntos.length > 1) mapa.fitBounds(puntos, { padding: [30, 30], maxZoom: 14 });
    }
  }

  // ---- Lo que se muestra de cada bus ----
  function rango(ll) {
    if (!ll.rango) return '';
    const [a, b] = ll.rango;
    return a === b ? '' : `entre ${a} y ${b} min`;
  }

  function porDonde(ll) {
    if (ll.estado === 'aeropuerto') return 'Todavía en el aeropuerto';
    if (!ll.paso_por) return '';
    if (ll.paso_por === 'Aeropuerto') return `Salió del aeropuerto · faltan ${ll.falta_km} km`;
    return `Ya pasó ${ll.paso_por === 'Túnel' ? 'el Túnel' : ll.paso_por} · faltan ${ll.falta_km} km`;
  }

  function cuandoGrande(ll) {
    if (ll.estado === 'llegando') return '<span class="grande llegando">Llegando</span>';
    if (ll.minutos == null) return '<span class="grande gris">—</span>';
    return `<span class="grande">${ll.minutos}<small> min</small></span>`;
  }

  // ¿sigue a Nutibara o se queda en San Diego? (lo que pasa a esa hora en las últimas semanas)
  function nivel(ll) {
    return (ll.va_a_nutibara && ll.va_a_nutibara.nivel) || 'casi_siempre';
  }

  function avisoSanDiego(ll) {
    if (nivel(ll) !== 'a_veces') return '';
    const n = ll.va_a_nutibara.de_10;
    return `<span class="chip chip-aviso">Puede quedarse en San Diego${n != null ? ` · a esta hora siguen ${n} de cada 10` : ''}</span>`;
  }

  function filaBus(b) {
    const ll = b.ll;
    const avisoSenal = (ll.estado === 'sin_senal'
      ? `<span class="chip chip-aviso">Sin señal hace ${ll.edad_min} min · aproximado</span>` : '') + avisoSanDiego(ll);
    return `
      <div class="bus ${ll.estado === 'llegando' ? 'es-llegando' : ''} ${ll.estado === 'sin_senal' ? 'es-gris' : ''}">
        <div class="bus-num"><span>${esc(b.numero)}</span><small>${esc(b.placa || '')}</small></div>
        <div class="bus-cuando">
          <div class="cuando-etq">${ll.estado === 'llegando' ? '' : 'Llega en'}</div>
          ${cuandoGrande(ll)}
        </div>
        <div class="bus-detalle">
          <div class="hora">${ll.hora && ll.estado !== 'llegando' ? `a las <b>${esc(ll.hora)}</b>
            <span class="rango">${esc(rango(ll))}</span>` : ''}</div>
          <div class="donde">${esc(porDonde(ll))} ${avisoSenal}</div>
          <div class="barra"><i style="width:${Math.round((ll.progreso || 0) * 100)}%"></i></div>
        </div>
      </div>`;
  }

  function pintarLinea(buses) {
    const card = document.getElementById('lineaCard');
    const linea = document.getElementById('linea');
    if (!RECORRIDO || !RECORRIDO.hitos) { card.hidden = true; return; }
    card.hidden = false;
    // si dos nombres quedan muy juntos (San Diego y Exposiciones), el segundo baja un renglón
    let anterior = -100, bajar = false;
    const hitos = RECORRIDO.hitos.map(h => {
      const x = h.progreso * 100;
      bajar = (x - anterior < 8) ? !bajar : false;
      anterior = x;
      return `
      <div class="hito ${h.nombre === 'Nutibara' ? 'hito-fin' : ''} ${bajar ? 'hito-abajo' : ''}" style="left:${x.toFixed(1)}%">
        <i></i><span>${esc(h.nombre)}</span></div>`;
    }).join('');
    // los que van muy juntos se ponen uno encima del otro para que no se tapen
    const usados = [];
    const fichas = buses.filter(b => b.ll && b.ll.progreso != null).map(b => {
      const p = b.ll.progreso * 100;
      let n = 0;
      while (usados.some(u => u.nivel === n && Math.abs(u.p - p) < 6)) n++;
      usados.push({ p, nivel: n });
      const clase = b.ll.estado === 'llegando' ? 'ficha-llegando' : b.ll.estado === 'sin_senal' ? 'ficha-gris' : '';
      return `<div class="ficha ${clase}" style="left:${p.toFixed(1)}%; bottom:${30 + n * 34}px">${esc(b.numero)}</div>`;
    }).join('');
    linea.innerHTML = '<div class="linea-via"></div>' + hitos + fichas;
    linea.style.height = `${96 + Math.max(0, ...usados.map(u => u.nivel)) * 34}px`;
  }

  const ms = s => (s ? Date.parse(s) : null);

  function render() {
    if (!ultimo || !T) return;
    const t = ahora();
    const buses = (ultimo.buses || []).map(b => ({
      numero: String(b.bus), placa: b.placa, lat: b.lat, lon: b.lon,
      ll: T.estimar({ lat: b.lat, lon: b.lon, gpsMs: ms(b.gps_en), ahoraMs: t, despachoMs: ms(b.despacho_en) }),
    }));

    const enCamino = buses.filter(b => ['en_camino', 'llegando', 'aeropuerto', 'sin_senal'].includes(b.ll.estado) && b.ll.minutos != null);
    const seQuedan = enCamino.filter(b => nivel(b.ll) === 'casi_nunca');
    const vienen = enCamino.filter(b => !seQuedan.includes(b)).sort((a, b) => a.ll.minutos - b.ll.minutos);
    const enNutibara = buses.filter(b => b.ll.estado === 'en_nutibara');
    const otros = buses.filter(b => !enCamino.includes(b) && !enNutibara.includes(b));

    // El próximo: primero los que seguro o casi siempre siguen a Nutibara y tienen señal
    const prox = vienen.find(b => b.ll.estado !== 'sin_senal' && nivel(b.ll) !== 'a_veces')
      || vienen.find(b => b.ll.estado !== 'sin_senal') || vienen[0];
    const p = document.getElementById('proximo');
    if (prox) {
      const ll = prox.ll;
      p.innerHTML = `
        <div class="prox-etq">Próximo bus en llegar</div>
        <div class="prox-fila">
          <div class="prox-num">${esc(prox.numero)}</div>
          <div class="prox-cuando">${ll.estado === 'llegando' ? '<span class="llegando">Está llegando</span>'
            : `llega en <b>${ll.minutos} min</b>`}</div>
          <div class="prox-hora">${ll.hora && ll.estado !== 'llegando' ? `a las ${esc(ll.hora)}` : ''}
            <span>${esc(porDonde(ll))}</span></div>
        </div>
        ${nivel(ll) === 'a_veces' ? `<div class="prox-aviso">Puede quedarse en San Diego: a esta hora siguen a Nutibara ${ll.va_a_nutibara.de_10 != null ? ll.va_a_nutibara.de_10 : 'algunos'} de cada 10 buses.</div>` : ''}`;
    } else {
      p.innerHTML = '<p class="estado">En este momento no viene ningún bus del aeropuerto hacia Nutibara.</p>';
    }

    pintarLinea(vienen);

    document.getElementById('lista').innerHTML = vienen.length
      ? `<h2>Vienen en camino <span class="contador">${vienen.length}</span></h2>${vienen.map(filaBus).join('')}` : '';

    const o = document.getElementById('otros');
    const partes = [];
    if (enNutibara.length) {
      partes.push(`<div><b>Ya están en Nutibara:</b> ${enNutibara.map(b => `<span class="chip chip-ok">${esc(b.numero)}</span>`).join(' ')}</div>`);
    }
    if (seQuedan.length) {
      partes.push(`<div><b>Se quedan en San Diego</b> (a esta hora casi nunca siguen a Nutibara): ${seQuedan.map(b =>
        `<span class="chip">${esc(b.numero)} · ${b.ll.estado === 'llegando' ? 'llegando' : `a ${b.ll.falta_km} km`}</span>`).join(' ')}</div>`);
    }
    const nombres = { apagado: 'apagado', fuera_ruta: 'fuera del recorrido', sin_senal: 'sin señal' };
    if (otros.length) {
      partes.push(`<div><b>Despachados que no vienen ahora:</b> ${otros.map(b =>
        `<span class="chip">${esc(b.numero)} · ${esc(nombres[b.ll.estado] || 'sin datos')}${b.ll.a_km_nutibara != null ? ` (a ${b.ll.a_km_nutibara} km de Nutibara)` : ''}</span>`).join(' ')}</div>`);
    }
    o.innerHTML = partes.join('');
    o.hidden = !partes.length;

    actualizarMapa(buses);
    avisos();
  }

  // Aviso arriba si los datos están viejos: el programa que publica dejó de hacerlo, o este televisor no tiene internet.
  function avisos() {
    const a = document.getElementById('avisoViejo');
    const t = ahora();
    const alDia = ultimo && ultimo.flota_al_dia ? Date.parse(ultimo.flota_al_dia) : null;
    let texto = '';
    if (ultimoOk && t - ultimoOk > DATO_VIEJO_MS) {
      texto = `Sin conexión desde las ${horaBonita(ultimoOk)} Los tiempos pueden no ser exactos.`;
    } else if (alDia && t - alDia > DATO_VIEJO_MS) {
      texto = `La ubicación de los buses no se ha actualizado desde las ${horaBonita(alDia)} Los tiempos pueden no ser exactos.`;
    }
    a.textContent = texto;
    a.hidden = !texto;
  }

  async function pedirBuses() {
    const r = await fetch(`${String(CFG.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/rpc/nutibara_pantalla`, {
      method: 'POST',
      headers: { apikey: CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function cargarDatos() {
    try {
      const d = await pedirBuses();
      if (d && d.ahora) desfase = Date.parse(d.ahora) - Date.now();
      ultimo = d || { buses: [] };
      ultimoOk = ahora();
    } catch (e) {
      if (!ultimo) {
        document.getElementById('proximo').innerHTML = '<p class="estado error">No se pudo conectar. Se vuelve a intentar en unos segundos…</p>';
        return;
      }
      // con lo último que llegó se sigue contando; arriba sale el aviso de "sin conexión"
    }
    render();
  }

  async function iniciar() {
    actualizarReloj();
    setInterval(actualizarReloj, 1000);
    try {
      const m = await (await fetch('tiempos_nutibara.json', { cache: 'no-cache' })).json();
      T = new window.TiemposNutibara.Tiempos(m);
      RECORRIDO = T.paraLaPagina();
      dibujarRecorrido(RECORRIDO);
      document.getElementById('nota').textContent =
        `La hora de llegada sale de lo que tardaron los buses a esta misma hora del día en ${RECORRIDO.viajes} viajes ` +
        `(del ${RECORRIDO.desde} al ${RECORRIDO.hasta}). Se actualiza cada ${REFRESCO_MS / 1000} segundos.`;
    } catch (e) {
      document.getElementById('proximo').innerHTML = '<p class="estado error">No se pudo cargar la tabla de tiempos. Recargue la página.</p>';
      return;
    }
    await cargarDatos();
    setInterval(cargarDatos, REFRESCO_MS);
    setTimeout(() => location.reload(), RECARGAR_MS);
  }

  iniciar();
})();

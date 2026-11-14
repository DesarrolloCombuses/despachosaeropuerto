/* Cuánto le falta a un bus para llegar a Nutibara, con lo que tardaron DE VERDAD los buses del 4503 en las
   últimas semanas (tiempos_nutibara.json).

   Cómo se calcula: se ubica al bus sobre el recorrido (cuántos km le faltan por la vía, no en línea recta) y se
   busca cuánto se demoraron los buses que pasaron por ese mismo punto a esa misma hora del día. Lo normal (la
   mediana) es la hora que se muestra; el rango es lo que tardó la mitad de los buses (del 25 % al 75 %).

   No usa la velocidad del momento: un bus parado en un semáforo no "se demora una hora", y uno a 80 km/h en la
   autopista no "llega en 10 min". Es la misma cuenta del programa de Python de la pantalla verde (tiempos.py). */
(function (raiz) {
  'use strict';

  const LLEGANDO_KM = 0.4;      // a menos de esto por la vía: "Llegando"
  const SIN_SENAL_MIN = 15;     // GPS más viejo que esto: "Sin señal"
  const AEROPUERTO_KM = 1.0;    // en el primer km del recorrido: "Todavía en el aeropuerto"
  // ¿Sigue a Nutibara? De los que salieron a esa hora en las últimas semanas, cuántos llegaron:
  const CASI_SIEMPRE = 0.75;    // desde aquí se muestra normal
  const A_VECES = 0.35;         // entre las dos: "Puede quedarse en San Diego"; por debajo: aparte
  const COLOMBIA_MS = -5 * 3600 * 1000;   // Colombia no cambia la hora en el año
  const COS0 = Math.cos(6.21 * Math.PI / 180);

  function xy(lat, lon) {
    return [(lon + 75.5) * 111320.0 * COS0, (lat - 6.2) * 110540.0];
  }

  // Redondeo como el de Python (un .5 exacto va al número par), para que dé igual que la pantalla de Python.
  function redondear(x, dec) {
    const f = Math.pow(10, dec || 0);
    const v = x * f;
    const piso = Math.floor(v);
    const r = (v - piso === 0.5) ? (piso % 2 === 0 ? piso : piso + 1) : Math.round(v);
    return r / f;
  }

  function adentro(lat, lon, pol) {
    let c = false;
    for (let i = 0, j = pol.length - 1; i < pol.length; j = i++) {
      const yi = pol[i][0], xi = pol[i][1], yj = pol[j][0], xj = pol[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) c = !c;
    }
    return c;
  }

  // La hora de Colombia de un instante (en milisegundos), sin importar la zona horaria del televisor.
  function enColombia(ms) {
    return new Date(ms + COLOMBIA_MS);   // leer con getUTCHours / getUTCMinutes
  }

  function horaBonita(ms) {   // 12:35 p. m.
    const d = enColombia(ms);
    const h = d.getUTCHours();
    return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  }

  class Tiempos {
    constructor(m) {
      this.modelo = m;
      this.ruta = m.ruta;
      this.puntos = m.ruta.map(p => xy(p[0], p[1]));
      this.s = [0];
      for (let i = 1; i < this.puntos.length; i++) {
        const a = this.puntos[i - 1], b = this.puntos[i];
        this.s.push(this.s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      this.largoM = this.s[this.s.length - 1];
      this.fueraM = Number(m.fuera_m != null ? m.fuera_m : 350);
      this.hitos = m.hitos || [];
      this.franjas = m.franjas;
      this.tabla = m.tabla;
      this.geocerca = m.geocerca_nutibara || [];
      this.siguen = {};
      Object.keys(m.siguen_a_nutibara || {}).forEach(k => { this.siguen[parseInt(k, 10)] = m.siguen_a_nutibara[k]; });
      const expo = this.hitos.filter(h => h.nombre === 'Exposiciones').map(h => h.km);
      this.kmSeguro = expo.length ? expo[0] - 0.15 : null;   // pasó Exposiciones: ya va para Nutibara
    }

    // ---- dónde va el bus: [metros recorridos sobre la ruta, metros de distancia a la ruta] ----
    proyectar(lat, lon) {
      const q = xy(lat, lon);
      let mejorD = Infinity, mejorS = 0;
      for (let i = 0; i < this.puntos.length - 1; i++) {
        const a = this.puntos[i], b = this.puntos[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
        const d = Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
        if (d < mejorD) {
          mejorD = d;
          mejorS = this.s[i] + t * Math.sqrt(l2);
        }
      }
      return [mejorS, mejorD];
    }

    franja(ms) {
      const h = enColombia(ms).getUTCHours();
      for (let i = 0; i < this.franjas.length; i++) {
        if (this.franjas[i].desde <= h && h < this.franjas[i].hasta) return i;
      }
      return 0;
    }

    // [rápido, normal, lento] en minutos que le faltan, interpolando entre los cortes de la tabla
    minutos(franja, faltaKm) {
      let linea = this.tabla[String(franja)] || [];
      if (linea.length < 4) linea = this.tabla.todas;
      const ultima = linea[linea.length - 1];
      if (faltaKm >= ultima[0]) return ultima.slice(1, 4);
      if (faltaKm <= linea[0][0]) return linea[0].slice(1, 4);
      for (let i = 0; i < linea.length - 1; i++) {
        const a = linea[i], b = linea[i + 1];
        if (a[0] <= faltaKm && faltaKm <= b[0]) {
          const k = (faltaKm - a[0]) / ((b[0] - a[0]) || 1e-9);
          return [1, 2, 3].map(j => a[j] + k * (b[j] - a[j]));
        }
      }
      return ultima.slice(1, 4);
    }

    // {nivel: seguro | casi_siempre | a_veces | casi_nunca, de_10: cuántos de cada 10 siguen a esa hora}
    vaANutibara(km, salioMs) {
      if (this.kmSeguro != null && km >= this.kmSeguro) return { nivel: 'seguro', de_10: 10 };
      if (!Object.keys(this.siguen).length) return { nivel: 'casi_siempre', de_10: null };
      const h = enColombia(salioMs).getUTCHours();
      let [llegaron, salieron] = this.siguen[h] || [0, 0];
      if (salieron < 10) {                       // pocos viajes a esa hora: se suman las horas de al lado
        [h - 1, h + 1].forEach(v => {
          const [a, b] = this.siguen[((v % 24) + 24) % 24] || [0, 0];
          llegaron += a;
          salieron += b;
        });
      }
      if (!salieron) return { nivel: 'casi_siempre', de_10: null };
      const p = llegaron / salieron;
      const nivel = p >= CASI_SIEMPRE ? 'casi_siempre' : p >= A_VECES ? 'a_veces' : 'casi_nunca';
      return { nivel, de_10: redondear(p * 10) };
    }

    vaPor(km) {
      const pasados = this.hitos.filter(h => h.km <= km + 0.05);
      const siguientes = this.hitos.filter(h => h.km > km + 0.05);
      return [pasados.length ? pasados[pasados.length - 1].nombre : null, siguientes.length ? siguientes[0].nombre : null];
    }

    // ---- lo que muestra la pantalla de un bus ----
    // estado: en_camino · llegando · aeropuerto · en_nutibara · sin_senal · apagado · fuera_ruta
    estimar({ lat, lon, gpsMs, motor, ahoraMs, despachoMs }) {
      const ahora = ahoraMs != null ? ahoraMs : Date.now();
      if (lat == null || lon == null) return { estado: 'sin_senal' };
      const gps = gpsMs != null ? gpsMs : ahora;
      const edadMin = Math.max(0, (ahora - gps) / 60000);
      const base = { edad_min: redondear(edadMin) };
      if (this.geocerca.length && adentro(lat, lon, this.geocerca)) {
        return { ...base, estado: 'en_nutibara', progreso: 1, minutos: 0 };
      }
      if (motor === 'apagado') return { ...base, estado: 'apagado' };
      const [s, fuera] = this.proyectar(lat, lon);
      if (fuera > this.fueraM) {
        const fin = this.puntos[this.puntos.length - 1];
        const q = xy(lat, lon);
        return {
          ...base, estado: 'fuera_ruta', fuera_km: redondear(fuera / 1000, 1),
          a_km_nutibara: redondear(Math.hypot(q[0] - fin[0], q[1] - fin[1]) / 1000, 1),
        };
      }
      const faltaKm = Math.max(0, (this.largoM - s) / 1000);
      const [rapido, normal, lento] = this.minutos(this.franja(gps), faltaKm);
      const llega = gps + normal * 60000;
      const faltan = (llega - ahora) / 60000;
      const desde = Math.max(0, redondear((gps + rapido * 60000 - ahora) / 60000));
      const hasta = Math.max(desde, redondear((gps + lento * 60000 - ahora) / 60000));
      const [paso, sigue] = this.vaPor(s / 1000);
      const va = this.vaANutibara(s / 1000, despachoMs != null ? despachoMs : gps);
      let estado;
      if (edadMin > SIN_SENAL_MIN) estado = 'sin_senal';
      else if (faltaKm <= LLEGANDO_KM || faltan <= 1.5) estado = 'llegando';
      else if (s / 1000 <= AEROPUERTO_KM) estado = 'aeropuerto';
      else estado = 'en_camino';
      return {
        ...base,
        estado,
        minutos: Math.max(0, redondear(faltan)),
        rango: [desde, hasta],
        hora: horaBonita(llega),
        falta_km: redondear(faltaKm, 1),
        progreso: redondear(Math.min(1, Math.max(0, s / this.largoM)), 3),
        paso_por: paso,
        proximo_hito: sigue,
        va_a_nutibara: va,
      };
    }

    // Lo fijo que dibuja la página: el recorrido, los hitos y de cuándo son los datos.
    paraLaPagina() {
      return {
        ruta: this.ruta,
        hitos: this.hitos.map(h => ({ ...h, progreso: redondear(h.km * 1000 / this.largoM, 3) })),
        largo_km: redondear(this.largoM / 1000, 1),
        viajes: this.modelo.viajes,
        desde: this.modelo.desde,
        hasta: this.modelo.hasta,
      };
    }
  }

  const api = { Tiempos, horaBonita, redondear };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.TiemposNutibara = api;
})(typeof window !== 'undefined' ? window : globalThis);

# Web pública — Llegadas Aeropuerto JMC

Página estática que muestra en tiempo real quién está esperando turno en el aeropuerto, leyendo la tabla `enturnamiento_actual` de Supabase.

## Cómo funciona

```
App Python (despachosautomaticos)  ──UPSERT──►  Supabase (enturnamiento_actual)  ──Realtime──►  Esta web
```

La web:
- Carga las filas actuales de Supabase al abrir.
- Se suscribe a Realtime: cualquier cambio se refleja al instante (sin polling).
- Refresca "hace X min" cada minuto sin pedir datos al servidor.

## Versión de los gestores (`gestores.html`, desde v1.30.0)

La misma app para los **gestores del aeropuerto**, con el mismo código (`window.MODO_GESTOR = true`):

- Entran con su **cédula**, sin clave y **sin sesión**, como en la app del Personal. Solo entra alguien VINCULADO con
  GESTOR en el cargo.
- Solo tienen **Mapa, Listas y Realizados** (Vuelos, Subida y Turnos van ocultas, para que sea liviana).
- **No despachan, no cancelan ni ocultan**: no hay botones, y sin sesión la base tampoco lo permite.
- En **Realizados** salen solo las salidas del aeropuerto de hoy. En cada una ponen cuántos pasajeros se fueron en ese
  bus (0 a 19, sin vuelo): va a la casilla "pasajeros" del despacho, la misma que ve el despachador, con constancia de
  quién y cuándo (`aeropuerto_gestor_pasajeros`). Arriba, un aviso dice qué buses salieron en las últimas 2 horas sin
  pasajeros.
- Lo que la app de los despachadores lee con sesión (despachos, contadores y flota), aquí sale por la función
  `aeropuerto_gestor_datos` (solo lectura).
- **Excel del día** (v1.32.0): el botón *Excel* de Realizados baja un `.xlsx` de un día de la operación (2:30 a 2:30),
  con la hoja *Salidas* (una fila por bus que salió del aeropuerto: día, hora, bus, placa, itinerario, a dónde va,
  pasajeros, estado, quién y cuándo) y la hoja *Resumen* (totales por itinerario). Lo arma el celular
  (`js/excel-xlsx.js`, sin librerías) con lo que trae `aeropuerto_gestor_dia(p_dni, p_fecha)`.
- **Se instala en el celular** como app aparte, "Gestores JMC", con ícono verde (`manifest-gestores.webmanifest`,
  `icons/gestores-*`). En Android sale el aviso "Instalar"; en el iPhone, la ayuda de "Compartir → Agregar a inicio".

## Pantalla Nutibara (`nutibara/`)

La pantalla del televisor de la **Terminal Nutibara**: los buses del 4503 (Aeropuerto → Túnel → Exposiciones →
Nutibara) y **en cuánto llega cada uno**. Se abre el enlace `…/nutibara/` en el televisor; no se instala nada.

- Cada 20 segundos le pide a Supabase la función `nutibara_pantalla()` (solo lee, sin sesión, **sin conductores**):
  número del bus, placa, dónde está, hora del GPS y hora del despacho. Esos datos los publica el programa de enturnes.
- **La hora de llegada la calcula el navegador** (`nutibara/tiempos.js`) con lo que tardaron de verdad los buses del
  4503 a esa misma hora del día (`nutibara/tiempos_nutibara.json`, 699 viajes): ubica al bus sobre el recorrido, mira
  cuántos km le faltan por la vía y busca cuánto se demoraron los que pasaron por ahí. Muestra lo normal y el rango.
- De noche casi ningún 4503 sigue de San Diego a Nutibara: esos salen aparte, "Se quedan en San Diego".
- Si los datos están viejos (el programa que publica se detuvo o el televisor no tiene internet) sale un aviso arriba.
- Se recarga sola cada 6 horas para tomar los cambios de la página.

## Probar localmente

Abre `aplicacion-aeropuerto.html` directamente en el navegador. **Pero hay una limitación**: los navegadores modernos no permiten `file://` para algunos features. Mejor levantar un servidor simple:

```powershell
cd web
python -m http.server 8000
```

Luego abre <http://localhost:8000> (redirige a `aplicacion-aeropuerto.html`) o directamente <http://localhost:8000/aplicacion-aeropuerto.html>.

## Publicar gratis en GitHub Pages

### Una vez

1. Crea un repositorio en GitHub (público o privado, GitHub Pages funciona en ambos para cuentas Pro; para gratis necesita ser público).
2. Sube el repositorio desde la carpeta `gestionycontrol/gestionycontrol/`:

   ```powershell
   cd c:\Users\coordesarrollo\Documents\gestionycontrol\gestionycontrol
   git init
   git add .
   git commit -m "Setup inicial"
   git branch -M main
   git remote add origin https://github.com/<tu-usuario>/<tu-repo>.git
   git push -u origin main
   ```

3. En GitHub: **Settings → Pages**:
   - **Source**: *Deploy from a branch*
   - **Branch**: `main` / `/web`
   - Guarda.

4. Espera ~1 minuto. Tu sitio estará en:
   `https://<tu-usuario>.github.io/<tu-repo>/`

### Actualizar

Cada vez que cambies algo en `web/`:

```powershell
git add web/
git commit -m "Actualizar web"
git push
```

GitHub Pages se redespliega automático en 1-2 minutos.

## Configuración

Edita [`js/config.js`](js/config.js) si cambia tu Supabase:

```javascript
window.APP_CONFIG = {
    SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
    SUPABASE_ANON_KEY: "tu_anon_key",
    TABLA: "enturnamiento_actual",
    TABLA_POSICIONES: "sonar_posiciones",
    MAP_CENTER: { lat: 6.170989, lng: -75.431152 },
    MAP_ZOOM: 14,
};
```

## Seguridad

La `SUPABASE_ANON_KEY` es **pública por diseño** — Supabase la creó para usar en navegadores. La protección está en **Row Level Security**:

- La tabla `enturnamiento_actual` tiene policy: cualquiera puede `SELECT`.
- Nadie puede `INSERT/UPDATE/DELETE` sin autenticarse (solo la app Python lo hace con credenciales).

Si alguien intentara escribir desde la web, Supabase rechaza con 401.

## Stack

- **Leaflet 1.9.4** — mapa con OpenStreetMap.
- **@supabase/supabase-js v2** — cliente Supabase con Realtime.
- HTML + CSS + JS vanilla, sin frameworks ni build.

## Archivos

```
web/
├── index.html                  Redirección a aplicacion-aeropuerto.html
├── aplicacion-aeropuerto.html  Página principal
├── gestores.html               Versión de los gestores (cédula, sin despachar, pasajeros)
├── css/gestores.css            Estilos que solo usa gestores.html
├── js/excel-xlsx.js            Arma el Excel (.xlsx) del día en la versión de los gestores
├── css/style.css               Estilos
├── js/config.js                Credenciales Supabase
├── nutibara/                   Pantalla del televisor de la Terminal Nutibara (en cuánto llega cada bus)
└── js/main.js                  Lógica (carga + render + realtime)
```

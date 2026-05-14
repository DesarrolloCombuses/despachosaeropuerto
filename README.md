# Web pública — Llegadas Aeropuerto JMC

Página estática que muestra en tiempo real las llegadas al aeropuerto leyendo la tabla `llegadas_104` de Supabase.

## Cómo funciona

```
App Python (tu PC)  ──UPSERT──►  Supabase (llegadas_104)  ──Realtime──►  Esta web
```

La web:
- Carga las filas actuales de Supabase al abrir.
- Se suscribe a Realtime: cualquier cambio se refleja al instante (sin polling).
- Refresca "hace X min" cada minuto sin pedir datos al servidor.

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
    TABLA: "llegadas_104",
    MAP_CENTER: { lat: 6.170989, lng: -75.431152 },
    MAP_ZOOM: 14,
};
```

## Seguridad

La `SUPABASE_ANON_KEY` es **pública por diseño** — Supabase la creó para usar en navegadores. La protección está en **Row Level Security**:

- La tabla `llegadas_104` tiene policy: cualquiera puede `SELECT`.
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
├── css/style.css               Estilos
├── js/config.js                Credenciales Supabase
└── js/main.js                  Lógica (carga + render + realtime)
```

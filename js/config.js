// Configuración Supabase para la web pública.
// Estas son las credenciales PÚBLICAS (anon key). Es seguro publicarlas
// siempre que la tabla enturnamiento_actual tenga Row Level Security
// activada con política de solo SELECT para el rol anon (y solo el
// backend autenticado puede insertar/actualizar/borrar).
window.APP_CONFIG = {
    // Versión visible de la app — debe coincidir con sw.js
    APP_VERSION: "v1.25.1",
    SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",
    // Espejo de "esperando turno" que escribe despachosautomaticos (turno FIFO
    // por hora de llegada confirmada, con corroboración GPS) -- reemplaza a
    // llegadas_104 (basada solo en el evento 104 de Sonar).
    TABLA: "enturnamiento_actual",
    // Posición GPS en vivo de TODA la flota (no solo los que están en fila).
    // Se usa para dibujar los buses de fondo en el mapa y para refinar la
    // posición de los que sí están en fila con el dato más fresco disponible.
    TABLA_POSICIONES: "sonar_posiciones",
    // Edge Function que asigna itinerario a un bus en Sonar
    SONAR_DISPATCH_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/sonar-dispatch",
    // Edge Function que consulta GET_DispatchedVehicles
    SONAR_DESPACHOS_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/sonar-despachos",
    // Edge Function que cancela un despacho en Sonar
    SONAR_CANCEL_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co/functions/v1/sonar-cancel",
    // Nombre de la tabla donde se guardan los despachos realizados
    TABLA_REALIZADOS: "despachos_realizados",
    // Tabla de vehículos para el despacho manual (columnas: ID, INTERNO, Placa)
    TABLA_VEHICULOS: "vehiculossonar",
    // Vuelos de Medellín (JMC) -- tablero de llegadas/salidas, sincronizado por un
    // proceso externo (ver columna updated_at). Solo se muestran los de tipo "llegada".
    TABLA_VUELOS: "vuelos_mde",
    // Conteo en vivo de "en camino ahora" por dirección e itinerario, que
    // sincroniza despachosautomaticos cada 2 minutos desde Sonar (running=Y) --
    // a diferencia de despachos_realizados.estado, que no se actualiza solo
    // cuando el bus termina el viaje.
    TABLA_RESUMEN_DIRECCIONES: "resumen_direcciones_actual",
    // Mismo cálculo que TABLA_RESUMEN_DIRECCIONES, pero una fila por vehículo --
    // permite filtrar los marcadores del mapa por dirección (subiendo/bajando).
    TABLA_DIRECCION_VEHICULOS: "direccion_vehiculo_actual",
    // Programación de turnos de conductores (quién, en qué vehículo, base y
    // puesto le corresponde cada día) -- se consulta solo el día actual.
    TABLA_PROGRAMACION_TURNOS: "programacion_turnos",
    // Buses ocultados a mano de la lista "esperando turno" (ver botón de ojo
    // tachado en Listas) -- para casos donde Sonar todavía no refleja que el
    // bus ya no está esperando turno de verdad.
    TABLA_ENTURNAMIENTO_OCULTOS: "enturnamiento_ocultos",
    // CSV publicado de Google Sheets con la nómina de conductores
    // Columnas: dr_id, cedula, fleet, nombre, status, email, celular
    CONDUCTORES_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vThNrFZLbNklMFtPeg0wF4TA1vZHnZ4YNMmGcnHfty_RoNuAQw__iV2GMXqTsv36MPiks1ARpYui1JK/pub?gid=0&single=true&output=csv",
    // Lookback por defecto (horas) para la pestaña Despachos
    DESPACHOS_LOOKBACK_HORAS: 5,
    // Solo se muestran los despachos cuyo itDesc esté en esta lista
    // (comparación insensible a mayúsculas y tildes).
    DESPACHOS_ITINERARIOS_PERMITIDOS: [
        "Nutibara-exposiciones-tunel-aeropuerto",
        "Aeropuerto-San Diego-Tunel",
        "Aeropuerto-autopista-terminalnorte",
    ],
    // Solo estos itinerarios aparecen en la pestaña "Subida" (comparación
    // insensible a mayúsculas y tildes, igual que DESPACHOS_ITINERARIOS_PERMITIDOS).
    SUBIDA_ITINERARIOS_PERMITIDOS: [
        "Almacentro-Tunel-Aeropuerto",
        "Terminalnorte-autopista-aeropuerto",
        "ccsandiego-tunel-aeropuerto",
        "Nutibara-exposiciones-tunel-aeropuerto",
    ],
    // Itinerarios disponibles para asignar (id se envía a Sonar)
    ITINERARIOS: [
        { id: "3385", grupo: "AEROPUERTO",   nombre: "Aeropuerto-San Diego-Tunel" },
        { id: "3387", grupo: "NUTIBARA",     nombre: "Nutibara-Aeropuerto-Autopista" },
        { id: "3394", grupo: "NUTIBARA",     nombre: "Nutibara-Aeropuerto-Variante Palmas" },
        { id: "3395", grupo: "SANDIEGO",     nombre: "San Diego-Aeropuerto-Variante Palmas" },
        { id: "4413", grupo: "AEROPUERTO",   nombre: "Aeropuerto-Exposiciones" },
        { id: "4501", grupo: "AEROPUERTO",   nombre: "Aeropuerto-autopista-terminalnorte" },
        { id: "4502", grupo: "EXPOSICIONES", nombre: "Nutibara-exposiciones-tunel-aeropuerto" },
        { id: "4503", grupo: "AEROPUERTO",   nombre: "Aeropuerto-Tunel-Exposiciones-Nutibara" },
        { id: "4507", grupo: "AEROPUERTO",   nombre: "Aeropuerto-Tunel-ccsandiego" },
        { id: "4505", grupo: "SANDIEGO",     nombre: "Almacentro-Tunel-Aeropuerto" },
    ],
    // Centro inicial del mapa (Aeropuerto JMC)
    MAP_CENTER: { lat: 6.170989, lng: -75.431152 },
    MAP_ZOOM: 14,
    // Geocercas dibujadas a mano en la pestaña Geocercas de despachosautomaticos
    // (proyecto fuente 2/nuevasgeocercas.json). Se dibujan aquí solo como
    // referencia visual: esta web pública no re-evalúa entradas/salidas, esa
    // lógica vive en el backend.
    GEOCERCAS: [
        {
            nombre: "aeropuerto",
            etiqueta: "Geocerca aeropuerto · cierra el último punto de control",
            color: "#10b981",
            puntos: [
                [6.170656, -75.431521], [6.170388, -75.431293], [6.170208, -75.430953], [6.170164, -75.430705],
                [6.170256, -75.430208], [6.17044, -75.429447], [6.17053, -75.429089], [6.170623, -75.428731],
                [6.17071, -75.42842], [6.170855, -75.428169], [6.171076, -75.428001], [6.171334, -75.427935],
                [6.171577, -75.427969], [6.171805, -75.428108], [6.171985, -75.428302], [6.172098, -75.428641],
                [6.172441, -75.428524], [6.172299, -75.428123], [6.172035, -75.427829], [6.171699, -75.427629],
                [6.171312, -75.427574], [6.170917, -75.427676], [6.170584, -75.427929], [6.170377, -75.428278],
                [6.170274, -75.428637], [6.17018, -75.429], [6.170089, -75.429361], [6.169903, -75.430132],
                [6.169803, -75.430687], [6.169869, -75.431078], [6.170102, -75.431514], [6.170419, -75.431794],
            ],
        },
        {
            nombre: "terminal norte",
            etiqueta: "Geocerca terminal norte · dispara auto-despacho",
            color: "#8b5cf6",
            puntos: [
                [6.28052295096143, -75.57157176868652], [6.280341655386259, -75.57104585134734],
                [6.279157900373026, -75.57142943479984], [6.279205890493458, -75.57166817762098],
            ],
        },
        {
            nombre: "nutibara",
            etiqueta: "Geocerca nutibara · dispara auto-despacho",
            color: "#0ea5e9",
            puntos: [
                [6.2535358776135075, -75.56697429033206], [6.2531092776240875, -75.56619643358307],
                [6.252272074133127, -75.56677487374421], [6.2526933422993025, -75.56738740968073],
            ],
        },
        {
            nombre: "patio azul",
            etiqueta: "Patio azul · zona de parqueo/espera junto a la terminal",
            color: "#2563eb",
            puntos: [
                [6.170869, -75.43202], [6.170869, -75.430948], [6.171548, -75.430948], [6.171548, -75.43202],
            ],
        },
    ],
};

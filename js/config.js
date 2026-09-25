// Configuración Supabase para la web pública.
// Estas son las credenciales PÚBLICAS (anon key). Es seguro publicarlas
// siempre que la tabla enturnamiento_actual tenga Row Level Security
// activada con política de solo SELECT para el rol anon (y solo el
// backend autenticado puede insertar/actualizar/borrar).
window.APP_CONFIG = {
    // Versión visible de la app — debe coincidir con sw.js
    APP_VERSION: "v1.26.0",
    SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",
    // ===========================================================
    // De dónde sale la fila de esta pantalla. En vez de la fila vieja
    // (enturnamiento_actual, que escribe el programa de despachos automáticos)
    // se lee la fila nueva, la que calcula el programa de enturnes con las
    // geocercas dibujadas y el cruce de la raya.
    //
    // Para devolverse, basta dejar estas dos líneas como estaban:
    //     TABLA: "enturnamiento_actual",
    //     SOLO_PUNTO: null,
    TABLA: "enturne_filas",
    // La tabla nueva guarda las filas de todos los puntos (Aeropuerto, Almacentro,
    // Nutibara...). Esta pantalla es la del aeropuerto, así que se pide solo ese.
    SOLO_PUNTO: "Aeropuerto",
    // ===========================================================
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
    // ===========================================================
    // El mapa del programa de enturnes: cada punto de llegada con su
    // color, su etiqueta, la RAYA que el bus tiene que cruzar para entrar a la
    // fila, y el circulo de espera (si sale de ahi mas de 30 min, pierde el turno).
    PUNTOS_ENTURNES: [
        { nombre: "Aeropuerto", color: "#7c3aed", lat: 6.17206, lon: -75.43245, zona_m: 550, linea: [[6.172235, -75.432133], [6.171885, -75.432767]], radio_m: null },
        { nombre: "Almacentro", color: "#0d9488", lat: 6.2372605, lon: -75.569844, zona_m: 350, linea: [[6.237515, -75.569528], [6.237006, -75.57016]], radio_m: null },
        { nombre: "Terminal Norte", color: "#db2777", lat: 6.27895, lon: -75.5721495, zona_m: 350, linea: [[6.279006, -75.572552], [6.278894, -75.571747]], radio_m: null },
        { nombre: "Nutibara", color: "#ea580c", lat: 6.252393, lon: -75.566849, zona_m: 350, linea: null, radio_m: 153 },
        { nombre: "Exposiciones", color: "#a16207", lat: 6.238996, lon: -75.572563, zona_m: 200, linea: null, radio_m: 120 },
    ],
    // Las zonas DIBUJADAS a mano (enturnes/zonas.json, version 5). Cuando el GPS
    // no alcanza a ver el cruce de la raya, entrar a una de estas cuenta como llegada.
    // Van del color del punto al que pertenecen.
    ZONAS_ENTURNES: [
        { nombre: "Patio Azul", punto: "Aeropuerto", color: "#7c3aed", puntos: [[6.170869, -75.43202], [6.170869, -75.430948], [6.171548, -75.430948], [6.171548, -75.43202]] },
        { nombre: "Lazo de llegadas", punto: "Aeropuerto", color: "#7c3aed", puntos: [[6.170656, -75.431521], [6.170388, -75.431293], [6.170208, -75.430953], [6.170164, -75.430705], [6.170256, -75.430208], [6.17044, -75.429447], [6.17053, -75.429089], [6.170623, -75.428731], [6.17071, -75.42842], [6.170855, -75.428169], [6.171076, -75.428001], [6.171334, -75.427935], [6.171577, -75.427969], [6.171805, -75.428108], [6.171985, -75.428302], [6.172098, -75.428641], [6.172441, -75.428524], [6.172299, -75.428123], [6.172035, -75.427829], [6.171699, -75.427629], [6.171312, -75.427574], [6.170917, -75.427676], [6.170584, -75.427929], [6.170377, -75.428278], [6.170274, -75.428637], [6.17018, -75.429], [6.170089, -75.429361], [6.169903, -75.430132], [6.169803, -75.430687], [6.169869, -75.431078], [6.170102, -75.431514], [6.170419, -75.431794]] },
        { nombre: "Almacentro (borrador)", punto: "Almacentro", color: "#0d9488", puntos: [[6.2355, -75.5719], [6.2373, -75.5719], [6.2373, -75.57], [6.2355, -75.57]] },
        { nombre: "Nutibara", punto: "Nutibara", color: "#ea580c", puntos: [[6.253536, -75.566974], [6.253109, -75.566196], [6.252272, -75.566775], [6.252693, -75.567387]] },
        { nombre: "Terminal Norte", punto: "Terminal Norte", color: "#db2777", puntos: [[6.280523, -75.571572], [6.280342, -75.571046], [6.279158, -75.571429], [6.279206, -75.571668]] },
        { nombre: "Exposiciones (borrador, ajustar)", punto: "Exposiciones", color: "#a16207", puntos: [[6.2396, -75.5731], [6.2394, -75.5718], [6.2386, -75.572], [6.2388, -75.5733]] },
        { nombre: "CC San Diego (bahia de despacho)", punto: "Almacentro", color: "#0d9488", puntos: [[6.2364, -75.5709], [6.2369, -75.5709], [6.2369, -75.5702], [6.23745, -75.5702], [6.23745, -75.5689], [6.2364, -75.5689]] },
    ],
    // ===========================================================
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

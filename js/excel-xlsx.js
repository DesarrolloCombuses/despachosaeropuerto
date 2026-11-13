/* =====================================================================================================================
   Excel (.xlsx) sin librerías de afuera (v1.32.0, versión de los gestores).
   Arma un libro con una o varias hojas: encabezado en la fila 1 (fijo al bajar y con filtro), una fila por registro,
   anchos de columna y cada dato con su tipo de verdad (fecha, hora, número o texto), para que se pueda filtrar,
   ordenar, sumar o hacer tablas dinámicas sin arreglar nada.

   XlsxSimple.libro({ titulo, hojas: [{ nombre, columnas: [{ titulo, ancho, tipo }], filas: [[...]], total: [...] }] })
     tipo: "texto" | "entero" | "decimal" | "fecha" | "hora" | "fechahora"
     fecha / hora / fechahora van como número de Excel (días desde 1900; ver XlsxSimple.serial*).
     null o "" deja la celda vacía. "total" es una fila final en negrilla (opcional, fuera del filtro).
   Devuelve un Blob listo para descargar.
   ===================================================================================================================== */
(function () {
    "use strict";

    const enc = new TextEncoder();

    // ---- ZIP sin comprimir (STORE): el .xlsx es un zip de archivos XML ----
    const TABLA_CRC = (function () {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(b) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < b.length; i++) c = TABLA_CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function zip(archivos) {
        const partes = [];
        const central = [];
        let off = 0;
        const ahora = new Date();
        const hora = (ahora.getHours() << 11) | (ahora.getMinutes() << 5) | (ahora.getSeconds() >> 1);
        const fecha = ((ahora.getFullYear() - 1980) << 9) | ((ahora.getMonth() + 1) << 5) | ahora.getDate();
        archivos.forEach(function (a) {
            const nom = enc.encode(a.nombre);
            const d = enc.encode(a.texto);
            const crc = crc32(d);
            const loc = new DataView(new ArrayBuffer(30));
            loc.setUint32(0, 0x04034b50, true);
            loc.setUint16(4, 20, true);
            loc.setUint16(10, hora, true);
            loc.setUint16(12, fecha, true);
            loc.setUint32(14, crc, true);
            loc.setUint32(18, d.length, true);
            loc.setUint32(22, d.length, true);
            loc.setUint16(26, nom.length, true);
            partes.push(new Uint8Array(loc.buffer), nom, d);
            const cen = new DataView(new ArrayBuffer(46));
            cen.setUint32(0, 0x02014b50, true);
            cen.setUint16(4, 20, true);
            cen.setUint16(6, 20, true);
            cen.setUint16(12, hora, true);
            cen.setUint16(14, fecha, true);
            cen.setUint32(16, crc, true);
            cen.setUint32(20, d.length, true);
            cen.setUint32(24, d.length, true);
            cen.setUint16(28, nom.length, true);
            cen.setUint32(42, off, true);
            central.push(new Uint8Array(cen.buffer), nom);
            off += 30 + nom.length + d.length;
        });
        const tamCentral = central.reduce(function (s, x) { return s + x.length; }, 0);
        const fin = new DataView(new ArrayBuffer(22));
        fin.setUint32(0, 0x06054b50, true);
        fin.setUint16(8, archivos.length, true);
        fin.setUint16(10, archivos.length, true);
        fin.setUint32(12, tamCentral, true);
        fin.setUint32(16, off, true);
        return new Blob(partes.concat(central, [new Uint8Array(fin.buffer)]),
            { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }

    // ---- XML ----
    function xml(s) {
        return String(s)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function letra(i) {           // 0 -> A, 25 -> Z, 26 -> AA
        let s = "";
        i += 1;
        while (i > 0) {
            const m = (i - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            i = Math.floor((i - 1) / 26);
        }
        return s;
    }

    // Estilos (cellXfs): el número es el "s" de cada celda
    const S = { texto: 0, encabezado: 1, fecha: 2, hora: 3, fechahora: 4, entero: 5, decimal: 6,
                totalTexto: 7, totalEntero: 8, totalDecimal: 9 };
    const ESTILOS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="4"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/>' +
        '<numFmt numFmtId="166" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="167" formatCode="0.0"/></numFmts>' +
        '<fonts count="3">' +
        '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
        '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
        '</fonts>' +
        '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE6F2F1"/><bgColor indexed="64"/></patternFill></fill>' +
        '</fills>' +
        '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        '<border><left/><right/><top/><bottom style="thin"><color rgb="FF0B5D57"/></bottom><diagonal/></border>' +
        '<border><left/><right/><top style="thin"><color rgb="FF0B5D57"/></top><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="10">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="2" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
        '<xf numFmtId="1" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
        '<xf numFmtId="167" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
        '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>';

    function celda(ref, valor, tipo, total) {
        if (valor === null || valor === undefined || valor === "" || (typeof valor === "number" && !isFinite(valor))) {
            return total ? `<c r="${ref}" s="${S.totalTexto}"/>` : "";
        }
        if (tipo === "texto" || typeof valor === "string") {
            return `<c r="${ref}" s="${total ? S.totalTexto : S.texto}" t="inlineStr"><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
        }
        let s = S[tipo] !== undefined ? S[tipo] : S.texto;
        if (total) s = tipo === "decimal" ? S.totalDecimal : S.totalEntero;
        return `<c r="${ref}" s="${s}"><v>${Number(valor)}</v></c>`;
    }

    function hojaXml(h, primera) {
        const n = h.columnas.length;
        const ultima = letra(n - 1);
        const filasDatos = h.filas.length;
        const finDatos = filasDatos + 1;
        const partes = [];
        partes.push(`<row r="1" ht="20" customHeight="1">` + h.columnas.map(function (c, i) {
            return `<c r="${letra(i)}1" s="${S.encabezado}" t="inlineStr"><is><t xml:space="preserve">${xml(c.titulo)}</t></is></c>`;
        }).join("") + `</row>`);
        h.filas.forEach(function (fila, k) {
            const r = k + 2;
            partes.push(`<row r="${r}">` + h.columnas.map(function (c, i) {
                return celda(letra(i) + r, fila[i], c.tipo, false);
            }).join("") + `</row>`);
        });
        let finTotal = finDatos;
        if (h.total) {
            finTotal = finDatos + 1;
            partes.push(`<row r="${finTotal}">` + h.columnas.map(function (c, i) {
                return celda(letra(i) + finTotal, h.total[i], c.tipo, true);
            }).join("") + `</row>`);
        }
        const cols = h.columnas.map(function (c, i) {
            return `<col min="${i + 1}" max="${i + 1}" width="${c.ancho || 12}" customWidth="1"/>`;
        }).join("");
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            `<dimension ref="A1:${ultima}${finTotal}"/>` +
            `<sheetViews><sheetView ${primera ? 'tabSelected="1" ' : ""}workbookViewId="0">` +
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
            '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
            '<sheetFormatPr defaultRowHeight="15"/>' +
            `<cols>${cols}</cols>` +
            `<sheetData>${partes.join("")}</sheetData>` +
            `<autoFilter ref="A1:${ultima}${finDatos}"/>` +
            '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
            '<pageSetup orientation="landscape"/>' +
            '</worksheet>';
    }

    function nombreHoja(s, usados) {
        let n = String(s || "Hoja").replace(/[\[\]:*?\/\\]/g, " ").trim().slice(0, 31) || "Hoja";
        let k = 2;
        const base = n;
        while (usados.has(n.toLowerCase())) n = (base.slice(0, 28) + " " + k++);
        usados.add(n.toLowerCase());
        return n;
    }

    function libro(opciones) {
        const usados = new Set();
        const hojas = opciones.hojas.map(function (h) { return Object.assign({}, h, { nombre: nombreHoja(h.nombre, usados) }); });
        const archivos = [];
        archivos.push({ nombre: "[Content_Types].xml", texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            hojas.map(function (_, i) {
                return `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
            }).join("") +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
            '</Types>' });
        archivos.push({ nombre: "_rels/.rels", texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
            '</Relationships>' });
        const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        archivos.push({ nombre: "docProps/core.xml", texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
            'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
            `<dc:title>${xml(opciones.titulo || "")}</dc:title><dc:creator>Combuses</dc:creator>` +
            `<dcterms:created xsi:type="dcterms:W3CDTF">${ahora}</dcterms:created>` +
            `<dcterms:modified xsi:type="dcterms:W3CDTF">${ahora}</dcterms:modified>` +
            '</cp:coreProperties>' });
        archivos.push({ nombre: "docProps/app.xml", texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
            '<Application>Microsoft Excel</Application></Properties>' });
        archivos.push({ nombre: "xl/workbook.xml", texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
            hojas.map(function (h, i) { return `<sheet name="${xml(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`; }).join("") +
            '</sheets><definedNames>' +
            hojas.map(function (h, i) {
                const ref = `'${h.nombre.replace(/'/g, "''")}'!$A$1:$${letra(h.columnas.length - 1)}$${h.filas.length + 1}`;
                return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xml(ref)}</definedName>`;
            }).join("") +
            '</definedNames></workbook>' });
        archivos.push({ nombre: "xl/_rels/workbook.xml.rels", texto: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            hojas.map(function (_, i) {
                return `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
            }).join("") +
            `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            '</Relationships>' });
        archivos.push({ nombre: "xl/styles.xml", texto: ESTILOS });
        hojas.forEach(function (h, i) {
            archivos.push({ nombre: `xl/worksheets/sheet${i + 1}.xml`, texto: hojaXml(h, i === 0) });
        });
        return zip(archivos);
    }

    // ---- Fechas como número de Excel, con la hora de Colombia (no la del celular) ----
    const PARTES_CO = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });

    function serialFechaHora(t) {           // un instante -> fecha y hora de Colombia
        const d = new Date(t);
        if (isNaN(d.getTime())) return null;
        const p = {};
        PARTES_CO.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
        const ms = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
        return ms / 86400000 + 25569;
    }

    function serialHora(t) {                // solo la hora (la parte de la fracción del día)
        const v = serialFechaHora(t);
        return v === null ? null : v - Math.floor(v);
    }

    function serialDia(ymd) {               // "2026-11-12" -> el día
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569 : null;
    }

    window.XlsxSimple = { libro: libro, serialFechaHora: serialFechaHora, serialHora: serialHora, serialDia: serialDia };
})();

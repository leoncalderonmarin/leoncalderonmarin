// =============================================================================
// Módulo de Control de Flota TAOS (fase 1)
// Operadores · Vehículos · Documentos · Kilometraje · Servicios · Gastos · Semáforos
//
// Se conecta desde server.js con:  require('./flota')({ app, cron, ... })
// Los datos se guardan en un archivo JSON dentro del disco persistente de Render.
//
// MODELO DE DATOS (versión 2)           relaciones: -> = «pertenece a» (por id)
//
//  operadores   { id, nombre, apellido1, apellido2, edad,
//                 domicilio{calle,numero,colonia,cp,estado}, celular, celularAlterno,
//                 licencia{numero,vigencia} }
//  vehiculos    { id, propietario('TAOS'|'Operador'), operadorId->operadores, marca, modelo, version,
//                 anio, placas(única), modificaciones, hojalateria,
//                 documentos{tarjeta,verificacion,seguro{vigencia,aseguradora,poliza}},
//                 agencia{va,agencia,garantiaKm,garantiaFecha},
//                 km{valor,fecha}  <- instantánea del último registro de kilometraje,
//                 servicios[{id,nombre,intervaloKm,intervaloMeses,ultimoKm,ultimaFecha,fuente}],
//                 danios[{id,tipo,descripcion,reportado,ingreso,salida}] }
//  kilometraje  [{ id, vehiculoId->vehiculos, fecha(AAAA-MM-DD), km, fuente, operadorId, nota }]
//                 un registro por unidad y por día (si se vuelve a capturar el mismo día, se reemplaza)
//  mantenimientos (bitácora) [{ id, vehiculoId->vehiculos, fecha, tipo('preventivo'|'correctivo'), km,
//                 descripcion, servicioIds[]->vehiculos.servicios, proveedor, enAgencia,
//                 refacciones, manoObra, total, folio, facturaTaos, notas }]
//  gastos       [{ id, fecha, vehiculoId->vehiculos, tipo, monto, concepto, proveedor, folio,
//                 facturaTaos, mantenimientoId->mantenimientos (si nació de la bitácora) }]
//  config       { umbralKmAmarillo, diasVerificacion, diasAvisoMinimo, kmDiarioMax }
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Utilidades de fechas y números
// ---------------------------------------------------------------------------

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function fechaValida(texto) {
    if (!FECHA_RE.test(texto || '')) return false;
    const d = new Date(texto + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

function diasEntre(desdeISO, hastaISO) {
    return Math.round((Date.parse(hastaISO + 'T00:00:00Z') - Date.parse(desdeISO + 'T00:00:00Z')) / 86400000);
}

function sumarMeses(iso, meses) {
    const [anio, mes, dia] = iso.split('-').map(Number);
    const total = (mes - 1) + meses;
    const anioNuevo = anio + Math.floor(total / 12);
    const mesNuevo = ((total % 12) + 12) % 12;
    const ultimoDia = new Date(Date.UTC(anioNuevo, mesNuevo + 1, 0)).getUTCDate();
    return `${anioNuevo}-${String(mesNuevo + 1).padStart(2, '0')}-${String(Math.min(dia, ultimoDia)).padStart(2, '0')}`;
}

// Acepta "12,500" o "12500.5"; devuelve null si no es un número válido
function numero(valor) {
    if (valor === undefined || valor === null || String(valor).trim() === '') return null;
    const n = parseFloat(String(valor).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

const texto = (valor, max = 120) => String(valor == null ? '' : valor).trim().slice(0, max);

// ---------------------------------------------------------------------------
// Semáforos (funciones puras, fáciles de probar)
//   🟢 verde: todo en orden
//   🟡 amarillo: documentos -> inicia el mes del vencimiento (la verificación ambiental, desde 60 días antes);
//                servicios  -> faltan 2,000 km o menos; daños -> reportado, antes de ingresar al taller
//   🔴 rojo: venció (el día del vencimiento ya cuenta), se rebasó el kilometraje, o la unidad está en el taller
//   ⚪ sin dato
// ---------------------------------------------------------------------------

const SEVERIDAD = { sin_dato: 0, verde: 1, amarillo: 2, rojo: 3 };
const PUNTO = { verde: '🟢', amarillo: '🟡', rojo: '🔴', sin_dato: '⚪' };

function peorNivel(niveles) {
    return niveles.reduce((peor, n) => (SEVERIDAD[n] > SEVERIDAD[peor] ? n : peor), 'sin_dato');
}

// Para el semáforo general de una unidad: lo que falta capturar cuenta como amarillo
function nivelGeneral(niveles) {
    const peor = peorNivel(niveles);
    if (niveles.includes('rojo')) return 'rojo';
    if (niveles.includes('amarillo') || niveles.includes('sin_dato')) return 'amarillo';
    return peor === 'sin_dato' ? 'amarillo' : 'verde';
}

function nivelPorFecha(vigencia, hoy, config = {}, diasExtra = 0) {
    if (!vigencia || !fechaValida(vigencia)) return { nivel: 'sin_dato', texto: 'Sin fecha capturada' };
    const dias = diasEntre(hoy, vigencia);
    if (dias <= 0) {
        return { nivel: 'rojo', dias, texto: dias === 0 ? 'Vence hoy' : `Vencido hace ${-dias} día(s)` };
    }
    const mismoMes = hoy.slice(0, 7) === vigencia.slice(0, 7);
    if (mismoMes || dias <= Math.max(diasExtra || 0, config.diasAvisoMinimo || 0)) {
        return { nivel: 'amarillo', dias, texto: `Vence en ${dias} día(s)` };
    }
    return { nivel: 'verde', dias, texto: `Vigente · faltan ${dias} días` };
}

function nivelServicio(servicio, kmActual, hoy, config = {}, promedio = null) {
    const sinIntervalo = !(numero(servicio.intervaloKm) > 0) && !(numero(servicio.intervaloMeses) > 0);
    if (sinIntervalo) {
        return { nivel: 'sin_dato', definido: false, texto: 'Sin intervalo definido (ver la especificación de la agencia)', proximoKm: null, proximaFecha: null };
    }
    const partes = [];
    const umbral = config.umbralKmAmarillo == null ? 2000 : config.umbralKmAmarillo;
    let proximoKm = null;
    let proximaFecha = null;

    if (numero(servicio.intervaloKm) > 0 && numero(servicio.ultimoKm) !== null) {
        proximoKm = numero(servicio.ultimoKm) + numero(servicio.intervaloKm);
        if (kmActual === null) {
            partes.push({ nivel: 'sin_dato', texto: 'Falta el kilometraje actual' });
        } else {
            const restante = proximoKm - kmActual;
            if (restante < 0) partes.push({ nivel: 'rojo', texto: `Rebasado por ${Math.abs(restante).toLocaleString('es-MX')} km` });
            else if (restante === 0) partes.push({ nivel: 'rojo', texto: 'Toca servicio ahora' });
            else {
                const estimado = promedio > 0 ? ` (~${Math.max(1, Math.round(restante / promedio))} día(s) a ${Math.round(promedio)} km/día)` : '';
                partes.push({ nivel: restante <= umbral ? 'amarillo' : 'verde', texto: `Faltan ${restante.toLocaleString('es-MX')} km${estimado}` });
            }
        }
    }

    if (numero(servicio.intervaloMeses) > 0 && fechaValida(servicio.ultimaFecha)) {
        proximaFecha = sumarMeses(servicio.ultimaFecha, numero(servicio.intervaloMeses));
        partes.push(nivelPorFecha(proximaFecha, hoy, config));
    }

    if (partes.length === 0) {
        return { nivel: 'sin_dato', definido: true, texto: 'Falta registrar el último servicio', proximoKm, proximaFecha };
    }
    const ordenadas = partes.slice().sort((a, b) => SEVERIDAD[b.nivel] - SEVERIDAD[a.nivel]);
    return { nivel: ordenadas[0].nivel, definido: true, texto: ordenadas.map(p => p.texto).join(' · '), proximoKm, proximaFecha };
}

// Ciclo de un daño físico: 🟡 desde que se reporta hasta el día de ingreso al taller,
// 🔴 mientras la unidad está en el taller, y al salir queda resuelto (🟢, ya no se muestra).
const TIPOS_DANIO = { hojalateria: 'Hojalatería', pintura: 'Pintura', ambos: 'Hojalatería y pintura' };

function nivelDanio(danio, hoy) {
    if (danio.salida && fechaValida(danio.salida) && diasEntre(hoy, danio.salida) <= 0) return null; // ya salió: resuelto
    const tipo = TIPOS_DANIO[danio.tipo] || 'Daño físico';
    const detalle = danio.descripcion ? ` · ${danio.descripcion}` : '';
    if (danio.ingreso && fechaValida(danio.ingreso) && diasEntre(hoy, danio.ingreso) <= 0) {
        return {
            nivel: 'rojo', etiqueta: `${tipo} · EN TALLER`,
            texto: `Ingresó el ${fechaCorta(danio.ingreso)}` + (danio.salida && fechaValida(danio.salida) ? ` · salida estimada ${fechaCorta(danio.salida)}` : ' · salida sin fecha') + detalle
        };
    }
    if (danio.ingreso && fechaValida(danio.ingreso)) {
        return { nivel: 'amarillo', etiqueta: `${tipo} · daño reportado`, texto: `Ingresa al taller el ${fechaCorta(danio.ingreso)} (faltan ${diasEntre(hoy, danio.ingreso)} día(s))${detalle}` };
    }
    return { nivel: 'amarillo', etiqueta: `${tipo} · daño reportado`, texto: `Falta la fecha de ingreso al taller${detalle}` };
}

const DOCUMENTOS_VEHICULO = [
    ['tarjeta', 'Tarjeta de circulación'],
    ['verificacion', 'Verificación ambiental'],
    ['seguro', 'Seguro']
];

function evaluarOperador(operador, hoy, config) {
    const r = nivelPorFecha(operador.licencia && operador.licencia.vigencia, hoy, config);
    return { etiqueta: 'Licencia de manejo', fecha: operador.licencia && operador.licencia.vigencia, ...r };
}

function evaluarVehiculo(vehiculo, operador, hoy, config, promedio = null) {
    const items = [];
    for (const [clave, nombre] of DOCUMENTOS_VEHICULO) {
        const doc = (vehiculo.documentos || {})[clave] || {};
        const diasExtra = clave === 'verificacion' ? (config.diasVerificacion == null ? 60 : config.diasVerificacion) : 0;
        items.push({ tipo: 'documento', etiqueta: nombre, fecha: doc.vigencia || '', ...nivelPorFecha(doc.vigencia, hoy, config, diasExtra) });
    }
    for (const danio of vehiculo.danios || []) {
        const r = nivelDanio(danio, hoy);
        if (r) items.push({ tipo: 'daño', ...r });
    }
    if (operador) {
        items.push({ tipo: 'documento', ...evaluarOperador(operador, hoy, config), etiqueta: `Licencia de ${operador.nombre}` });
    }
    const km = vehiculo.km && numero(vehiculo.km.valor) !== null ? numero(vehiculo.km.valor) : null;
    for (const servicio of vehiculo.servicios || []) {
        items.push({ tipo: 'servicio', etiqueta: servicio.nombre, ...nivelServicio(servicio, km, hoy, config, promedio) });
    }
    // Los servicios sin intervalo definido se muestran, pero no cuentan para el semáforo general
    const agencia = { va: Boolean(vehiculo.agencia && vehiculo.agencia.va), ...(vehiculo.agencia || {}) };
    return { nivel: nivelGeneral(items.filter(i => i.definido !== false).map(i => i.nivel)), items, agencia };
}

// ---------------------------------------------------------------------------
// Servicios de arranque. OJO: son valores GENÉRICOS, no de fábrica de cada modelo.
// Deben corregirse con el manual de cada unidad (por eso se marca la fuente).
// ---------------------------------------------------------------------------

function serviciosPorDefecto() {
    // [nombre, cada km, cada meses]  (null = sin intervalo definido: se captura según la agencia)
    const base = [
        ['Aceite y filtro de motor', 10000, 12],
        ['Filtro de aire', 20000, 24],
        ['Filtro de cabina', 20000, 12],
        ['Filtro de combustible', 40000, 48],
        ['Bujías', 40000, 48],
        ['Cadena / banda de distribución', null, null],
        ['Anticongelante', 60000, 36],
        ['Aceite de transmisión', 60000, 48],
        ['Líquido de frenos', null, 24],
        ['Revisión de frenos', 20000, 12]
    ];
    return base.map(([nombre, km, meses]) => ({
        id: nuevoId('srv'), nombre, intervaloKm: km, intervaloMeses: meses,
        ultimoKm: null, ultimaFecha: '', fuente: 'genérico (verificar con la especificación de la agencia)'
    }));
}

function nuevoId(prefijo) {
    return `${prefijo}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const esc = (valor) => String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ESTILOS = `<style>
 body{font-family:Arial,sans-serif;background:#f4f4f9;color:#222;margin:0;padding:14px;max-width:980px;margin:0 auto}
 h1{margin:4px 0 2px;font-size:22px} h2{font-size:18px;margin:18px 0 8px} h3{font-size:15px;margin:12px 0 6px}
 .sub{color:#555;font-size:13px;margin-bottom:10px}
 table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
 th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top} th{background:#eef0f4}
 .resumen{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
 .chip{background:#fff;border:1px solid #ddd;border-radius:10px;padding:8px 14px;font-weight:bold;font-size:15px}
 .tarjeta,details{background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px;margin:10px 0}
 summary{font-weight:bold;cursor:pointer}
 label{display:block;font-size:13px;color:#444;margin-top:8px}
 input,select,textarea{width:100%;box-sizing:border-box;padding:9px;font-size:16px;border:1px solid #bbb;border-radius:6px;margin-top:3px}
 button,.boton{display:inline-block;margin-top:10px;padding:10px 14px;font-size:15px;border:0;border-radius:6px;background:#1d4ed8;color:#fff;text-decoration:none}
 .peligro{background:#b91c1c} .gris{background:#475569}
 .rojo{color:#b91c1c;font-weight:bold} .amarillo{color:#a16207;font-weight:bold} .verde{color:#15803d} .sin_dato{color:#6b7280}
 .aviso{background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:8px;margin:8px 0}
 .error{background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:8px;margin:8px 0}
 .pequeno{font-size:12px;color:#666}
 .interruptor{display:flex;align-items:center;gap:12px;font-size:15px;margin-top:4px}
 .interruptor input{-webkit-appearance:none;appearance:none;width:54px;height:30px;min-width:54px;border-radius:30px;background:#dc2626;position:relative;margin:0;padding:0;border:0;transition:.2s}
 .interruptor input::after{content:'';position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:.2s}
 .interruptor input:checked{background:#16a34a} .interruptor input:checked::after{left:27px}
 @media print{.noimprimir{display:none} body{background:#fff;padding:0} .tarjeta,details{border:0}}
</style>`;

const pagina = (titulo, cuerpo) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>${ESTILOS}</head><body>${cuerpo}</body></html>`;

const campo = (etiqueta, nombre, valor = '', extra = '') =>
    `<label>${esc(etiqueta)}<input name="${nombre}" value="${esc(valor)}" ${extra}></label>`;
const campoFecha = (etiqueta, nombre, valor = '') => campo(etiqueta, nombre, valor, 'type="date"');
const campoNumero = (etiqueta, nombre, valor = '') => campo(etiqueta, nombre, valor, 'inputmode="decimal"');
const area = (etiqueta, nombre, valor = '') =>
    `<label>${esc(etiqueta)}<textarea name="${nombre}" rows="3" maxlength="600">${esc(valor)}</textarea></label>`;
const selector = (etiqueta, nombre, opciones, valor) =>
    `<label>${esc(etiqueta)}<select name="${nombre}">${opciones.map(([v, t]) =>
        `<option value="${esc(v)}"${String(v) === String(valor) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;

const insigniaAgencia = (a = {}) => a.va
    ? `<div class="pequeno">Agencia: 🟢 <b>SÍ</b>${a.agencia ? ' · ' + esc(a.agencia) : ''}${a.garantiaKm != null ? ' · garantía hasta ' + Number(a.garantiaKm).toLocaleString('es-MX') + ' km' : ''}${a.garantiaFecha ? ' / ' + esc(fechaCorta(a.garantiaFecha)) : ''}</div>`
    : '<div class="pequeno">Agencia: 🔴 NO</div>';

const nombreCompleto = (o) => [o.nombre, o.apellido1, o.apellido2].filter(Boolean).join(' ');
const nombreUnidad = (v) => [v.marca, v.modelo, v.anio].filter(Boolean).join(' ') + (v.placas ? ` (${v.placas})` : '');
const fechaCorta = (iso) => (iso && fechaValida(iso)) ? iso.split('-').reverse().join('/') : '—';

// ---------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------

module.exports = function iniciarFlota(contexto) {
    const {
        app, cron, zonaHoraria = 'America/Mexico_City',
        tokenAdmin = '', tokenVisor = '', rutaDatos,
        whatsappListo = () => false, enviarTexto = async () => {},
        destinoAlertas = '', urlPublica = '', ahora = () => new Date()
    } = contexto;

    const hoyISO = () => ahora().toLocaleDateString('en-CA', { timeZone: zonaHoraria });
    const fechaLarga = () => ahora().toLocaleDateString('es-MX', { timeZone: zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // ----- Datos en disco -----
    const CONFIG_BASE = { umbralKmAmarillo: 2000, diasVerificacion: 60, diasAvisoMinimo: 0, kmDiarioMax: 1000 };

    function cargar() {
        try {
            const crudo = JSON.parse(fs.readFileSync(rutaDatos, 'utf8'));
            const vehiculos = crudo.vehiculos || {};
            let kilometraje = Array.isArray(crudo.kilometraje) ? crudo.kilometraje : null;

            // Migración desde la versión 1: el historial de km estaba dentro de cada unidad
            if (!kilometraje) {
                kilometraje = [];
                for (const v of Object.values(vehiculos)) {
                    const porDia = new Map();
                    ((v.km && v.km.historial) || []).forEach(h => {
                        if (h && fechaValida(h.fecha) && numero(h.valor) !== null) porDia.set(h.fecha, numero(h.valor));
                    });
                    porDia.forEach((km, fecha) => kilometraje.push({
                        id: nuevoId('km'), vehiculoId: v.id, fecha, km, fuente: 'migrado', operadorId: '', nota: '', creado: new Date().toISOString()
                    }));
                    v.km = { valor: v.km && v.km.valor != null ? v.km.valor : null, fecha: (v.km && v.km.fecha) || '' };
                }
            }
            return {
                version: 2,
                operadores: crudo.operadores || {},
                vehiculos,
                kilometraje,
                mantenimientos: Array.isArray(crudo.mantenimientos) ? crudo.mantenimientos : [],
                gastos: Array.isArray(crudo.gastos) ? crudo.gastos : [],
                config: { ...CONFIG_BASE, ...(crudo.config || {}) }
            };
        } catch (error) {
            return { version: 2, operadores: {}, vehiculos: {}, kilometraje: [], mantenimientos: [], gastos: [], config: { ...CONFIG_BASE } };
        }
    }

    let datos = cargar();

    function guardar() {
        try {
            fs.mkdirSync(path.dirname(rutaDatos), { recursive: true });
            const temporal = rutaDatos + '.tmp';
            fs.writeFileSync(temporal, JSON.stringify(datos, null, 2), 'utf8');
            fs.renameSync(temporal, rutaDatos);
        } catch (error) {
            console.warn('⚠️ No se pudo guardar el archivo de flota:', error.message);
        }
    }

    // ----- Kilometraje diario: un registro por unidad y por día -----
    const fmt = (n) => Number(n).toLocaleString('es-MX');
    const kmDe = (vehiculoId) => datos.kilometraje.filter(e => e.vehiculoId === vehiculoId).sort((a, b) => a.fecha.localeCompare(b.fecha));

    function refrescarKm(vehiculo) {
        const lista = kmDe(vehiculo.id);
        const ultimo = lista[lista.length - 1];
        vehiculo.km = ultimo ? { valor: ultimo.km, fecha: ultimo.fecha } : { valor: null, fecha: '' };
    }

    // Devuelve { error } o { entrada }. Valida contra el registro anterior y el siguiente de la unidad.
    function registrarKm(vehiculo, fecha, km, opciones = {}) {
        const { fuente = 'manual', operadorId = '', nota = '', forzar = false } = opciones;
        if (km === null || km < 0) return { error: 'Escribe un kilometraje válido.' };
        if (!fechaValida(fecha)) return { error: 'La fecha no es válida.' };
        if (fecha > hoyISO()) return { error: 'La fecha del kilometraje no puede ser futura.' };

        const otros = kmDe(vehiculo.id).filter(e => e.fecha !== fecha);
        const previo = otros.filter(e => e.fecha < fecha).pop();
        const siguiente = otros.find(e => e.fecha > fecha);
        if (!forzar) {
            if (previo && km < previo.km) {
                return { error: `El kilometraje (${fmt(km)}) es menor al registrado el ${fechaCorta(previo.fecha)} (${fmt(previo.km)}). Si es una corrección, marca la casilla.` };
            }
            if (siguiente && km > siguiente.km) {
                return { error: `El kilometraje (${fmt(km)}) es mayor al registrado el ${fechaCorta(siguiente.fecha)} (${fmt(siguiente.km)}). Si es una corrección, marca la casilla.` };
            }
            if (previo) {
                const dias = Math.max(1, diasEntre(previo.fecha, fecha));
                const maximo = datos.config.kmDiarioMax || 1000;
                if ((km - previo.km) / dias > maximo) {
                    return { error: `Recorrido de ${fmt(Math.round((km - previo.km) / dias))} km por día desde el ${fechaCorta(previo.fecha)}: parece un error de captura (máximo ${fmt(maximo)}). Si es correcto, marca la casilla.` };
                }
            }
        }
        const entrada = { id: nuevoId('km'), vehiculoId: vehiculo.id, fecha, km, fuente, operadorId, nota: texto(nota, 200), creado: new Date().toISOString() };
        datos.kilometraje = datos.kilometraje.filter(e => !(e.vehiculoId === vehiculo.id && e.fecha === fecha));
        datos.kilometraje.push(entrada);
        refrescarKm(vehiculo);
        return { entrada };
    }

    // Promedio de km por día en los últimos 30 días (null si no hay al menos dos registros útiles)
    function promedioDiario(vehiculoId, hoy) {
        const lista = kmDe(vehiculoId).filter(e => diasEntre(e.fecha, hoy) <= 30);
        if (lista.length < 2) return null;
        const primero = lista[0], ultimo = lista[lista.length - 1];
        const dias = diasEntre(primero.fecha, ultimo.fecha);
        const promedio = dias > 0 ? (ultimo.km - primero.km) / dias : 0;
        return promedio > 0 ? promedio : null;
    }

    // ----- Accesos -----
    const iguales = (a, b) => {
        const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
        return A.length === B.length && crypto.timingSafeEqual(A, B);
    };

    function rolDe(token) {
        if (!token) return null;
        if (tokenAdmin && iguales(token, tokenAdmin)) return 'admin';
        if (tokenVisor && iguales(token, tokenVisor)) return 'visor';
        return null;
    }

    // minimo: 'visor' (lectura: admin o visor) o 'admin' (escritura)
    function exigir(res, token, minimo) {
        if (!tokenAdmin) {
            res.status(503).send('Deshabilitado: define la variable ADMIN_TOKEN en Render.');
            return null;
        }
        const rol = rolDe(token);
        if (!rol || (minimo === 'admin' && rol !== 'admin')) {
            res.status(rol ? 403 : 401).send(rol ? 'Esta clave solo permite consultar.' : 'Token incorrecto.');
            return null;
        }
        return rol;
    }

    // ----- Evaluación de toda la flota -----
    function evaluarFlota() {
        const hoy = hoyISO();
        const filas = Object.values(datos.vehiculos).map(vehiculo => {
            const operador = vehiculo.operadorId ? datos.operadores[vehiculo.operadorId] : null;
            const promedio = promedioDiario(vehiculo.id, hoy);
            return { vehiculo, operador, promedio, ...evaluarVehiculo(vehiculo, operador, hoy, datos.config, promedio) };
        });
        filas.sort((a, b) => SEVERIDAD[b.nivel] - SEVERIDAD[a.nivel] || nombreUnidad(a.vehiculo).localeCompare(nombreUnidad(b.vehiculo)));
        return { hoy, filas };
    }

    const ETIQUETA_TIPO = { preventivo: 'Preventivo', correctivo: 'Correctivo' };
    const dineroFmt = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bitacoraDe = (vehiculoId) => datos.mantenimientos.filter(m => m.vehiculoId === vehiculoId).sort((a, b) => b.fecha.localeCompare(a.fecha) || String(b.creado).localeCompare(String(a.creado)));

    function ultimosMantenimientos(vehiculoId) {
        const lista = bitacoraDe(vehiculoId).slice(0, 3);
        if (!lista.length) return '<div class="pequeno">Bitácora: sin mantenimientos registrados.</div>';
        return `<div class="pequeno"><b>Últimos mantenimientos:</b> ${lista.map(m =>
            `${esc(fechaCorta(m.fecha))} · ${esc(ETIQUETA_TIPO[m.tipo] || m.tipo)} · ${esc(m.descripcion || (m.servicios || []).join(', '))}${m.km != null ? ' · ' + esc(fmt(m.km)) + ' km' : ''}`).join(' | ')}</div>`;
    }

    // ----- Tablero (para Doña Tania: solo lectura) -----
    function paginaTablero(token, rol) {
        const { hoy, filas } = evaluarFlota();
        const conteo = { rojo: 0, amarillo: 0, verde: 0 };
        filas.forEach(f => { conteo[f.nivel]++; });

        const filasHtml = filas.map(f => {
            const pendientes = f.items.filter(i => i.nivel !== 'verde');
            const km = f.vehiculo.km && f.vehiculo.km.valor != null
                ? `${Number(f.vehiculo.km.valor).toLocaleString('es-MX')} km<div class="pequeno">${esc(fechaCorta(f.vehiculo.km.fecha))}</div>` : '—';
            const operador = f.operador
                ? `${esc(nombreCompleto(f.operador))}${f.operador.celular ? `<div class="pequeno"><a href="tel:${esc(f.operador.celular)}">${esc(f.operador.celular)}</a></div>` : ''}` : '—';
            return `<tr>
                <td><b>${esc(nombreUnidad(f.vehiculo))}</b><div class="pequeno">${esc(f.vehiculo.propietario === 'Operador' ? 'Propiedad del operador' : 'Propiedad de TAOS')}</div>${insigniaAgencia(f.agencia)}</td>
                <td>${operador}</td><td>${km}</td>
                <td style="font-size:22px;text-align:center">${PUNTO[f.nivel]}</td>
                <td>${pendientes.length ? pendientes.map(i => `<div class="${i.nivel}">${PUNTO[i.nivel]} ${esc(i.etiqueta)}: ${esc(i.texto)}${f.agencia.va && i.tipo === 'servicio' ? ' → en agencia' : ''}</div>`).join('') : '<span class="verde">Todo en orden</span>'}</td>
            </tr>`;
        }).join('');

        const detalle = filas.map(f => `
            <div class="tarjeta"><h3>${PUNTO[f.nivel]} ${esc(nombreUnidad(f.vehiculo))}</h3>
            <div class="pequeno">Kilometraje: ${f.vehiculo.km && f.vehiculo.km.valor != null ? esc(fmt(f.vehiculo.km.valor)) + ' km (' + esc(fechaCorta(f.vehiculo.km.fecha)) + ')' : 'sin registro'}
              · Promedio últimos 30 días: ${f.promedio ? esc(fmt(Math.round(f.promedio))) + ' km/día' : 'sin datos suficientes'}</div>
            <table><tr><th>Concepto</th><th>Fecha / próximo</th><th>Estado</th></tr>
            ${f.items.map(i => `<tr><td>${esc(i.etiqueta)}</td><td>${esc(i.tipo === 'servicio'
                ? [i.proximoKm != null ? `${Number(i.proximoKm).toLocaleString('es-MX')} km` : '', i.proximaFecha ? fechaCorta(i.proximaFecha) : ''].filter(Boolean).join(' · ') || '—'
                : fechaCorta(i.fecha))}</td><td class="${i.nivel}">${PUNTO[i.nivel]} ${esc(i.texto)}</td></tr>`).join('')}
            </table>${ultimosMantenimientos(f.vehiculo.id)}</div>`).join('');

        const mes = hoy.slice(0, 7);
        const gastosMes = datos.gastos.filter(g => (g.fecha || '').slice(0, 7) === mes);
        const totalMes = gastosMes.reduce((s, g) => s + (g.monto || 0), 0);
        const porUnidad = {};
        gastosMes.forEach(g => {
            const v = datos.vehiculos[g.vehiculoId];
            const clave = v ? nombreUnidad(v) : 'Sin unidad';
            porUnidad[clave] = (porUnidad[clave] || 0) + (g.monto || 0);
        });
        const dinero = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        return pagina('Control de flota · TAOS', `
            <div class="noimprimir"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
            ${rol === 'admin' ? `<a class="boton gris" href="/flota/admin?token=${encodeURIComponent(token)}">⚙️ Administrar</a>` : ''}</div>
            <h1>Control de flota · TAOS</h1>
            <div class="sub">Corte: ${esc(fechaLarga())}</div>
            <div class="resumen"><div class="chip">🔴 ${conteo.rojo} atención</div><div class="chip">🟡 ${conteo.amarillo} próximos</div><div class="chip">🟢 ${conteo.verde} en orden</div><div class="chip">🏢 ${filas.filter(f => f.agencia.va).length} en agencia</div></div>
            ${filas.length ? `<table><tr><th>Unidad</th><th>Operador</th><th>Km</th><th>Estado</th><th>Pendientes</th></tr>${filasHtml}</table>` : '<p>Aún no hay unidades registradas.</p>'}
            <h2>Detalle por unidad</h2>${detalle || ''}
            <h2>Gastos del mes (${esc(mes)})</h2>
            <p><b>Total: ${esc(dinero(totalMes))}</b> · ${gastosMes.length} registro(s)
            <span class="noimprimir"> · <a href="/flota/gastos.csv?token=${encodeURIComponent(token)}">Descargar todos en CSV</a></span></p>
            ${Object.keys(porUnidad).length ? `<table><tr><th>Unidad</th><th>Gasto del mes</th></tr>${Object.entries(porUnidad).map(([u, m]) => `<tr><td>${esc(u)}</td><td>${esc(dinero(m))}</td></tr>`).join('')}</table>` : ''}
            <p class="pequeno">Semáforo: 🟡 documentos desde el mes del vencimiento (verificación desde ${esc(datos.config.diasVerificacion)} días antes), servicios a ${esc(Number(datos.config.umbralKmAmarillo).toLocaleString('es-MX'))} km o menos, daño reportado antes de entrar al taller · 🔴 vencido, kilometraje rebasado o unidad en el taller · ⚪ falta capturar el dato (cuenta como 🟡 en la unidad) o sin intervalo definido.</p>`);
    }

    // ----- Administración (solo admin) -----
    function paginaAdmin(token, consulta = {}) {
        const t = encodeURIComponent(token);
        const campoToken = `<input type="hidden" name="token" value="${esc(token)}">`;
        const operadores = Object.values(datos.operadores);
        const vehiculos = Object.values(datos.vehiculos);
        const op = consulta.operador ? datos.operadores[consulta.operador] : null;
        const veh = consulta.vehiculo ? datos.vehiculos[consulta.vehiculo] : null;
        const opcionesOperador = [['', '— Sin operador —'], ...operadores.map(o => [o.id, nombreCompleto(o)])];
        const opcionesVehiculo = vehiculos.map(v => [v.id, nombreUnidad(v)]);
        const aviso = consulta.ok ? `<div class="aviso">✅ ${esc(consulta.ok)}</div>` : '';
        const error = consulta.error ? `<div class="error">⚠️ ${esc(consulta.error)}</div>` : '';

        const formOperador = (o = {}) => `
            <form method="post" action="/flota/operadores/guardar">${campoToken}<input type="hidden" name="id" value="${esc(o.id || '')}">
            ${campo('Nombre', 'nombre', o.nombre)}${campo('Primer apellido', 'apellido1', o.apellido1)}${campo('Segundo apellido', 'apellido2', o.apellido2)}
            ${campoNumero('Edad', 'edad', o.edad)}
            ${campo('Calle', 'calle', (o.domicilio || {}).calle)}${campo('Número', 'numeroDom', (o.domicilio || {}).numero)}${campo('Colonia', 'colonia', (o.domicilio || {}).colonia)}
            ${campo('Código postal', 'cp', (o.domicilio || {}).cp, 'inputmode="numeric"')}${campo('Estado', 'estado', (o.domicilio || {}).estado)}
            ${campo('Celular principal', 'celular', o.celular, 'inputmode="tel"')}${campo('Teléfono alterno', 'celularAlterno', o.celularAlterno, 'inputmode="tel"')}
            ${campo('Número de licencia (opcional)', 'licenciaNumero', (o.licencia || {}).numero)}${campoFecha('Vigencia de la licencia', 'licenciaVigencia', (o.licencia || {}).vigencia)}
            <button type="submit">Guardar operador</button></form>`;

        const formVehiculo = (v = {}) => {
            const d = v.documentos || {};
            return `
            <form method="post" action="/flota/vehiculos/guardar">${campoToken}<input type="hidden" name="id" value="${esc(v.id || '')}">
            ${selector('Propietario', 'propietario', [['TAOS', '1 · TAOS'], ['Operador', '2 · Operador']], v.propietario || 'TAOS')}
            ${selector('Operador asignado', 'operadorId', opcionesOperador, v.operadorId || '')}
            ${campo('Marca', 'marca', v.marca)}${campo('Modelo', 'modelo', v.modelo)}${campo('Versión de fábrica', 'version', v.version)}
            ${campoNumero('Año de fabricación', 'anio', v.anio)}${campo('Placas', 'placas', v.placas)}
            ${area('Modificaciones', 'modificaciones', v.modificaciones)}${area('Detalles de hojalatería', 'hojalateria', v.hojalateria)}
            <div class="tarjeta"><label class="interruptor"><input type="checkbox" name="vaAgencia" value="1"${(v.agencia || {}).va ? ' checked' : ''}>
              <span><b>Es automóvil nuevo y va a la agencia</b><br><span class="pequeno">Lo define Don Oscar · verde = sí · rojo = no</span></span></label>
              ${campo('Agencia (nombre)', 'agencia', (v.agencia || {}).agencia)}
              ${campoNumero('Garantía hasta (km) · por confirmar', 'garantiaKm', (v.agencia || {}).garantiaKm)}
              ${campoFecha('Garantía hasta (fecha) · por confirmar', 'garantiaFecha', (v.agencia || {}).garantiaFecha)}</div>
            ${campoFecha('Tarjeta de circulación · vigencia', 'tarjeta', (d.tarjeta || {}).vigencia)}
            ${campoFecha('Verificación ambiental · vigencia', 'verificacion', (d.verificacion || {}).vigencia)}
            ${campo('Aseguradora', 'aseguradora', (d.seguro || {}).aseguradora)}${campo('Póliza', 'poliza', (d.seguro || {}).poliza)}
            ${campoFecha('Seguro · vigencia', 'seguro', (d.seguro || {}).vigencia)}
            ${v.id ? '' : campoNumero('Kilometraje actual (odómetro)', 'km')}
            <button type="submit">Guardar vehículo</button></form>`;
        };

        const formServicios = (v) => {
            const filas = (v.servicios || []).concat([{}, {}, {}]);
            return `
            <h3>Servicios y frecuencias de ${esc(nombreUnidad(v))}</h3>
            <p class="pequeno">Los valores iniciales son genéricos, no de fábrica: corrígelos con el manual de la unidad. Deja el nombre vacío para quitar un servicio.</p>
            <form method="post" action="/flota/vehiculos/servicios">${campoToken}<input type="hidden" name="vehiculoId" value="${esc(v.id)}"><input type="hidden" name="n" value="${filas.length}">
            ${filas.map((s, i) => `<div class="tarjeta"><input type="hidden" name="s${i}_id" value="${esc(s.id || '')}">
                ${campo('Servicio', `s${i}_nombre`, s.nombre)}
                ${campoNumero('Cada (km)', `s${i}_km`, s.intervaloKm)}${campoNumero('Cada (meses)', `s${i}_meses`, s.intervaloMeses)}
                ${campoNumero('Último servicio · km', `s${i}_ultimoKm`, s.ultimoKm)}${campoFecha('Último servicio · fecha', `s${i}_ultimaFecha`, s.ultimaFecha)}
                ${s.fuente ? `<div class="pequeno">Fuente: ${esc(s.fuente)}</div>` : ''}</div>`).join('')}
            <button type="submit">Guardar servicios</button></form>`;
        };

        const formDanios = (v) => {
            const hoy = hoyISO();
            const camposDanio = (d = {}) => `
                ${selector('Tipo', 'tipo', Object.entries(TIPOS_DANIO), d.tipo || 'hojalateria')}
                ${area('Descripción del daño', 'descripcion', d.descripcion)}
                ${campoFecha('Fecha en que se reportó (vacío = hoy)', 'reportado', d.reportado)}
                ${campoFecha('Ingresa al taller el', 'ingreso', d.ingreso)}
                ${campoFecha('Salida estimada o real', 'salida', d.salida)}`;
            const existentes = (v.danios || []).map(d => {
                const r = nivelDanio(d, hoy);
                return `<div class="tarjeta"><b>${r ? PUNTO[r.nivel] + ' ' + esc(r.etiqueta) + ': ' + esc(r.texto) : '✅ Resuelto · salió el ' + esc(fechaCorta(d.salida))}</b>
                <form method="post" action="/flota/danios/guardar">${campoToken}<input type="hidden" name="vehiculoId" value="${esc(v.id)}"><input type="hidden" name="id" value="${esc(d.id)}">${camposDanio(d)}
                <button type="submit" name="accion" value="guardar">Guardar cambios</button>
                <button type="submit" name="accion" value="salida_hoy" class="gris">Salió del taller hoy</button>
                <button type="submit" name="accion" value="eliminar" class="peligro" onclick="return confirm('¿Eliminar este registro?')">Eliminar</button></form></div>`;
            }).join('');
            return `<h3>🛠️ Daños de hojalatería y pintura</h3>
                <p class="pequeno">🟡 desde que se reporta hasta el día de ingreso al taller · 🔴 mientras está en el taller · al registrar la salida queda resuelto.</p>
                ${existentes}
                <details><summary>➕ Reportar un daño nuevo</summary>
                <form method="post" action="/flota/danios/guardar">${campoToken}<input type="hidden" name="vehiculoId" value="${esc(v.id)}">${camposDanio()}
                <button type="submit" name="accion" value="guardar">Guardar daño</button></form></details>`;
        };

        const formBitacora = (v) => {
            const lista = bitacoraDe(v.id).slice(0, 10);
            return `<h3>🔧 Bitácora de mantenimiento</h3>
              <details><summary>➕ Registrar mantenimiento</summary>
              <form method="post" action="/flota/mantenimientos/guardar">${campoToken}<input type="hidden" name="vehiculoId" value="${esc(v.id)}">
              ${selector('Tipo', 'tipo', [['preventivo', 'Preventivo'], ['correctivo', 'Correctivo']], 'preventivo')}
              ${campoFecha('Fecha (vacío = hoy)', 'fecha')}${campoNumero('Kilometraje al hacerlo (vacío = actual)', 'km')}
              ${area('Descripción del trabajo', 'descripcion')}
              <label>Servicios del programa que se realizaron (reinician su conteo)</label>
              ${(v.servicios || []).map(sv => `<label style="display:flex;gap:8px;align-items:center;margin:2px 0"><input type="checkbox" name="servicios" value="${esc(sv.id)}" style="width:auto;margin:0"> ${esc(sv.nombre)}</label>`).join('') || '<p class="pequeno">Esta unidad no tiene servicios en su programa.</p>'}
              ${campo('Taller o agencia', 'proveedor')}
              <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="enAgencia" value="1" style="width:auto;margin:0"> Se hizo en la agencia (garantía)</label>
              ${campoNumero('Costo de refacciones (MXN)', 'refacciones')}${campoNumero('Costo de mano de obra (MXN)', 'manoObra')}
              ${campo('Folio de factura', 'folio')}
              <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="facturaTaos" value="1" checked style="width:auto;margin:0"> Factura a nombre de TAOS</label>
              ${area('Notas', 'notas')}
              <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="forzar" value="1" style="width:auto;margin:0"> Permitir kilometraje distinto a los registros vecinos (corrección)</label>
              <button type="submit">Guardar mantenimiento</button></form></details>
              ${lista.length ? `<table><tr><th>Fecha</th><th>Tipo</th><th>Trabajo</th><th>Km</th><th>Total</th><th></th></tr>${lista.map(m => `<tr>
                <td>${esc(fechaCorta(m.fecha))}</td><td>${esc(ETIQUETA_TIPO[m.tipo] || m.tipo)}${m.enAgencia ? ' · agencia' : ''}</td>
                <td>${esc(m.descripcion || (m.servicios || []).join(', '))}${m.descripcion && (m.servicios || []).length ? `<div class="pequeno">${esc(m.servicios.join(', '))}</div>` : ''}</td>
                <td>${m.km != null ? esc(fmt(m.km)) : '—'}</td><td>${esc(dineroFmt(m.total))}</td>
                <td><form method="post" action="/flota/mantenimientos/eliminar" onsubmit="return confirm('¿Eliminar este registro y sus gastos?')">${campoToken}<input type="hidden" name="id" value="${esc(m.id)}"><button class="peligro" style="margin:0;padding:6px 8px" type="submit">✕</button></form></td></tr>`).join('')}</table>` : '<p>Sin mantenimientos registrados.</p>'}`;
        };

        const seccionKm = (v) => {
            const asc = kmDe(v.id);
            const filas = asc.map((e, i) => ({ ...e, recorrido: i > 0 ? e.km - asc[i - 1].km : null })).reverse().slice(0, 14);
            return `<h3>📅 Kilometraje diario</h3>
              <form method="post" action="/flota/km">${campoToken}<input type="hidden" name="vehiculoId" value="${esc(v.id)}">
              ${campoNumero('Odómetro', 'km')}${campoFecha('Fecha (vacío = hoy; si ya hay una captura ese día, se reemplaza)', 'fecha')}
              <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="forzar" value="1" style="width:auto;margin:0"> Permitir corrección (km menor o salto grande)</label>
              <button type="submit">Guardar kilometraje</button></form>
              ${filas.length ? `<table><tr><th>Fecha</th><th>Km</th><th>Recorrido</th><th>Fuente</th><th></th></tr>${filas.map(e => `<tr>
                <td>${esc(fechaCorta(e.fecha))}</td><td>${esc(fmt(e.km))}</td><td>${e.recorrido !== null ? esc(fmt(e.recorrido)) + ' km' : '—'}</td><td>${esc(e.fuente)}</td>
                <td><form method="post" action="/flota/km/eliminar" onsubmit="return confirm('¿Eliminar este registro?')">${campoToken}<input type="hidden" name="id" value="${esc(e.id)}"><button class="peligro" style="margin:0;padding:6px 8px" type="submit">✕</button></form></td></tr>`).join('')}</table>` : '<p>Sin registros de kilometraje.</p>'}`;
        };

        const listaOperadores = operadores.map(o => `<tr><td>${esc(nombreCompleto(o))}</td><td>${esc(o.celular || '')}</td>
            <td>${PUNTO[evaluarOperador(o, hoyISO(), datos.config).nivel]} ${esc(fechaCorta((o.licencia || {}).vigencia))}</td>
            <td><a href="/flota/admin?token=${t}&operador=${encodeURIComponent(o.id)}">Editar</a></td></tr>`).join('');
        const listaVehiculos = vehiculos.map(v => `<tr><td>${esc(nombreUnidad(v))}</td><td>${esc(v.propietario)}</td>
            <td>${v.km && v.km.valor != null ? esc(Number(v.km.valor).toLocaleString('es-MX')) + ' km' : '—'}</td>
            <td><a href="/flota/admin?token=${t}&vehiculo=${encodeURIComponent(v.id)}">Editar</a></td></tr>`).join('');
        const tipos = [['gasolina', 'Gasolina'], ['refaccion', 'Refacción'], ['mano_obra_preventivo', 'Mano de obra · preventivo'], ['mano_obra_correctivo', 'Mano de obra · correctivo'], ['otro', 'Otro']];

        return pagina('Administrar flota · TAOS', `
            <a class="boton gris" href="/flota?token=${t}">← Tablero</a>
            <a class="boton gris" href="/flota/respaldo.json?token=${t}">💾 Respaldo</a>
            <h1>Administrar flota</h1>${aviso}${error}
            ${op ? `<details open><summary>✏️ Editando operador: ${esc(nombreCompleto(op))}</summary>${formOperador(op)}
                <form method="post" action="/flota/eliminar" onsubmit="return confirm('¿Eliminar este operador?')">${campoToken}<input type="hidden" name="tipo" value="operador"><input type="hidden" name="id" value="${esc(op.id)}"><button class="peligro" type="submit">Eliminar operador</button></form></details>` : ''}
            ${veh ? `<details open><summary>✏️ Editando vehículo: ${esc(nombreUnidad(veh))}</summary>${formVehiculo(veh)}${formServicios(veh)}${formDanios(veh)}${formBitacora(veh)}${seccionKm(veh)}
                <form method="post" action="/flota/eliminar" onsubmit="return confirm('¿Eliminar esta unidad con todos sus datos?')">${campoToken}<input type="hidden" name="tipo" value="vehiculo"><input type="hidden" name="id" value="${esc(veh.id)}"><button class="peligro" type="submit">Eliminar vehículo</button></form></details>` : ''}
            <details><summary>➕ Nuevo operador</summary>${formOperador()}</details>
            <details><summary>➕ Nuevo vehículo</summary>${formVehiculo()}</details>
            <details><summary>🛣️ Actualizar kilometraje</summary>
              <form method="post" action="/flota/km">${campoToken}
              ${selector('Unidad', 'vehiculoId', opcionesVehiculo, '')}${campoNumero('Kilometraje del odómetro', 'km')}${campoFecha('Fecha (vacío = hoy)', 'fecha')}
              <label><input type="checkbox" name="forzar" value="1" style="width:auto"> Permitir un kilometraje menor al anterior (corrección)</label>
              <button type="submit">Guardar kilometraje</button></form></details>
            <details><summary>📅 Kilometraje del día (todas las unidades)</summary>
              <form method="post" action="/flota/km-dia">${campoToken}
              ${campoFecha('Fecha (vacío = hoy)', 'fecha')}
              ${vehiculos.map(v => `<label>${esc(nombreUnidad(v))} <span class="pequeno">(último: ${v.km && v.km.valor != null ? esc(fmt(v.km.valor)) + ' km · ' + esc(fechaCorta(v.km.fecha)) : 'sin registro'})</span>
                <input name="km_${esc(v.id)}" inputmode="decimal" placeholder="Odómetro"></label>`).join('') || '<p>Primero registra una unidad.</p>'}
              <label><input type="checkbox" name="forzar" value="1" style="width:auto"> Permitir correcciones (km menores o saltos grandes)</label>
              <button type="submit">Guardar kilometraje del día</button></form></details>
            <details><summary>🔧 Servicio realizado</summary>
              <form method="post" action="/flota/servicio-realizado">${campoToken}
              ${selector('Unidad', 'vehiculoId', opcionesVehiculo, '')}
              ${campo('Servicio (nombre exacto de la lista de la unidad)', 'servicio')}
              ${campoNumero('Kilometraje al hacerlo (vacío = actual)', 'km')}${campoFecha('Fecha (vacío = hoy)', 'fecha')}
              <button type="submit">Registrar servicio</button></form></details>
            <details><summary>💳 Registrar gasto</summary>
              <form method="post" action="/flota/gastos/guardar">${campoToken}
              ${campoFecha('Fecha (vacío = hoy)', 'fecha')}${selector('Unidad', 'vehiculoId', [['', '— General —'], ...opcionesVehiculo], '')}
              ${selector('Tipo', 'tipo', tipos, 'gasolina')}${campoNumero('Monto (MXN)', 'monto')}${campo('Concepto', 'concepto')}
              ${campo('Proveedor', 'proveedor')}${campo('Folio de factura', 'folio')}
              <label><input type="checkbox" name="facturaTaos" value="1" checked style="width:auto"> Factura a nombre de TAOS</label>
              <button type="submit">Guardar gasto</button></form></details>
            <details><summary>⚙️ Configuración de semáforos</summary>
              <form method="post" action="/flota/config">${campoToken}
              ${campoNumero('Servicios (aceite, filtros, bujías…): amarillo cuando falten (km) o menos', 'umbralKmAmarillo', datos.config.umbralKmAmarillo)}
              ${campoNumero('Verificación ambiental: amarillo desde N días antes', 'diasVerificacion', datos.config.diasVerificacion)}
              ${campoNumero('Otros documentos: amarillo desde N días antes (0 = desde el mes del vencimiento)', 'diasAvisoMinimo', datos.config.diasAvisoMinimo)}
              ${campoNumero('Kilometraje: máximo razonable de recorrido por día (para detectar errores de captura)', 'kmDiarioMax', datos.config.kmDiarioMax)}
              <button type="submit">Guardar configuración</button></form></details>
            <h2>Operadores (${operadores.length})</h2>${operadores.length ? `<table><tr><th>Nombre</th><th>Celular</th><th>Licencia</th><th></th></tr>${listaOperadores}</table>` : '<p>Sin operadores.</p>'}
            <h2>Vehículos (${vehiculos.length})</h2>${vehiculos.length ? `<table><tr><th>Unidad</th><th>Propietario</th><th>Km</th><th></th></tr>${listaVehiculos}</table>` : '<p>Sin vehículos.</p>'}`);
    }

    const volver = (res, token, mensaje, esError = false, extra = '') =>
        res.redirect(303, `/flota/admin?token=${encodeURIComponent(token)}&${esError ? 'error' : 'ok'}=${encodeURIComponent(mensaje)}${extra}`);

    // ----- Rutas de consulta -----
    app.get('/flota', (req, res) => {
        const rol = exigir(res, req.query.token, 'visor');
        if (rol) res.send(paginaTablero(req.query.token, rol));
    });

    app.get('/flota/api', (req, res) => {
        if (!exigir(res, req.query.token, 'visor')) return;
        const { hoy, filas } = evaluarFlota();
        res.json({ corte: hoy, unidades: filas.map(f => ({ unidad: nombreUnidad(f.vehiculo), nivel: f.nivel, pendientes: f.items.filter(i => i.nivel !== 'verde') })) });
    });

    app.get('/flota/gastos.csv', (req, res) => {
        if (!exigir(res, req.query.token, 'visor')) return;
        const celda = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const lineas = [['Fecha', 'Unidad', 'Tipo', 'Concepto', 'Proveedor', 'Folio factura', 'Factura a nombre de TAOS', 'Monto MXN'].map(celda).join(',')];
        datos.gastos.slice().sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))).forEach(g => {
            const v = datos.vehiculos[g.vehiculoId];
            lineas.push([g.fecha, v ? nombreUnidad(v) : 'General', g.tipo, g.concepto, g.proveedor, g.folio, g.facturaTaos ? 'Sí' : 'No', g.monto].map(celda).join(','));
        });
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="gastos-flota-taos.csv"');
        res.send('\uFEFF' + lineas.join('\n'));
    });

    const celdaCsv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    function enviarCsv(res, nombreArchivo, encabezados, filas) {
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
        res.send('\uFEFF' + [encabezados, ...filas].map(f => f.map(celdaCsv).join(',')).join('\n'));
    }

    app.get('/flota/bitacora.csv', (req, res) => {
        if (!exigir(res, req.query.token, 'visor')) return;
        const filas = datos.mantenimientos.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).map(m => {
            const v = datos.vehiculos[m.vehiculoId];
            return [m.fecha, v ? nombreUnidad(v) : '', ETIQUETA_TIPO[m.tipo] || m.tipo, m.km, m.descripcion, (m.servicios || []).join('; '), m.proveedor, m.enAgencia ? 'Sí' : 'No', m.refacciones, m.manoObra, m.total, m.folio, m.facturaTaos ? 'Sí' : 'No', m.notas];
        });
        enviarCsv(res, 'bitacora-mantenimiento-taos.csv', ['Fecha', 'Unidad', 'Tipo', 'Km', 'Descripción', 'Servicios', 'Taller / agencia', 'En agencia', 'Refacciones', 'Mano de obra', 'Total', 'Folio factura', 'Factura a nombre de TAOS', 'Notas'], filas);
    });

    app.get('/flota/kilometraje.csv', (req, res) => {
        if (!exigir(res, req.query.token, 'visor')) return;
        const filas = [];
        Object.values(datos.vehiculos).forEach(v => {
            let anterior = null;
            kmDe(v.id).forEach(e => {
                filas.push([e.fecha, nombreUnidad(v), e.km, anterior ? e.km - anterior.km : '', e.fuente, e.nota]);
                anterior = e;
            });
        });
        filas.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        enviarCsv(res, 'kilometraje-diario-taos.csv', ['Fecha', 'Unidad', 'Km', 'Recorrido desde el registro anterior', 'Fuente', 'Nota'], filas);
    });

    app.get('/flota/respaldo.json', (req, res) => {
        if (!exigir(res, req.query.token, 'admin')) return;
        res.set('Content-Disposition', 'attachment; filename="respaldo-flota-taos.json"');
        res.json(datos);
    });

    app.get('/flota/admin', (req, res) => {
        if (!exigir(res, req.query.token, 'admin')) return;
        res.send(paginaAdmin(req.query.token, req.query));
    });

    // ----- Rutas de captura (solo admin) -----
    app.post('/flota/operadores/guardar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        if (!texto(b.nombre)) return volver(res, b.token, 'El nombre del operador es obligatorio.', true);
        if (b.licenciaVigencia && !fechaValida(b.licenciaVigencia)) return volver(res, b.token, 'La vigencia de la licencia no es una fecha válida.', true);

        const id = b.id && datos.operadores[b.id] ? b.id : nuevoId('op');
        datos.operadores[id] = {
            id, nombre: texto(b.nombre), apellido1: texto(b.apellido1), apellido2: texto(b.apellido2),
            edad: numero(b.edad),
            domicilio: { calle: texto(b.calle), numero: texto(b.numeroDom, 20), colonia: texto(b.colonia), cp: texto(b.cp, 10), estado: texto(b.estado) },
            celular: texto(b.celular, 20), celularAlterno: texto(b.celularAlterno, 20),
            licencia: { numero: texto(b.licenciaNumero, 40), vigencia: b.licenciaVigencia || '' },
            creado: (datos.operadores[id] && datos.operadores[id].creado) || new Date().toISOString()
        };
        guardar();
        volver(res, b.token, `Operador guardado: ${nombreCompleto(datos.operadores[id])}.`);
    });

    app.post('/flota/vehiculos/guardar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;

        const placas = texto(b.placas, 15).toUpperCase();
        const anio = numero(b.anio);
        if (!texto(b.marca) || !texto(b.modelo) || !placas) return volver(res, b.token, 'Marca, modelo y placas son obligatorios.', true);
        if (anio !== null && (anio < 1950 || anio > new Date().getFullYear() + 1)) return volver(res, b.token, 'El año de fabricación no es válido.', true);
        for (const clave of ['tarjeta', 'verificacion', 'seguro']) {
            if (b[clave] && !fechaValida(b[clave])) return volver(res, b.token, `La vigencia de «${clave}» no es una fecha válida.`, true);
        }
        if (b.garantiaFecha && !fechaValida(b.garantiaFecha)) return volver(res, b.token, 'La fecha de garantía no es válida.', true);
        const repetida = Object.values(datos.vehiculos).find(v => v.placas === placas && v.id !== b.id);
        if (repetida) return volver(res, b.token, `Ya existe una unidad con las placas ${placas}.`, true);

        const existente = b.id && datos.vehiculos[b.id];
        const id = existente ? b.id : nuevoId('veh');
        const kmInicial = numero(b.km);
        datos.vehiculos[id] = {
            id,
            propietario: b.propietario === 'Operador' ? 'Operador' : 'TAOS',
            operadorId: b.operadorId && datos.operadores[b.operadorId] ? b.operadorId : '',
            marca: texto(b.marca), modelo: texto(b.modelo), version: texto(b.version), anio, placas,
            modificaciones: texto(b.modificaciones, 600), hojalateria: texto(b.hojalateria, 600),
            agencia: { va: b.vaAgencia === '1', agencia: texto(b.agencia), garantiaKm: numero(b.garantiaKm), garantiaFecha: b.garantiaFecha || '' },
            danios: existente ? (existente.danios || []) : [],
            documentos: {
                tarjeta: { vigencia: b.tarjeta || '' },
                verificacion: { vigencia: b.verificacion || '' },
                seguro: { vigencia: b.seguro || '', aseguradora: texto(b.aseguradora), poliza: texto(b.poliza, 40) }
            },
            km: existente ? existente.km : { valor: null, fecha: '' },
            servicios: existente ? existente.servicios : serviciosPorDefecto(),
            creado: existente ? existente.creado : new Date().toISOString()
        };
        if (!existente && kmInicial !== null && kmInicial >= 0) registrarKm(datos.vehiculos[id], hoyISO(), kmInicial, { fuente: 'inicial' });
        guardar();
        volver(res, b.token, `Vehículo guardado: ${nombreUnidad(datos.vehiculos[id])}.`, false, `&vehiculo=${encodeURIComponent(id)}`);
    });

    app.post('/flota/vehiculos/servicios', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const vehiculo = datos.vehiculos[b.vehiculoId];
        if (!vehiculo) return volver(res, b.token, 'Unidad no encontrada.', true);

        const previos = Object.fromEntries((vehiculo.servicios || []).map(s => [s.id, s]));
        const nuevos = [];
        const total = Math.min(parseInt(b.n, 10) || 0, 40);
        for (let i = 0; i < total; i++) {
            const nombre = texto(b[`s${i}_nombre`]);
            if (!nombre) continue;
            const ultimaFecha = b[`s${i}_ultimaFecha`] || '';
            if (ultimaFecha && !fechaValida(ultimaFecha)) return volver(res, b.token, `La fecha del servicio «${nombre}» no es válida.`, true, `&vehiculo=${encodeURIComponent(vehiculo.id)}`);
            const id = previos[b[`s${i}_id`]] ? b[`s${i}_id`] : nuevoId('srv');
            const anterior = previos[id] || {};
            const intervaloKm = numero(b[`s${i}_km`]);
            const intervaloMeses = numero(b[`s${i}_meses`]);
            const cambioIntervalo = anterior.intervaloKm !== intervaloKm || anterior.intervaloMeses !== intervaloMeses;
            nuevos.push({
                id, nombre, intervaloKm, intervaloMeses,
                ultimoKm: numero(b[`s${i}_ultimoKm`]), ultimaFecha,
                fuente: cambioIntervalo ? 'capturado manualmente' : (anterior.fuente || 'capturado manualmente')
            });
        }
        vehiculo.servicios = nuevos;
        guardar();
        volver(res, b.token, `Servicios guardados (${nuevos.length}).`, false, `&vehiculo=${encodeURIComponent(vehiculo.id)}`);
    });

    app.post('/flota/danios/guardar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const vehiculo = datos.vehiculos[b.vehiculoId];
        if (!vehiculo) return volver(res, b.token, 'Unidad no encontrada.', true);
        const ir = `&vehiculo=${encodeURIComponent(vehiculo.id)}`;
        vehiculo.danios = vehiculo.danios || [];
        const actual = b.id ? vehiculo.danios.find(d => d.id === b.id) : null;
        if (b.id && !actual) return volver(res, b.token, 'Registro de daño no encontrado.', true, ir);
        const accion = b.accion || 'guardar';

        if (accion === 'eliminar') {
            vehiculo.danios = vehiculo.danios.filter(d => d.id !== b.id);
            guardar();
            return volver(res, b.token, 'Registro de daño eliminado.', false, ir);
        }
        if (accion === 'salida_hoy') {
            actual.salida = hoyISO();
            if (!actual.ingreso) actual.ingreso = actual.salida;
            guardar();
            return volver(res, b.token, 'Salida del taller registrada: el daño quedó resuelto.', false, ir);
        }

        for (const clave of ['reportado', 'ingreso', 'salida']) {
            if (b[clave] && !fechaValida(b[clave])) return volver(res, b.token, `La fecha de «${clave}» no es válida.`, true, ir);
        }
        if (b.ingreso && b.salida && b.salida < b.ingreso) return volver(res, b.token, 'La salida no puede ser anterior al ingreso.', true, ir);
        if (!texto(b.descripcion, 300)) return volver(res, b.token, 'Describe el daño.', true, ir);

        const campos = {
            tipo: TIPOS_DANIO[b.tipo] ? b.tipo : 'hojalateria', descripcion: texto(b.descripcion, 300),
            reportado: b.reportado || (actual && actual.reportado) || hoyISO(), ingreso: b.ingreso || '', salida: b.salida || ''
        };
        if (actual) Object.assign(actual, campos); else vehiculo.danios.push({ id: nuevoId('dan'), ...campos });
        guardar();
        volver(res, b.token, 'Daño guardado.', false, ir);
    });

    // Una captura de kilometraje (con fecha; si ya había una ese día, se reemplaza)
    app.post('/flota/km', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const vehiculo = datos.vehiculos[b.vehiculoId];
        if (!vehiculo) return volver(res, b.token, 'Unidad no encontrada.', true);
        const ir = `&vehiculo=${encodeURIComponent(vehiculo.id)}`;
        const resultado = registrarKm(vehiculo, b.fecha || hoyISO(), numero(b.km), { forzar: b.forzar === '1', operadorId: vehiculo.operadorId || '' });
        if (resultado.error) return volver(res, b.token, resultado.error, true, ir);
        guardar();
        volver(res, b.token, `Kilometraje de ${nombreUnidad(vehiculo)}: ${fmt(resultado.entrada.km)} km (${fechaCorta(resultado.entrada.fecha)}).`, false, ir);
    });

    // Captura rápida del día: un campo por unidad
    app.post('/flota/km-dia', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const fecha = b.fecha || hoyISO();
        const guardados = [], fallidos = [];
        Object.values(datos.vehiculos).forEach(v => {
            const crudo = b[`km_${v.id}`];
            if (crudo === undefined || String(crudo).trim() === '') return;
            const r = registrarKm(v, fecha, numero(crudo), { forzar: b.forzar === '1', operadorId: v.operadorId || '' });
            if (r.error) fallidos.push(`${nombreUnidad(v)}: ${r.error}`); else guardados.push(nombreUnidad(v));
        });
        if (guardados.length) guardar();
        if (!guardados.length && !fallidos.length) return volver(res, b.token, 'No escribiste ningún kilometraje.', true);
        volver(res, b.token, `Guardados ${guardados.length} de ${guardados.length + fallidos.length}.` + (fallidos.length ? ` No se guardó → ${fallidos.join(' · ')}` : ''), fallidos.length > 0);
    });

    app.post('/flota/km/eliminar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const entrada = datos.kilometraje.find(e => e.id === b.id);
        if (!entrada) return volver(res, b.token, 'Registro de kilometraje no encontrado.', true);
        datos.kilometraje = datos.kilometraje.filter(e => e.id !== b.id);
        if (datos.vehiculos[entrada.vehiculoId]) refrescarKm(datos.vehiculos[entrada.vehiculoId]);
        guardar();
        volver(res, b.token, 'Registro de kilometraje eliminado.', false, `&vehiculo=${encodeURIComponent(entrada.vehiculoId)}`);
    });

    app.post('/flota/servicio-realizado', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const vehiculo = datos.vehiculos[b.vehiculoId];
        if (!vehiculo) return volver(res, b.token, 'Unidad no encontrada.', true);
        const buscado = texto(b.servicio).toLowerCase();
        const servicio = (vehiculo.servicios || []).find(s => s.nombre.toLowerCase() === buscado);
        if (!servicio) return volver(res, b.token, 'No existe un servicio con ese nombre en la unidad. Revisa la lista en «Editar».', true);
        if (b.fecha && !fechaValida(b.fecha)) return volver(res, b.token, 'La fecha no es válida.', true);

        const kmActual = vehiculo.km && numero(vehiculo.km.valor);
        const km = numero(b.km) !== null ? numero(b.km) : kmActual;
        servicio.ultimoKm = km === undefined ? null : km;
        servicio.ultimaFecha = b.fecha || hoyISO();
        datos.mantenimientos.push({
            id: nuevoId('man'), vehiculoId: vehiculo.id, fecha: servicio.ultimaFecha, tipo: 'preventivo', km: servicio.ultimoKm,
            descripcion: `Servicio: ${servicio.nombre}`, servicioIds: [servicio.id], servicios: [servicio.nombre], proveedor: '', enAgencia: false,
            refacciones: 0, manoObra: 0, total: 0, folio: '', facturaTaos: false, notas: '', operadorId: vehiculo.operadorId || '', creado: new Date().toISOString()
        });
        guardar();
        volver(res, b.token, `Servicio «${servicio.nombre}» registrado en ${nombreUnidad(vehiculo)}.`);
    });

    app.post('/flota/mantenimientos/guardar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const vehiculo = datos.vehiculos[b.vehiculoId];
        if (!vehiculo) return volver(res, b.token, 'Unidad no encontrada.', true);
        const ir = `&vehiculo=${encodeURIComponent(vehiculo.id)}`;
        const tipo = ['preventivo', 'correctivo'].includes(b.tipo) ? b.tipo : null;
        if (!tipo) return volver(res, b.token, 'Elige si el mantenimiento fue preventivo o correctivo.', true, ir);
        const fecha = b.fecha || hoyISO();
        if (!fechaValida(fecha) || fecha > hoyISO()) return volver(res, b.token, 'La fecha del mantenimiento no es válida (no puede ser futura).', true, ir);

        const servicios = (vehiculo.servicios || []).filter(sv => [].concat(b.servicios || []).includes(sv.id));
        const descripcion = texto(b.descripcion, 300);
        if (!descripcion && servicios.length === 0) return volver(res, b.token, 'Describe el trabajo o marca los servicios que se realizaron.', true, ir);
        const refacciones = numero(b.refacciones) === null ? 0 : numero(b.refacciones);
        const manoObra = numero(b.manoObra) === null ? 0 : numero(b.manoObra);
        if (refacciones < 0 || manoObra < 0) return volver(res, b.token, 'Los costos no pueden ser negativos.', true, ir);

        // El kilometraje capturado también entra al registro diario (se valida igual que cualquier otro)
        let km = vehiculo.km && vehiculo.km.valor != null ? numero(vehiculo.km.valor) : null;
        if (numero(b.km) !== null) {
            const r = registrarKm(vehiculo, fecha, numero(b.km), { fuente: 'mantenimiento', forzar: b.forzar === '1', operadorId: vehiculo.operadorId || '' });
            if (r.error) return volver(res, b.token, r.error, true, ir);
            km = r.entrada.km;
        }

        const id = nuevoId('man');
        datos.mantenimientos.push({
            id, vehiculoId: vehiculo.id, fecha, tipo, km, descripcion,
            servicioIds: servicios.map(sv => sv.id), servicios: servicios.map(sv => sv.nombre),
            proveedor: texto(b.proveedor), enAgencia: b.enAgencia === '1',
            refacciones, manoObra, total: refacciones + manoObra,
            folio: texto(b.folio, 40), facturaTaos: b.facturaTaos === '1', notas: texto(b.notas, 400),
            operadorId: vehiculo.operadorId || '', creado: new Date().toISOString()
        });
        // Los servicios del programa que se hicieron reinician su conteo
        servicios.forEach(sv => { sv.ultimoKm = km; sv.ultimaFecha = fecha; });

        // Los costos pasan solos al control de gastos (vinculados para no capturarlos dos veces)
        const base = { fecha, vehiculoId: vehiculo.id, concepto: descripcion || servicios.map(sv => sv.nombre).join(', '), proveedor: texto(b.proveedor), folio: texto(b.folio, 40), facturaTaos: b.facturaTaos === '1', mantenimientoId: id };
        if (refacciones > 0) datos.gastos.push({ id: nuevoId('gas'), tipo: 'refaccion', monto: refacciones, ...base });
        if (manoObra > 0) datos.gastos.push({ id: nuevoId('gas'), tipo: tipo === 'preventivo' ? 'mano_obra_preventivo' : 'mano_obra_correctivo', monto: manoObra, ...base });

        guardar();
        volver(res, b.token, `Mantenimiento ${tipo} registrado${servicios.length ? ` (${servicios.length} servicio(s) reiniciado(s))` : ''}.`, false, ir);
    });

    app.post('/flota/mantenimientos/eliminar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const entrada = datos.mantenimientos.find(m => m.id === b.id);
        if (!entrada) return volver(res, b.token, 'Registro de bitácora no encontrado.', true);
        datos.mantenimientos = datos.mantenimientos.filter(m => m.id !== b.id);
        datos.gastos = datos.gastos.filter(g => g.mantenimientoId !== b.id);
        guardar();
        volver(res, b.token, 'Registro eliminado junto con sus gastos. Si había reiniciado servicios, corrige su último registro en la lista de servicios.', false, `&vehiculo=${encodeURIComponent(entrada.vehiculoId)}`);
    });

    app.post('/flota/gastos/guardar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const monto = numero(b.monto);
        if (monto === null || monto <= 0) return volver(res, b.token, 'Escribe un monto válido.', true);
        if (b.fecha && !fechaValida(b.fecha)) return volver(res, b.token, 'La fecha no es válida.', true);
        if (b.vehiculoId && !datos.vehiculos[b.vehiculoId]) return volver(res, b.token, 'Unidad no encontrada.', true);

        const tipo = ['gasolina', 'refaccion', 'mano_obra_preventivo', 'mano_obra_correctivo', 'otro'].includes(b.tipo) ? b.tipo : 'otro';
        datos.gastos.push({
            id: nuevoId('gas'), fecha: b.fecha || hoyISO(), vehiculoId: b.vehiculoId || '', tipo, monto,
            concepto: texto(b.concepto), proveedor: texto(b.proveedor), folio: texto(b.folio, 40), facturaTaos: b.facturaTaos === '1'
        });
        guardar();
        volver(res, b.token, `Gasto guardado: $${monto.toLocaleString('es-MX')}.`);
    });

    app.post('/flota/config', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        const umbral = numero(b.umbralKmAmarillo);
        const diasVerificacion = numero(b.diasVerificacion);
        const dias = numero(b.diasAvisoMinimo);
        // Si el campo no viene (o va vacío), se conserva el máximo de km por día que ya había
        const kmMax = (b.kmDiarioMax === undefined || String(b.kmDiarioMax).trim() === '') ? datos.config.kmDiarioMax : numero(b.kmDiarioMax);
        if ([umbral, diasVerificacion, dias].some(n => n === null || n < 0) || kmMax === null || kmMax <= 0) return volver(res, b.token, 'Escribe números válidos (0 o más; el máximo de km por día debe ser mayor que 0).', true);
        datos.config = { umbralKmAmarillo: umbral, diasVerificacion: Math.round(diasVerificacion), diasAvisoMinimo: Math.round(dias), kmDiarioMax: kmMax };
        guardar();
        volver(res, b.token, 'Configuración guardada.');
    });

    app.post('/flota/eliminar', (req, res) => {
        const b = req.body || {};
        if (!exigir(res, b.token, 'admin')) return;
        if (b.tipo === 'operador' && datos.operadores[b.id]) {
            delete datos.operadores[b.id];
            Object.values(datos.vehiculos).forEach(v => { if (v.operadorId === b.id) v.operadorId = ''; });
        } else if (b.tipo === 'vehiculo' && datos.vehiculos[b.id]) {
            delete datos.vehiculos[b.id];
            datos.gastos = datos.gastos.filter(g => g.vehiculoId !== b.id);
            datos.kilometraje = datos.kilometraje.filter(e => e.vehiculoId !== b.id);
            datos.mantenimientos = datos.mantenimientos.filter(m => m.vehiculoId !== b.id);
        } else {
            return volver(res, b.token, 'No se encontró lo que quieres eliminar.', true);
        }
        guardar();
        volver(res, b.token, 'Eliminado.');
    });

    // ----- Alerta diaria por WhatsApp (solo si hay 🔴 o 🟡) -----
    function textoAlertas() {
        const { filas } = evaluarFlota();
        const rojos = [], amarillos = [];
        filas.forEach(f => f.items.forEach(i => {
            if (i.nivel === 'verde') return;
            const linea = `• ${nombreUnidad(f.vehiculo)}: ${i.etiqueta} — ${i.texto}${f.agencia.va && i.tipo === 'servicio' ? ' → en agencia' : ''}`;
            if (i.nivel === 'rojo') rojos.push(linea); else amarillos.push(linea);
        }));
        if (rojos.length === 0 && amarillos.length === 0) return '';
        const recortar = (l) => l.length > 15 ? l.slice(0, 15).concat([`• …y ${l.length - 15} más (ver el tablero)`]) : l;
        return `🚦 *CONTROL DE FLOTA TAOS*\n📅 ${fechaLarga()}\n\n` +
            (rojos.length ? `🔴 *Atención inmediata*\n${recortar(rojos).join('\n')}\n\n` : '') +
            (amarillos.length ? `🟡 *Próximos / por capturar*\n${recortar(amarillos).join('\n')}\n\n` : '') +
            (urlPublica ? `Tablero: ${urlPublica}/flota (con la clave de lectura)` : '');
    }

    cron.schedule('0 8 * * *', async () => {
        if (!whatsappListo() || !destinoAlertas) return;
        const mensaje = textoAlertas();
        if (!mensaje) return;
        try {
            await enviarTexto(destinoAlertas, mensaje);
        } catch (error) {
            console.error('❌ No se pudo enviar la alerta diaria de flota:', error.message || error);
        }
    }, { timezone: zonaHoraria });

    // Para pruebas
    return { evaluarFlota, textoAlertas, obtenerDatos: () => datos, recargar: () => { datos = cargar(); } };
};

module.exports.utilidades = { nivelDanio, nivelPorFecha, nivelServicio, evaluarVehiculo, nivelGeneral, sumarMeses, fechaValida, numero, diasEntre };

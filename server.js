const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Evita que un error no capturado tumbe todo el servicio (GPS, panel y cron)
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Promesa rechazada sin manejar:', reason);
});

let unidadesGPS = {};
let ultimoReporteMatutino = "Aún no se ha generado el reporte de hoy.";
let whatsappListo = false;
let codigoVinculacion = "";

// Resultado del último intento de envío (se puede consultar en /api/reporte-matutino)
let ultimoEnvio = { fecha: null, ok: null, detalle: "Aún no se ha intentado enviar ningún reporte." };

// Número de la cuenta de WhatsApp que se va a vincular (código de país + número, sin símbolos).
// Se puede cambiar desde Render con la variable de entorno WHATSAPP_PAIR_PHONE, sin tocar el código.
const NUMERO_VINCULACION = process.env.WHATSAPP_PAIR_PHONE || '5215534686687';

// Destino del reporte. Por defecto, el mismo número vinculado (mensaje a uno mismo).
// Para mandarlo a un grupo, define en Render WHATSAPP_REPORTE_DESTINO con el ID del grupo
// (termina en @g.us). También acepta un número o un ID terminado en @c.us.
const DESTINO_REPORTE = process.env.WHATSAPP_REPORTE_DESTINO || NUMERO_VINCULACION;

// Clave para la prueba manual de envío. Si no la defines en Render, la prueba queda deshabilitada.
const TOKEN_ADMIN = process.env.ADMIN_TOKEN || '';

// Carpeta donde se guarda la sesión de WhatsApp. En Render debe apuntar al disco persistente
// (por ejemplo /var/data/wwebjs_auth) para que NO se pida un código nuevo en cada reinicio.
const RUTA_SESION = process.env.WWEBJS_DATA_PATH || './.wwebjs_auth';

// === REGISTRO:INICIO ===
// Lista de grupos de WhatsApp detectados (se guarda en el disco persistente, junto a la sesión).
// Cada grupo aparece cuando alguien escribe en él; en /grupos puedes ponerle tu propio nombre.
const ARCHIVO_DATOS = path.join(RUTA_SESION, 'taos-datos.json');

function cargarDatos() {
    try {
        const crudo = JSON.parse(fs.readFileSync(ARCHIVO_DATOS, 'utf8'));
        return {
            grupos: (crudo.grupos && typeof crudo.grupos === 'object') ? crudo.grupos : {},
            aviso: typeof crudo.aviso === 'string' ? crudo.aviso : ''
        };
    } catch (error) {
        return { grupos: {}, aviso: '' };
    }
}

let datos = cargarDatos();
let guardadoPendiente = null;

function guardarDatos(inmediato = false) {
    const escribir = () => {
        guardadoPendiente = null;
        try {
            fs.mkdirSync(path.dirname(ARCHIVO_DATOS), { recursive: true });
            const temporal = ARCHIVO_DATOS + '.tmp';
            fs.writeFileSync(temporal, JSON.stringify(datos, null, 2), 'utf8');
            fs.renameSync(temporal, ARCHIVO_DATOS);
        } catch (error) {
            console.warn('⚠️ No se pudo guardar la lista de grupos:', error.message);
        }
    };

    if (inmediato) {
        if (guardadoPendiente) clearTimeout(guardadoPendiente);
        escribir();
    } else if (!guardadoPendiente) {
        guardadoPendiente = setTimeout(escribir, 5000);
    }
}

// Devuelve true si el grupo se veía por primera vez.
function registrarMensajeGrupo(idChat, msg) {
    const ahora = new Date().toISOString();
    const esNuevo = !datos.grupos[idChat];
    const grupo = datos.grupos[idChat] || (datos.grupos[idChat] = {
        id: idChat, nombre: '', nombreWhatsApp: '', primeraVez: ahora, mensajes: 0
    });

    const texto = (msg && typeof msg.body === 'string') ? msg.body.replace(/\s+/g, ' ').trim() : '';
    const remitente = (msg && msg._data && typeof msg._data.notifyName === 'string') ? msg._data.notifyName : '';

    grupo.ultimaVez = ahora;
    grupo.mensajes = (grupo.mensajes || 0) + 1;
    grupo.ultimoMensaje = texto ? texto.slice(0, 50) : `(${(msg && msg.type) || 'mensaje'})`;
    grupo.ultimoRemitente = (msg && msg.fromMe) ? 'Tú' : remitente;

    guardarDatos(esNuevo);
    return esNuevo;
}

// El texto de los mensajes y los nombres vienen de WhatsApp: siempre se escapan antes de mostrarlos.
function escaparHtml(valor) {
    return String(valor == null ? '' : valor)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function paginaGrupos(estado, destino, token) {
    const formato = (iso) => iso
        ? new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
        : '—';

    const grupos = Object.values(estado.grupos)
        .sort((a, b) => String(b.ultimaVez || '').localeCompare(String(a.ultimaVez || '')));

    const tarjetas = grupos.length === 0
        ? '<p>Aún no se ha detectado ningún grupo. Escribe un mensaje en el grupo que quieres identificar y recarga esta página.</p>'
        : grupos.map(g => `
            <div class="grupo${g.id === destino ? ' destino' : ''}">
                ${g.id === destino ? '<div class="etiqueta">⭐ DESTINO ACTUAL DEL REPORTE</div>' : ''}
                <form method="post" action="/grupos/nombre">
                    <input type="hidden" name="token" value="${escaparHtml(token)}">
                    <input type="hidden" name="id" value="${escaparHtml(g.id)}">
                    <label>Nombre que le pongo:</label>
                    <input type="text" name="nombre" maxlength="80" value="${escaparHtml(g.nombre)}" placeholder="Ej. Taos Cab administración">
                    <button type="submit">Guardar nombre</button>
                </form>
                ${g.nombreWhatsApp ? `<div class="dato">Nombre en WhatsApp: <b>${escaparHtml(g.nombreWhatsApp)}</b></div>` : ''}
                <div class="dato">Último mensaje: ${escaparHtml(formato(g.ultimaVez))} · ${escaparHtml(g.mensajes || 0)} mensajes vistos</div>
                <div class="dato">Dijo${g.ultimoRemitente ? ' ' + escaparHtml(g.ultimoRemitente) : ''}: “${escaparHtml(g.ultimoMensaje || '')}”</div>
                <div class="id">${escaparHtml(g.id)}</div>
            </div>`).join('');

    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grupos · TAOS</title>
<style>
 body{font-family:Arial,sans-serif;background:#f4f4f9;color:#222;padding:16px;max-width:640px;margin:0 auto}
 h2{margin-top:0} .nota{color:#555;font-size:14px}
 .grupo,.aviso{background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px;margin:12px 0}
 .destino{border:2px solid #16a34a;background:#f0fdf4} .etiqueta{font-weight:bold;color:#15803d;margin-bottom:6px}
 label{display:block;font-size:13px;color:#555;margin-bottom:4px}
 input[type=text],textarea{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #bbb;border-radius:6px}
 button{margin-top:8px;padding:10px 14px;font-size:15px;border:0;border-radius:6px;background:#1d4ed8;color:#fff}
 .dato{font-size:13px;color:#444;margin-top:6px} .id{font-family:monospace;font-size:12px;color:#666;margin-top:8px;word-break:break-all}
</style></head><body>
<h2>Grupos de WhatsApp detectados</h2>
<p class="nota">Un grupo aparece cuando alguien escribe en él. Ponle un nombre para reconocerlo; el nombre es solo para ti y no cambia nada en WhatsApp. El destino del reporte se define en Render con la variable WHATSAPP_REPORTE_DESTINO.</p>
<div class="aviso">
  <form method="post" action="/grupos/aviso">
    <input type="hidden" name="token" value="${escaparHtml(token)}">
    <label><b>Aviso especial para el próximo reporte (opcional):</b> marchas, cierres, obras u otra información confirmada. Se incluye una sola vez y luego se borra.</label>
    <textarea name="aviso" rows="4" maxlength="600">${escaparHtml(estado.aviso)}</textarea>
    <button type="submit">Guardar aviso</button>
  </form>
</div>
${tarjetas}
</body></html>`;
}
// === REGISTRO:FIN ===

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: RUTA_SESION
    }),
    // Forma documentada de vincular con código: la propia librería solicita el código
    // y lo entrega por el evento 'code'. Con esta opción NO se genera QR.
    pairWithPhoneNumber: {
        phoneNumber: NUMERO_VINCULACION,
        showNotification: true
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('code', (code) => {
    codigoVinculacion = code;
    console.log(`🔢 CÓDIGO DE VINCULACIÓN DE WHATSAPP: ${code}`);
});

client.on('authenticated', () => {
    console.log('🔐 Autenticación de WhatsApp correcta.');
});

client.on('auth_failure', (msg) => {
    whatsappListo = false;
    console.error('❌ Falló la autenticación de WhatsApp:', msg);
});

client.on('disconnected', (reason) => {
    whatsappListo = false;
    codigoVinculacion = "";
    console.error('⚠️ WhatsApp se desconectó:', reason);
});

client.on('ready', async () => {
    whatsappListo = true;
    codigoVinculacion = "";
    console.log('✅ ¡Sesión de WhatsApp conectada y lista para operar!');

    // Listar chats es solo informativo. Con las versiones recientes de WhatsApp Web,
    // getChats() puede fallar con "r: r"; eso NO impide enviar mensajes.
    try {
        const chats = await client.getChats();
        console.log('--- 📋 LISTA DE CHATS Y GRUPOS DISPONIBLES ---');
        chats.forEach(chat => {
            console.log(`Nombre: ${chat.name} ---> ID: ${chat.id._serialized}`);
        });
        console.log('---------------------------------------------');
    } catch (error) {
        console.warn('ℹ️ No se pudo listar los chats (falla conocida de la librería; no afecta el envío del reporte).');
    }
});

// Alternativa a getChats(): cada grupo donde se escribe un mensaje queda registrado en la lista
// (consúltala y ponles nombre en /grupos). El nombre de WhatsApp se intenta leer una sola vez.
async function intentarNombreAutomatico(idChat) {
    try {
        const chat = await Promise.race([
            client.getChatById(idChat),
            new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo agotado')), 8000))
        ]);
        if (chat && chat.name && datos.grupos[idChat]) {
            datos.grupos[idChat].nombreWhatsApp = chat.name;
            guardarDatos(true);
            console.log(`👥 Nombre del grupo ${idChat}: ${chat.name}`);
        }
    } catch (error) {
        // Con algunas versiones de WhatsApp Web esta lectura falla; el nombre se puede poner a mano en /grupos
    }
}

client.on('message_create', (msg) => {
    try {
        const idChat = msg.fromMe ? msg.to : msg.from;
        if (typeof idChat === 'string' && idChat.endsWith('@g.us')) {
            if (registrarMensajeGrupo(idChat, msg)) {
                console.log(`👥 GRUPO NUEVO DETECTADO ---> ID: ${idChat}`);
                intentarNombreAutomatico(idChat);
            }
        }
    } catch (error) {
        console.warn('⚠️ No se pudo leer el ID del chat:', error.message);
    }
});

// Chrome deja archivos de bloqueo si se cierra de golpe; con un disco persistente podrían
// impedir el siguiente arranque, así que se eliminan antes de iniciar.
function prepararSesion() {
    const carpetaSesion = path.join(RUTA_SESION, 'session');
    try {
        for (const archivo of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            fs.rmSync(path.join(carpetaSesion, archivo), { force: true });
        }
    } catch (error) {
        console.warn('⚠️ No se pudieron limpiar los bloqueos de Chrome:', error.message);
    }

    if (fs.existsSync(carpetaSesion)) {
        console.log(`💾 Sesión guardada encontrada en ${carpetaSesion}: no debería pedir código nuevo.`);
    } else {
        console.log(`🆕 No hay sesión guardada en ${carpetaSesion}: se pedirá un código de vinculación.`);
    }
}

// Render avisa con SIGTERM antes de apagar: se cierra Chrome con calma para no dañar la sesión
process.on('SIGTERM', async () => {
    console.log('🛑 Apagado solicitado; cerrando WhatsApp con calma...');
    try {
        await client.destroy();
    } catch (error) {
        // Si Chrome aún no había iniciado, no hay nada que cerrar
    }
    process.exit(0);
});

prepararSesion();

// Si Chrome o WhatsApp fallan al iniciar, el resto del servicio sigue operando
client.initialize().catch((error) => {
    whatsappListo = false;
    console.error('❌ WhatsApp no pudo iniciar:', error.message || error);
});

// ---------------------------------------------------------------------------
// Reporte matutino
// ---------------------------------------------------------------------------

// === REPORTE:INICIO ===
const ZONA_HORARIA = 'America/Mexico_City';

// Enlaces que el equipo consulta antes de salir (fuentes en vivo; el bot no inventa condiciones de tránsito).
const LINK_AGENDA_MARCHAS = 'https://www.ssc.cdmx.gob.mx/ciudadania/agenda-de-movilizaciones-sociales';
const LINK_GOOGLE_TRAFICO = 'https://www.google.com/maps/@19.4326,-99.1332,11z/data=!5m1!1e1';
const LINK_WAZE = 'https://www.waze.com/en/livemap';

function construirReporte(ahora = new Date(), aviso = '') {
    const fecha = ahora.toLocaleDateString('es-MX', { timeZone: ZONA_HORARIA, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const hora = ahora.toLocaleTimeString('es-MX', { timeZone: ZONA_HORARIA, hour: 'numeric', minute: '2-digit', hour12: true });

    let texto = `🚨 *REPORTE DE TRÁFICO · CDMX*\n` +
                `📅 ${fecha} · ${hora}\n\n` +
                `Buenos días, equipo TAOS 👋\n` +
                `Antes de salir, revisen el estado de las vialidades.\n\n`;

    if (aviso && aviso.trim()) {
        texto += `⚠️ *AVISOS DEL DÍA*\n${aviso.trim()}\n\n`;
    }

    texto += `📍 *Corredores clave a vigilar*\n` +
             `• Santa Fe ⇄ AICM\n` +
             `• Periférico\n` +
             `• Circuito Interior\n` +
             `• Mariano Escobedo\n\n` +
             `🔎 *Consulten antes de salir*\n` +
             `🪧 Marchas y movilizaciones (SSC):\n${LINK_AGENDA_MARCHAS}\n` +
             `🗺️ Tráfico en vivo (Google Maps):\n${LINK_GOOGLE_TRAFICO}\n` +
             `🚗 Waze en vivo:\n${LINK_WAZE}\n\n` +
             `⏱️ Salgan con margen y avisen al grupo de cualquier incidente en ruta. ¡Buena jornada! 👍🏼`;

    return texto;
}
// === REPORTE:FIN ===

// Algunas versiones de la librería devuelven el ID sin la propiedad _serialized;
// en ese caso se reconstruye con usuario y servidor.
function idDeContacto(id) {
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (id._serialized) return id._serialized;
    return (id.user && id.server) ? `${id.user}@${id.server}` : null;
}

// En México, WhatsApp puede registrar el número con o sin el "1" después del 52.
// Se prueban ambas variantes y se usa la que WhatsApp confirme como registrada.
function variantesNumero(numero) {
    const limpio = String(numero).replace(/\D/g, '');
    const variantes = [limpio];
    if (/^521\d{10}$/.test(limpio)) {
        variantes.push('52' + limpio.slice(3));
    } else if (/^52\d{10}$/.test(limpio)) {
        variantes.push('521' + limpio.slice(2));
    }
    return variantes;
}

async function resolverDestino(destino) {
    // Si ya es un ID de chat o de grupo, se usa tal cual
    if (/@(c\.us|g\.us)$/.test(destino)) return destino;

    for (const candidato of variantesNumero(destino)) {
        const id = idDeContacto(await client.getNumberId(candidato));
        if (id) return id;
    }
    throw new Error(`El número ${destino} no aparece registrado en WhatsApp (se probaron las variantes con y sin "1" después del 52).`);
}

// Si el envío al grupo falla, el aviso llega SOLO a tu número, nunca al grupo.
async function avisarFalla(motivo) {
    try {
        const chatId = await resolverDestino(NUMERO_VINCULACION);
        await client.sendMessage(chatId, `⚠️ El reporte de tráfico de hoy no se pudo enviar.\nMotivo: ${motivo}`);
    } catch (error) {
        console.error('❌ Tampoco se pudo avisar la falla a tu número:', error.message || error);
    }
}

async function enviarReporteMatutino(origen, opciones = {}) {
    const soloYo = Boolean(opciones.soloYo);
    console.log(`⏰ [${origen}] Generando reporte de tráfico para WhatsApp...`);

    if (!whatsappListo) {
        ultimoEnvio = { fecha: new Date().toISOString(), ok: false, detalle: 'WhatsApp no está conectado; el reporte no se envió.' };
        console.warn(`⚠️ ${ultimoEnvio.detalle}`);
        return ultimoEnvio;
    }

    try {
        ultimoReporteMatutino = construirReporte(new Date(), datos.aviso);
        const chatId = await resolverDestino(soloYo ? NUMERO_VINCULACION : DESTINO_REPORTE);
        await client.sendMessage(chatId, ultimoReporteMatutino);

        // El aviso especial se usa una sola vez (no se borra en las pruebas enviadas solo a ti)
        if (!soloYo && datos.aviso) {
            datos.aviso = '';
            guardarDatos(true);
        }

        ultimoEnvio = { fecha: new Date().toISOString(), ok: true, detalle: `Reporte enviado a ${chatId}` };
        console.log(`✅ ${ultimoEnvio.detalle}`);
    } catch (error) {
        const motivo = error.message || String(error);
        ultimoEnvio = { fecha: new Date().toISOString(), ok: false, detalle: motivo };
        console.error('❌ Error al enviar el reporte por WhatsApp:', error);
        await avisarFalla(motivo);
    }
    return ultimoEnvio;
}

cron.schedule('30 5 * * *', () => {
    enviarReporteMatutino('AUTOMATIZACIÓN 5:30 A.M.');
}, {
    timezone: ZONA_HORARIA
});

// Páginas y pruebas de administración (requieren ADMIN_TOKEN en Render):
//   /grupos?token=CLAVE                              -> lista de grupos detectados y avisos
//   /api/reporte-vista-previa?token=CLAVE            -> muestra el texto del reporte SIN enviarlo
//   /api/enviar-reporte-prueba?token=CLAVE&solo_yo=1 -> lo envía SOLO a tu número
//   /api/enviar-reporte-prueba?token=CLAVE           -> lo envía al destino configurado (el grupo)
function validarAdmin(req, res, token) {
    if (!TOKEN_ADMIN) {
        res.status(503).send('Deshabilitado: define la variable ADMIN_TOKEN en Render.');
        return false;
    }
    if (token !== TOKEN_ADMIN) {
        res.status(401).send('Token incorrecto.');
        return false;
    }
    return true;
}

app.get('/grupos', (req, res) => {
    if (!validarAdmin(req, res, req.query.token)) return;
    res.send(paginaGrupos(datos, DESTINO_REPORTE, req.query.token));
});

app.post('/grupos/nombre', (req, res) => {
    const { token, id, nombre } = req.body || {};
    if (!validarAdmin(req, res, token)) return;
    if (!datos.grupos[id]) return res.status(404).send('Grupo no encontrado.');

    datos.grupos[id].nombre = String(nombre || '').trim().slice(0, 80);
    guardarDatos(true);
    res.redirect(303, `/grupos?token=${encodeURIComponent(token)}`);
});

app.post('/grupos/aviso', (req, res) => {
    const { token, aviso } = req.body || {};
    if (!validarAdmin(req, res, token)) return;

    datos.aviso = String(aviso || '').trim().slice(0, 600);
    guardarDatos(true);
    res.redirect(303, `/grupos?token=${encodeURIComponent(token)}`);
});

app.get('/api/reporte-vista-previa', (req, res) => {
    if (!validarAdmin(req, res, req.query.token)) return;
    res.json({ status: 'success', reporte: construirReporte(new Date(), datos.aviso) });
});

app.get('/api/enviar-reporte-prueba', async (req, res) => {
    if (!validarAdmin(req, res, req.query.token)) return;
    const resultado = await enviarReporteMatutino('PRUEBA MANUAL', { soloYo: req.query.solo_yo === '1' });
    res.status(resultado.ok ? 200 : 500).json(resultado);
});

app.post('/api/gps', (req, res) => {
    const { device, latitude, longitude, timestamp } = req.body;

    if (!device || !latitude || !longitude) {
        return res.status(400).json({ status: "error", message: "Faltan datos de geolocalización" });
    }

    unidadesGPS[device] = {
        latitude,
        longitude,
        timestamp: timestamp || new Date().toLocaleTimeString()
    };

    console.log(`📍 Posición recibida de [${device}]: Lat ${latitude}, Lon ${longitude}`);
    res.json({ status: "success", message: "Posición transmitida en tiempo real" });
});

app.get('/api/unidades', (req, res) => {
    res.json(unidadesGPS);
});

app.get('/api/reporte-matutino', (req, res) => {
    res.json({
        status: "success",
        hora_generacion: "5:30 A.M. (Automatizado en servidor)",
        reporte: ultimoReporteMatutino,
        ultimo_envio: ultimoEnvio
    });
});

app.get('/', (req, res) => {
    let listaUnidadesHTML = "<h3>Unidades Registradas en la Red:</h3>";
    const dispositivos = Object.keys(unidadesGPS);

    if (dispositivos.length === 0) {
        listaUnidadesHTML = "<p>Esperando conexión GPS del dispositivo...</p>";
    } else {
        dispositivos.forEach(dev => {
            const u = unidadesGPS[dev];
            listaUnidadesHTML += `<div style="border:1px solid #ccc; padding:10px; margin:10px 0; border-radius:5px;">
                <strong>Dispositivo:</strong> ${dev}<br>
                <strong>Latitud:</strong> ${u.latitude}<br>
                <strong>Longitud:</strong> ${u.longitude}<br>
                <strong>Hora:</strong> ${u.timestamp}
            </div>`;
        });
    }

    const mostrarCodigo = Boolean(codigoVinculacion) && !whatsappListo;

    const estadoWhatsApp = whatsappListo
        ? '<p style="color: green; font-weight: bold;">🟢 Transmisión en Vivo Activa (WhatsApp y GPS Conectados)</p>'
        : '<p style="color: #b45309; font-weight: bold;">🟡 Servidor activo · WhatsApp sin vincular</p>';

    const codigoSeccion = mostrarCodigo
        ? `<div style="background: #222; padding: 25px; border-radius: 12px; text-align: center; margin: 20px 0;">
               <h3 style="color: #fff; margin-bottom: 10px;">🔢 Código de vinculación:</h3>
               <div style="font-size: 36px; font-family: monospace; color: #4ade80; background: #111; padding: 15px; border-radius: 8px; letter-spacing: 5px; font-weight: bold;">
                   ${codigoVinculacion}
               </div>
               <p style="color: #aaa; font-size: 14px; margin-top: 15px;">En WhatsApp: Dispositivos vinculados → Vincular dispositivo → Vincular con el número de teléfono. La página se actualiza sola cada 15 segundos.</p>
           </div>`
        : '';

    // Recarga automática solo mientras se espera la vinculación
    const recarga = mostrarCodigo ? '<meta http-equiv="refresh" content="15">' : '';

    res.send(`
        <html>
            <head>
                <title>Monitoreo Satelital - TAOS</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                ${recarga}
            </head>
            <body style="font-family: Arial, sans-serif; padding: 20px; background: #f4f4f9;">
                <h2>Monitoreo Satelital - TAOS / Best Buy</h2>
                ${estadoWhatsApp}
                ${codigoSeccion}
                <hr>
                <h3>Posición Actual de la Unidad:</h3>
                ${listaUnidadesHTML}
            </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Servidor TAOS corriendo con éxito en el puerto ${PORT}`);
});

const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Evita que un error no capturado tumbe todo el servicio (GPS, panel y cron)
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Promesa rechazada sin manejar:', reason);
});

let unidadesGPS = {};
let ultimoReporteMatutino = "Generando reporte matutino programado para las 5:30 A.M...";
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

// Alternativa a getChats() para descubrir el ID de un grupo: al escribir un mensaje en el grupo
// (desde el celular vinculado o desde otro integrante), el ID aparece una sola vez en el log.
const gruposDetectados = new Set();
client.on('message_create', (msg) => {
    try {
        const idChat = msg.fromMe ? msg.to : msg.from;
        if (typeof idChat === 'string' && idChat.endsWith('@g.us') && !gruposDetectados.has(idChat)) {
            gruposDetectados.add(idChat);
            console.log(`👥 GRUPO DETECTADO ---> ID: ${idChat}`);
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

function construirReporte() {
    const fechaHoy = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });

    return `🚨 Reporte de Tráfico y Marchas CDMX - ${fechaHoy} \n\n` +
        `Buenos días equipo TAOS. Iniciamos monitoreo proactivo de vialidad a las 5:30 A.M.\n\n` +
        `🛣️ Rutas críticas hacia AICM y corporativos listas:\n` +
        `- Paseo de la Reforma y Circuito Interior con carga habitual.\n` +
        `- Viaducto y Periférico con asentamientos moderados por incorporación.\n` +
        `- Eje Central y Constituyentes operando con normalidad.\n\n` +
        `Favor de revisar unidades asignadas y reportar check-in a tiempo. 👍🏼`;
}

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

async function enviarReporteMatutino(origen) {
    ultimoReporteMatutino = construirReporte();
    console.log(`⏰ [${origen}] Generando reporte matutino para WhatsApp...`);

    if (!whatsappListo) {
        ultimoEnvio = { fecha: new Date().toISOString(), ok: false, detalle: 'WhatsApp no está conectado; el reporte se generó pero no se envió.' };
        console.warn(`⚠️ ${ultimoEnvio.detalle}`);
        return ultimoEnvio;
    }

    try {
        const chatId = await resolverDestino(DESTINO_REPORTE);
        await client.sendMessage(chatId, ultimoReporteMatutino);
        ultimoEnvio = { fecha: new Date().toISOString(), ok: true, detalle: `Reporte enviado a ${chatId}` };
        console.log(`✅ ${ultimoEnvio.detalle}`);
    } catch (error) {
        ultimoEnvio = { fecha: new Date().toISOString(), ok: false, detalle: error.message || String(error) };
        console.error('❌ Error al enviar el reporte por WhatsApp:', error);
    }
    return ultimoEnvio;
}

cron.schedule('30 5 * * *', () => {
    enviarReporteMatutino('AUTOMATIZACIÓN 5:30 A.M.');
}, {
    timezone: "America/Mexico_City"
});

// Prueba manual: abre en el navegador  https://TU-SERVICIO.onrender.com/api/enviar-reporte-prueba?token=TU_ADMIN_TOKEN
// Requiere definir ADMIN_TOKEN en Render. Quita esa variable cuando termines las pruebas.
app.get('/api/enviar-reporte-prueba', async (req, res) => {
    if (!TOKEN_ADMIN) {
        return res.status(503).json({ status: 'error', message: 'Prueba deshabilitada: define la variable ADMIN_TOKEN en Render.' });
    }
    if (req.query.token !== TOKEN_ADMIN) {
        return res.status(401).json({ status: 'error', message: 'Token incorrecto.' });
    }

    const resultado = await enviarReporteMatutino('PRUEBA MANUAL');
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

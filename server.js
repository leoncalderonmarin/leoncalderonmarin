const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');

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

// Número de la cuenta de WhatsApp que se va a vincular (código de país + número, sin símbolos).
// Se puede cambiar desde Render con la variable de entorno WHATSAPP_PAIR_PHONE, sin tocar el código.
const NUMERO_VINCULACION = process.env.WHATSAPP_PAIR_PHONE || '5215534686687';

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.WWEBJS_DATA_PATH || './.wwebjs_auth'
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

    try {
        const chats = await client.getChats();
        console.log('--- 📋 LISTA DE CHATS Y GRUPOS DISPONIBLES ---');
        chats.forEach(chat => {
            console.log(`Nombre: ${chat.name} ---> ID: ${chat.id._serialized}`);
        });
        console.log('---------------------------------------------');
    } catch (error) {
        console.error('No se pudieron listar los chats:', error);
    }
});

// Si Chrome o WhatsApp fallan al iniciar, el resto del servicio sigue operando
client.initialize().catch((error) => {
    whatsappListo = false;
    console.error('❌ WhatsApp no pudo iniciar:', error.message || error);
});

cron.schedule('30 5 * * *', async () => {
    const fechaHoy = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });

    ultimoReporteMatutino = `🚨 Reporte de Tráfico y Marchas CDMX - ${fechaHoy} \n\n` +
        `Buenos días equipo TAOS. Iniciamos monitoreo proactivo de vialidad a las 5:30 A.M.\n\n` +
        `🛣️ Rutas críticas hacia AICM y corporativos listas:\n` +
        `- Paseo de la Reforma y Circuito Interior con carga habitual.\n` +
        `- Viaducto y Periférico con asentamientos moderados por incorporación.\n` +
        `- Eje Central y Constituyentes operando con normalidad.\n\n` +
        `Favor de revisar unidades asignadas y reportar check-in a tiempo. 👍🏼`;

    console.log("⏰ [AUTOMATIZACIÓN] Generando reporte matutino de las 5:30 A.M. para WhatsApp...");

    if (!whatsappListo) {
        console.warn("⚠️ WhatsApp no está conectado; el reporte se generó pero no se envió.");
        return;
    }

    try {
        const chatId = "5215534686687@c.us";
        await client.sendMessage(chatId, ultimoReporteMatutino);
        console.log("✅ Reporte matutino enviado con éxito por WhatsApp.");
    } catch (error) {
        console.error("❌ Error al enviar el mensaje automático por WhatsApp:", error);
    }
}, {
    timezone: "America/Mexico_City"
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
        reporte: ultimoReporteMatutino
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

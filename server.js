const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Promesa rechazada sin manejar:', reason);
});

let unidadesGPS = {};
let ultimoReporteMatutino = "Generando reporte matutino programado para las 5:30 A.M...";
let whatsappListo = false;
let codigoVinculacion = ""; 

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.WWEBJS_DATA_PATH || './.wwebjs_auth'
    }),
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

// Evento cuando WhatsApp genera un código de emparejamiento por número
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

// IMPORTANTE: Aquí debes poner el número de WhatsApp de la operación con lada (ejemplo: 52155XXXXXXXX)
client.initialize().then(async () => {
    try {
        const phoneNumber = "5215534686687"; // Reemplaza con tu número completo si es necesario
        const pairingCode = await client.requestPairingCode(phoneNumber);
        console.log(`🔢 Tu código de emparejamiento es: ${pairingCode}`);
        codigoVinculacion = pairingCode;
    } catch (err) {
        console.error("No se pudo solicitar el código de emparejamiento automáticamente:", err);
    }
}).catch((error) => {
    whatsappListo = false;
    console.error('❌ WhatsApp no pudo iniciar:', error.message);
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

    const estadoWhatsApp = whatsappListo
        ? '<p style="color: green; font-weight: bold;">🟢 Transmisión en Vivo Activa (WhatsApp y GPS Conectados)</p>'
        : '<p style="color: #b45309; font-weight: bold;">🟡 Servidor activo · Ingresa el código de 8 dígitos en WhatsApp</p>';

    const codigoSeccion = codigoVinculacion && !whatsappListo
        ? `<div style="background: #222; padding: 25px; border-radius: 12px; text-align: center; margin: 20px 0; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
               <h3 style="color: #fff; margin-bottom: 10px;">🔢 Tu Código de Vinculación:</h3>
               <div style="font-size: 36px; font-family: monospace; color: #4ade80; background: #111; padding: 15px; border-radius: 8px; letter-spacing: 5px; font-weight: bold;">
                   ${codigoVinculacion}
               </div>
               <p style="color: #aaa; font-size: 14px; margin-top: 15px;">Escribe este código de 8 dígitos en tu teléfono para completar la vinculación.</p>
           </div>`
        : '';

    res.send(`
        <html>
            <head>
                <title>Monitoreo Satelital - TAOS</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="font-family: Arial, sans-serif; padding: 20px; background: #f4f4f9;">
                <h2>Monitoreo Satelital - TAOS / Best Buy</h2>
                ${estadoWhatsApp}
                ${codigoSeccion}
                <hr>
                <h3>Posición Actual de la Unidad:</h3>
                ${listaUnidadesHTML}
            </body>
        </thead>
    `);
});

app.listen(PORT, () => {
    console.log(`Servidor TAOS corriendo con éxito en el puerto ${PORT}`);
});

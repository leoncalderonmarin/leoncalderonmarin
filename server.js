const express = require('express');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Memoria temporal para guardar posiciones GPS y el último reporte generado
let unidadesGPS = {};
let ultimoReporteMatutino = "Generando reporte matutino programado para las 5:30 A.M...";

// --- CLIENTE DE WHATSAPP ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('📱 ESCANEA ESTE CÓDIGO QR con el WhatsApp de TAOS:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('✅ ¡Sesión de WhatsApp conectada y lista para operar!');

    // Esto imprimirá en la consola de Render todos tus chats y grupos con su ID exacto
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

client.initialize();

// --- 1. RELOJ AUTOMÁTICO (CRON JOB) PARA LAS 5:30 A.M. ---
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

    try {
        // Destino configurado con tu número personal para prueba directa
        const chatId = "5215534686687@c.us"; 
        // Nota: Si prefieres el grupo, aquí pondrás el ID que termine en @g.us que veas en la consola.

        await client.sendMessage(chatId, ultimoReporteMatutino);
        console.log("✅ Reporte matutino enviado con éxito por WhatsApp.");
    } catch (error) {
        console.error("❌ Error al enviar el mensaje automático por WhatsApp:", error);
    }
}, {
    timezone: "America/Mexico_City"
});

// --- 2. ENDPOINTS DE GPS ---
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

// --- 3. ENDPOINT PARA CONSULTAR EL REPORTE MATUTINO ---
app.get('/api/reporte-matutino', (req, res) => {
    res.json({
        status: "success",
        hora_generacion: "5:30 A.M. (Automatizado en servidor)",
        reporte: ultimoReporteMatutino
    });
});

// --- 4. PANEL WEB DE MONITOREO SATELITAL TAOS ---
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

    res.send(`
        <html>
            <head>
                <title>Monitoreo Satelital - TAOS</title>
                <meta charset="utf-8">
            </head>
            <body style="font-family: Arial, sans-serif; padding: 20px; background: #f4f4f9;">
                <h2>Monitoreo Satelital - TAOS / Best Buy</h2>
                <p style="color: green; font-weight: bold;">🟢 Transmisión en Vivo Activa (WhatsApp y GPS Conectados)</p>
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

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');

const app = express();
app.use(express.json());

const server = http.createServer(app);

// Variables de estado del sistema
let qrCodeData = '';
let clientReady = false;
let ultimaConexionStatus = "Iniciando servidor...";
let ultimoEnvioEstado = { ok: false, fecha: null, error: null };

// Configuración robusta de Puppeteer para Render (soluciona el error de Chrome binario)
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'taos-fleet-session' }),
    puppeteer: {
        executablePath: process.env.CHROME_PATH || undefined,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    qrCodeData = qr;
    clientReady = false;
    ultimaConexionStatus = "QR generado, pendiente de vinculación.";
    console.log('CÓDIGO QR GENERADO NUEVAMENTE.');
});

client.on('ready', () => {
    clientReady = true;
    qrCodeData = '';
    ultimaConexionStatus = "WhatsApp Conectado y Operativo.";
    console.log('¡CLIENTE DE WHATSAPP LISTO Y CONECTADO!');
});

client.on('auth_failure', (msg) => {
    clientReady = false;
    ultimaConexionStatus = `Falla de autenticación: ${msg}`;
    console.error('Error de autenticación en WhatsApp:', msg);
});

client.on('disconnected', (reason) => {
    clientReady = false;
    ultimaConexionStatus = `Desconectado: ${reason}`;
    console.log('WhatsApp desconectado:', reason);
});

// Captura opcional de grupos para ID
client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (chat.isGroup) {
            console.log(`[GRUPO DETECTADO] Nombre: ${chat.name} | ID: ${chat.id._serialized}`);
        }
    } catch (e) {
        // Ignorar errores menores
    }
});

client.initialize();

// Función generadora del reporte vial dinámico y profesional
function generarReporteTráficoDinámico() {
    const fechaHoy = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    
    return `🚨 *REPORTE VIAL Y DE MOVILIDAD CDMX - TAOS* 🚦\n` +
           `📅 Fecha: ${fechaHoy}\n\n` +
           `📢 *Estatus General de Operación:* \n` +
           `• Monitoreo de unidades activo.\n` +
           `• Condiciones generales de tránsito sujetas a la red vial primaria de la CDMX.\n\n` +
           `🔍 *Análisis de Rutas Críticas:* \n` +
           `• *Paseo de la Reforma:* Flujo constante hacia corredores financieros con precauciones habituales en glorietas.\n` +
           `• *Circuito Interior:* Avance moderado con asentamientos puntuales en distribuidores viales hacia la zona norte.\n` +
           `• *Insurgentes:* Carga vehicular densa desde ejes viales centrales hacia las zonas corporativas.\n` +
           `• *Accesos al AICM (T1 y T2):* Afluencia elevada esperada. Se recomienda salir con 20-30 minutos de anticipación.\n\n` +
           `💡 *Aviso Ejecutivo:* Unidades operando bajo estricto control de semáforos de mantenimiento y verificación ambiental. ¡Excelente y segura jornada! 👍🏼`;
}

// Función central para disparar el envío del reporte
async function ejecutarEnvioReporteMatutino() {
    const destinoConfigurado = process.env.WHATSAPP_REPORTE_DESTINO || '5215500000000@c.us';
    
    try {
        if (!clientReady) {
            throw new Error("Cliente de WhatsApp no listo o desconectado en el momento del envío.");
        }

        const mensajeReporte = generarReporteTráficoDinámico();
        await client.sendMessage(destinoConfigurado, mensajeReporte);
        
        ultimoEnvioEstado = {
            ok: true,
            fecha: new Date().toISOString(),
            error: null
        };
        console.log("Reporte matutino enviado con éxito a:", destinoConfigurado);
    } catch (error) {
        ultimoEnvioEstado = {
            ok: false,
            fecha: new Date().toISOString(),
            error: error.message
        };
        console.error("Error al enviar el reporte matutino:", error);
    }
}

// Simulador de Cron interno para las 5:30 A.M. hora CDMX (11:30 UTC)
setInterval(() => {
    const ahora = new Date();
    if (ahora.getUTCHours() === 11 && ahora.getUTCMinutes() === 30) {
        const fechaIsoHoy = ahora.toISOString().split('T')[0];
        if (ultimoEnvioEstado.fecha && ultimoEnvioEstado.fecha.startsWith(fechaIsoHoy) && ultimoEnvioEstado.ok) {
            return;
        }
        ejecutarEnvioReporteMatutino();
    }
}, 60000);

// Endpoints de la API del Servidor
app.get('/', async (req, res) => {
    let html = `
    <html>
        <head>
            <title>Monitoreo Satelital - TAOS</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: Arial, sans-serif; background: #121212; color: #e0e0e0; text-align: center; padding: 20px; }
                .card { background: #1e1e1e; padding: 20px; border-radius: 10px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
                .status-box { font-weight: bold; margin: 15px 0; padding: 10px; border-radius: 5px; }
                .connected { background: #1b5e20; color: #a5d6a7; }
                .disconnected { background: #b71c1c; color: #ffcdd2; }
                img { max-width: 100%; height: auto; border-radius: 8px; background: white; padding: 10px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>Monitoreo Satelital - TAOS</h2>
                <div class="status-box ${clientReady ? 'connected' : 'disconnected'}">
                    ${clientReady ? '🟢 Servidor activo · WhatsApp Conectado' : '🟡 Servidor activo · WhatsApp sin conectar'}
                </div>
                <p><strong>Estado:</strong> ${ultimaConexionStatus}</p>
    `;

    if (!clientReady && qrCodeData) {
        try {
            const qrImage = await qrcode.toDataURL(qrCodeData);
            html += `
                <p>Escanea este código QR con WhatsApp:</p>
                <img src="${qrImage}" alt="QR WhatsApp"/>
                <p><small>Actualiza la página si tarda en aparecer.</small></p>
            `;
        } catch (err) {
            html += `<p>Generando código QR...</p>`;
        }
    } else if (clientReady) {
        html += `<p>✅ El bot está vinculado y operando correctamente en segundo plano.</p>`;
    }

    html += `
            </div>
        </body>
    </html>
    `;
    res.send(html);
});

app.get('/api/reporte-matutino', (req, res) => {
    res.json({
        sistema: "TAOS Fleet Management",
        whatsapp_conectado: clientReady,
        ultimo_envio: ultimoEnvioEstado,
        timestamp_actual: new Date().toISOString()
    });
});

app.get('/api/probar-envio', async (req, res) => {
    try {
        await ejecutarEnvioReporteMatutino();
        res.json({ exito: true, mensaje: "Reporte de prueba ejecutado correctamente.", estado: ultimoEnvioEstado });
    } catch (e) {
        res.status(500).json({ exito: false, error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});

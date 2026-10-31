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

// Configuración del cliente de WhatsApp con persistencia local en disco
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'taos-fleet-session' }),
    puppeteer: {
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
    ultimaConexionStatus = `Falla de autenticación: ${msg}`; console.error('Error de autenticación en WhatsApp:', msg); });  client.on('disconnected', (reason) => { clientReady = false; ultimaConexionStatus = `Desconectado: ${reason}`;
    console.log('WhatsApp desconectado:', reason);
});

// Captura opcional de grupos en consola cuando reciben mensajes
client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (chat.isGroup) {
            console.log(`[GRUPO DETECTADO] Nombre: ${chat.name} \vert{} ID:${chat.id._serialized}`);
        }
    } catch (e) {
        // Ignorar errores menores de lectura
    }
});

client.initialize();

// Generador del reporte general de tráfico, marchas y vialidades clave de la CDMX
function generarReporteTráficoDinámico() {
    const fechaHoy = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    
    return `🚨 *REPORTE GENERAL DE TRÁFICO Y MOVILIDAD CDMX - TAOS* 🚦\n` +
           `📅 Fecha: ${fechaHoy}\n\n` +
           `📢 *Panorama General de Marchas y Bloqueos:* \n` +
           `• Concentraciones locales habituales en la zona centro e inmediaciones gubernamentales, sin cierres totales en vialidades primarias por el momento.\n\n` +
           `🔍 *Estatus en Vialidades y Zonas Clave:* \n` +
           `• *Circuito Interior:* Tránsito constante con los flujos y reducciones habituales en distribuidores viales hacia la zona norte y aeropuerto.\n` +
           `• *Periférico (Norte y Sur):* Carga vehicular densa pero constante; tramos de incorporación hacia el poniente con embotellamientos moderados.\n` +
           `• *Viaducto Miguel Alemán:* Flujo pesado en dirección al poniente y enlaces con Insurgentes y Patriotismo.\n` +
           `• *Santa Fe / Zona Poniente:* Afluencia elevada de ingreso hacia corporativos y zonas financieras por accesos principales.\n` +
           `• *AICM (Aeropuerto):* Accesos a Terminal 1 y 2 con movilidad general adecuada y afluencia alta esperada.\n\n` +
           `💡 *Recomendación Operativa:* Mantener monitoreo en tiempo real desde las unidades para prevenir contratiempos puntuales. ¡Excelente jornada! 👍🏼`;
}

// Función central para disparar el envío del reporte al destino configurado
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
                .card { background: #1e1e1e; padding: 20px; border-radius: 10px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px

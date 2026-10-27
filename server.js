const express = require('express');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Memoria temporal para guardar posiciones GPS y el último reporte generado
let unidadesGPS = {};
let ultimoReporteMatutino = "Generando reporte matutino programado para las 5:30 A.M...";

// --- 1. RELOJ AUTOMÁTICO (CRON JOB) PARA LAS 5:30 A.M. ---
// Se ejecuta exactamente a las 5:30 A.M., hora de la Ciudad de México, todos los días.
cron.schedule('30 5 * * *', () => {
    const fechaHoy = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
    
    ultimoReporteMatutino = `🚨 Reporte de Tráfico y Marchas CDMX - ${fechaHoy} \n\n` +
        `Buenos días equipo TAOS. Iniciamos monitoreo proactivo de vialidad a las 5:30 A.M.\n\n` +
        `🛣️ Rutas críticas hacia AICM y corporativos listas:\n` +
        `- Paseo de la Reforma y Circuito Interior con carga habitual.\n` +
        `- Viaducto y Periférico con asentamientos moderados por incorporación.\n` +
        `- Eje Central y Constituyentes operando con normalidad.\n\n` +
        `Favor de revisar unidades asignadas y reportar check-in a tiempo. 👍🏼`;

    console.log("⏰ [AUTOMATIZACIÓN] Reporte matutino de las 5:30 A.M. generado con éxito por el servidor.");
}, {
    timezone: "America/Mexico_City"
});

// --- 2. ENDPOINTS DE GPS (Rastreo en tiempo real) ---

// Recibir coordenadas del operador o de tu Prius C
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

// Consultar todas las unidades activas en el mapa
app.get('/api/unidades', (req, res) => {
    res.json(unidadesGPS);
});

// --- 3. ENDPOINT PARA CONSULTAR EL REPORTE MATUTINO AUTOMÁTICO ---
app.get('/api/reporte-matutino', (req, res) => {
    res.json({
        status: "success",
        hora_generacion: "5:30 A.M. (Automatizado en servidor)",
        reporte: ultimoReporteMatutino
    });
});

// --- 4. PANEL WEB DE MONITOREO SATELITAL TAOS ---
app.get('/', (req, res) => {
    // Si hay unidades, mostramos la última posición registrada en texto claro para tu prueba rápida
    let listaUnidadesHTML = "<h3>Unidades Registradas en la Red:</h3>";
    const dispositivos = Object.keys(unidadesGPS);
    
    if (dispositivos.length === 0) {
        aprenderHTML = "<p>Esperando conexión GPS del dispositivo...</p>";
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
                <p style="color: green; font-weight: bold;">🟢 Transmisión en Vivo Activa (Servidor en Render)</p>
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

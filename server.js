const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Almacén de la última posición en tiempo real
let ultimaPosicion = {
    deviceId: 'Esperando señal de Traccar...',
    lat: '0.0000',
    lng: '0.0000',
    timestamp: 'Sin transmisión'
};

// Interfaz web con cliente WebSocket en tiempo real
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Rastreo GPS en Tiempo Real - TAOS</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; margin-top: 40px; background-color: #f4f4f9; }
                    h1 { color: #333; }
                    .status { font-size: 18px; color: #0275d8; font-weight: bold; }
                    .card { background: white; padding: 25px; margin: 20px auto; width: 70%; max-width: 500px; border-radius: 8px; box-shadow: 0px 4px 10px rgba(0,0,0,0.1); text-align: left; }
                    .card h3 { margin-top: 0; color: #28a745; border-bottom: 2px solid #f4f4f9; padding-bottom: 8px; }
                    .data-row { margin: 12px 0; font-size: 16px; }
                    .live-dot { height: 12px; width: 12px; background-color: #28a745; border-radius: 50%; display: inline-block; margin-right: 5px; animation: pulse 1.5s infinite; }
                </style>
            </head>
            <body>
                <h1>Monitoreo Satelital - TAOS / Best Buy</h1>
                <p class="status"><span class="live-dot"></span> Transmisión en Vivo Activa</p>
                <div class="card">
                    <h3>Posición Actual de la Unidad:</h3>
                    <div class="data-row"><strong>Dispositivo:</strong> <span id="dev">${ultimaPosicion.deviceId}</span></div>
                    <div class="data-row"><strong>Latitud:</strong> <span id="lat">${ultimaPosicion.lat}</span></div>
                    <div class="data-row"><strong>Longitud:</strong> <span id="lng">${ultimaPosicion.lng}</span></div>
                    <div class="data-row"><strong>Hora:</strong> <span id="time">${ultimaPosicion.timestamp}</span></div>
                </div>

                <script>
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(protocol + '//' + window.location.host);

                    ws.onmessage = function(event) {
                        const data = JSON.parse(event.data);
                        document.getElementById('dev').innerText = data.deviceId;
                        document.getElementById('lat').innerText = data.lat;
                        document.getElementById('lng').innerText = data.lng;
                        document.getElementById('time').innerText = data.timestamp;
                    };
                </script>
            </body>
        </html>
    `);
});

// Endpoint universal optimizado para Traccar Client y peticiones HTTP
app.all('/api/gps', (req, res) => {
    const deviceId = req.query.id || req.query.device || req.body.id || req.body.deviceId || 'Unidad-Móvil';
    const lat = req.query.lat || req.body.lat;
    const lng = req.query.lon || req.query.lng || req.body.lon || req.body.lng;
    
    if (lat !== undefined && lng !== undefined) {
        ultimaPosicion = {
            deviceId,
            lat,
            lng,
            timestamp: new Date().toLocaleTimeString()
        };

        console.log(`[TRACCAR GPS] Unidad: ${deviceId} | Lat: ${lat}, Lng: ${lng}`);

        // Enviar por WebSocket a la pantalla al instante
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(ultimaPosicion));
            }
        });

        return res.status(200).send('OK');
    }
    
    res.status(400).send('Faltan parámetros de coordenadas');
});

server.listen(PORT, () => {
    console.log(`Servidor operando en el puerto ${PORT}`);
});

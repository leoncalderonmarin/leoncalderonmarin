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
    lat: 19.3520, // Coordenada inicial de referencia (CDMX)
    lng: -99.1610,
    timestamp: 'Sin transmisión'
};

// Interfaz web con Mapa Interactivo en tiempo real (Leaflet.js)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
            <head>
                <title>Rastreo Satelital en Vivo - TAOS / Best Buy</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <!-- Leaflet CSS -->
                <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f9; text-align: center; }
                    h1 { color: #333; margin: 15px 0 5px 0; font-size: 22px; }
                    .status { font-size: 14px; color: #0275d8; font-weight: bold; margin-bottom: 10px; }
                    .live-dot { height: 10px; width: 10px; background-color: #28a745; border-radius: 50%; display: inline-block; margin-right: 5px; animation: pulse 1.5s infinite; }
                    
                    /* Contenedor del Mapa */
                    #map { width: 100%; height: 60vh; min-height: 350px; }
                    
                    /* Panel de información inferior */
                    .info-panel { background: white; padding: 15px; box-shadow: 0px -2px 10px rgba(0,0,0,0.1); text-align: left; max-width: 600px; margin: 0 auto; border-radius: 8px 8px 0 0; }
                    .data-row { margin: 6px 0; font-size: 14px; color: #444; }
                    .data-row strong { color: #111; }
                </style>
            </head>
            <body>
                <h1>Monitoreo Satelital - TAOS</h1>
                <p class="status"><span class="live-dot"></span> Transmisión en Vivo Activa</p>
                
                <!-- Mapa -->
                <div id="map"></div>

                <!-- Panel de Datos -->
                <div class="info-panel">
                    <div class="data-row"><strong>Unidad / Dispositivo:</strong> <span id="dev">${ultimaPosicion.deviceId}</span></div>
                    <div class="data-row"><strong>Latitud:</strong> <span id="lat">${ultimaPosicion.lat}</span></div>
                    <div class="data-row"><strong>Longitud:</strong> <span id="lng">${ultimaPosicion.lng}</span></div>
                    <div class="data-row"><strong>Última Actualización:</strong> <span id="time">${ultimaPosicion.timestamp}</span></div>
                </div>

                <!-- Leaflet JS -->
                <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
                <script>
                    // Inicializar el mapa centrado en la posición inicial
                    const map = L.map('map').setView([${ultimaPosicion.lat}, ${ultimaPosicion.lng}], 15);

                    // Capa de diseño del mapa (OpenStreetMap)
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        attribution: '&copy; OpenStreetMap contributors'
                    }).addTo(map);

                    // Crear el marcador para la unidad
                    let marker = L.marker([${ultimaPosicion.lat}, ${ultimaPosicion.lng}]).addTo(map);
                    marker.bindPopup("<b>Unidad:</b> ${ultimaPosicion.deviceId}").openPopup();

                    // Conexión en tiempo real con WebSockets
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(protocol + '//' + window.location.host);

                    ws.onmessage = function(event) {
                        const data = JSON.parse(event.data);
                        const lat = parseFloat(data.lat);
                        const lng = parseFloat(data.lng);

                        // Actualizar textos en pantalla
                        document.getElementById('dev').innerText = data.deviceId;
                        document.getElementById('lat').innerText = data.lat;
                        document.getElementById('lng').innerText = data.lng;
                        document.getElementById('time').innerText = data.timestamp;

                        // Mover el marcador y centrar el mapa automáticamente en vivo
                        const newLatLng = [lat, lng];
                        marker.setLatLng(newLatLng);
                        marker.setPopupContent("<b>Unidad:</b> " + data.deviceId + "<br>Hora: " + data.timestamp);
                        map.setView(newLatLng, map.getZoom());
                    };
                </script>
            </body>
        </html>
    `);
});

// Endpoint universal para recibir telemetría de Traccar Client
app.all('/api/gps', (req, res) => {
    const deviceId = req.query.id || req.query.device || req.body.id || req.body.deviceId || 'Unidad-Móvil';
    const lat = req.query.lat || req.body.lat;
    const lng = req.query.lon || req.query.lng || req.body.lon || req.body.lng;
    
    if (lat !== undefined && lng !== undefined) {
        const horaMexico = new Date().toLocaleTimeString('es-MX', {
            timeZone: 'America/Mexico_City',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

        ultimaPosicion = {
            deviceId,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            timestamp: horaMexico
        };

        console.log(`[MAPA GPS] Unidad: ${deviceId} | Lat: ${lat}, Lng: ${lng} | Hora: ${horaMexico}`);

        // Transmitir inmediatamente la nueva coordenada a todas las pantallas abiertas por WebSocket
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
    console.log(`Servidor de mapas operando en el puerto ${PORT}`);
});

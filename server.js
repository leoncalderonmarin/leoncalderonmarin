const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Prueba GPS - TAOS</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; background-color: #f4f4f9; }
                    h1 { color: #333; }
                    .status { font-size: 20px; color: green; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Sistema de Rastreo GPS - Servidor Activo</h1>
                <p class="status">Conexión establecida correctamente con el servidor virtual.</p>
                <p>Esperando coordenadas de la unidad y conexión con el mapa...</p>
            </body>
        </html>
    `);
});

app.post('/api/gps', (req, res) => {
    const { deviceId, lat, lng, timestamp } = req.body;
    console.log(`[GPS RECIBIDO] Dispositivo: ${deviceId} | Lat: ${lat} | Lng: ${lng} | Hora: ${timestamp}`);
    res.status(200).json({ status: 'success', message: 'Coordenada registrada correctamente' });
});

app.listen(PORT, () => {
    console.log(`Servidor de prueba corriendo en el puerto ${PORT}`);
});

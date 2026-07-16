// ms-tutorias/src/app.js

const express = require('express');
const config = require('./config'); // Importamos nuestra configuración centralizada
const tutoriasRouter = require('./api/routes/tutorias.routes');
const errorHandler = require('./api/middlewares/errorHandler'); // El manejador de errores reutilizable
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');
const promBundle = require("express-prom-bundle");
const messageProducer = require('./infrastructure/messaging/message.producer');
const outboxPublisher = require('./infrastructure/messaging/outbox.publisher');
const compensacionWorker = require('./infrastructure/workers/compensacion.worker');

const app = express();
const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    includeUp: true,
    customLabels: { project_name: 'tutorias_app', service_name: process.env.SERVICE_NAME || 'unknown_service' },
    promClient: {
        collectDefaultMetrics: {
        }
    },
    buckets: [0.1, 0.5, 1, 1.5, 5, 10]
});
app.use(metricsMiddleware);

// Middlewares esenciales
app.use(express.json()); // Permite al servidor entender y procesar bodies en formato JSON
app.use(correlationIdMiddleware); // Añadimos el middleware de correlationIdMiddleware

// Enrutamiento principal
// Cualquier petición a "/tutorias" será gestionada por nuestro router.
app.use('/tutorias', tutoriasRouter);

// Middleware de manejo de errores
// Debe ser el ÚLTIMO middleware que se añade.
app.use(errorHandler);

// Iniciar el servidor
// Iniciar el servidor
if (require.main === module) {
    app.listen(config.port, () => {
        console.log(`MS_Tutorias (Orquestador) escuchando en el puerto ${config.port}`);
        messageProducer.connect(); // Iniciar la conexión al RabbitMQ
        outboxPublisher.start(); // Poller del patrón outbox (D2)
        compensacionWorker.start(); // Worker de reintentos de compensación de agenda (D6)
    });
}

module.exports = app;
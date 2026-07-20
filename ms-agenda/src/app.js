// ms-agenda/src/app.js
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config'); // <-- USAR EL NUEVO CONFIG
const agendaRouter = require('./api/routes/agenda.routes');
const errorHandler = require('./api/middlewares/errorHandler');
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');
const requestLogger = require('./api/middlewares/requestLogger.js');
const messageProducer = require('./infrastructure/messaging/message.producer'); // <-- IMPORTAR PRODUCTOR
const promBundle = require("express-prom-bundle");

const app = express();

app.use(helmet());
app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    includeUp: true,
    customLabels: { project_name: 'tutorias_app', service_name: process.env.SERVICE_NAME || 'unknown_service' },
    promClient: {
        collectDefaultMetrics: {
        }
    }
});
app.use(metricsMiddleware);

app.use(express.json());
app.use(correlationIdMiddleware);
app.use(requestLogger);
app.use('/agenda', agendaRouter);
app.use(errorHandler);

if (require.main === module) {
    app.listen(config.port, () => { // <-- Usar config.port
        console.log(`MS_Agenda escuchando en el puerto ${config.port}`);
        messageProducer.connect(); // <-- INICIAR CONEXIÓN A RABBITMQ
    });
}

module.exports = app;

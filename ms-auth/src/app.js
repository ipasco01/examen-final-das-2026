// ms-auth/src/app.js

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const authRouter = require('./api/routes/auth.routes'); // Importa el enrutador
const errorHandler = require('./api/middlewares/errorHandler');
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');
const requestLogger = require('./api/middlewares/requestLogger.js');
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

// Aquí se usa la variable 'authRouter'. Si el archivo importado no exporta
// una función, aquí es donde Express falla.
app.use('/auth', authRouter);

app.use(errorHandler);

if (require.main === module) {
    app.listen(config.port, () => {
        console.log(`MS_Auth escuchando en el puerto ${config.port}`);
    });
}

module.exports = app;

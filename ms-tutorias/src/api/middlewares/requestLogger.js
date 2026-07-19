const pinoHttp = require('pino-http');
const logger = require('../../config/logger');

const requestLogger = pinoHttp({
    logger,
    // customProps inyecta campos extra en la línea de log de CADA request.
    // Aquí es donde el correlationId entra al log: sin esto, Loki nunca
    // podría filtrar logs de este servicio por ese id.
    customProps: (req) => ({
        correlationId: req.correlationId,
    }),
    // El endpoint /metrics lo scrapea Prometheus cada 5s: si lo logueamos,
    // ensuciamos Loki con ruido que no aporta nada para debug.
    autoLogging: {
        ignore: (req) => req.url === '/metrics',
    },
    // Pino-http por defecto loguea todo como "info". Esto sube el nivel
    // automáticamente si la respuesta fue error, para que sea más fácil
    // filtrar por severidad en Grafana.
    customLogLevel: (req, res, err) => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
    },
});

module.exports = requestLogger;
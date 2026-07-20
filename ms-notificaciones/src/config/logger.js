const pino = require('pino');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    // "base" agrega estos campos a TODAS las líneas que emita este logger,
    // sin que cada llamada a logger.info(...) tenga que repetirlos.
    base: {
        service: process.env.SERVICE_NAME || 'unknown_service',
    },
    // Timestamp en formato ISO legible (por defecto Pino usa epoch en ms).
    timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
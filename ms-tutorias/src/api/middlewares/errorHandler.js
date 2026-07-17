// src/api/middlewares/errorHandler.js

const errorHandler = (err, req, res, next) => {
    console.error(`[ERROR] ${new Date().toISOString()}:`, err);

    const statusCode = err.statusCode || 500;
    // E3: mismo criterio que ms-agenda/ms-usuarios/ms-auth/ms-notificaciones -- un error sin
    // statusCode explícito es un 500 no controlado, así que no reenviamos su err.message (puede
    // traer detalle interno) y devolvemos uno genérico en su lugar.
    const errorMessage = err.statusCode ? err.message : 'Ocurrió un error inesperado en el servidor.';

    res.status(statusCode).json({
        error: {
            message: errorMessage,
            statusCode: statusCode
        }
    });
};

module.exports = errorHandler;
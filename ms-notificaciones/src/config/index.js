// ms-notificaciones/src/config/index.js
require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3003,
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://localhost:5672',

    // David: SE AGREGA jwtSecret. jwt.middleware.js lo necesita para poder
    // verificar la firma del token (jwt.verify(token, config.jwtSecret)) --
    // sin esto, la validación del "carnet" no tendría con qué comparar.
    // IMPORTANTE: debe ser EL MISMO secreto que usa ms-auth para FIRMAR los
    // tokens (mismo valor de variable de entorno JWT_SECRET en ambos
    // servicios), si no, todos los tokens se verían como "inválidos" aquí
    // aunque hayan sido emitidos correctamente por ms-auth.
    jwtSecret: process.env.JWT_SECRET
};
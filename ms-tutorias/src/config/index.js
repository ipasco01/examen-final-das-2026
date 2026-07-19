// ms-tutorias/src/config/index.js
require('dotenv').config();

const config = {
    port: process.env.PORT || 3000, // Puerto del servicio de tutorías
    usuariosServiceUrl: process.env.MS_USUARIOS_URL, // URL del servicio de usuarios
    agendaServiceUrl: process.env.MS_AGENDA_URL, // URL del servicio de agenda
    notificacionesServiceUrl: process.env.MS_NOTIFICACIONES_URL, // URL del servicio de notificaciones
    jwtSecret: process.env.JWT_SECRET, // Secreto para JWT
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://localhost:5672' // URL de conexión a RabbitMQ
};

// S4: sin esto, una config faltante fallaba recién en el primer request, con un síntoma engañoso
// -- sin JWT_SECRET, el 100% de los requests se veían como "401 Token inválido" (jwt.verify con
// secreto undefined) en vez de un error de arranque claro; sin las URLs de usuarios/agenda, axios
// lanzaba un error de red que el catch-all sanitiza a un "500 genérico", sin ninguna pista de que
// la causa era una variable de entorno faltante. Mismo criterio que ya usa ms-auth para JWT_SECRET.
const VARIABLES_REQUERIDAS = {
    JWT_SECRET: config.jwtSecret,
    MS_USUARIOS_URL: config.usuariosServiceUrl,
    MS_AGENDA_URL: config.agendaServiceUrl
};
const faltantes = Object.entries(VARIABLES_REQUERIDAS)
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre);
if (faltantes.length > 0) {
    throw new Error(`FATAL ERROR: faltan variables de entorno requeridas: ${faltantes.join(', ')}.`);
}

module.exports = config;
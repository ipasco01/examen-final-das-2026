require('dotenv').config();
module.exports = {
    apiBaseUrl: process.env.API_BASE_URL,
    authServiceUrl: process.env.AUTH_SERVICE_URL,

    // Tercera dependencia del simulador, y la unica que NO pasa por el orquestador: se usa solo
    // para poblar el desplegable de tutor+materia. Vale la pena notar el acoplamiento nuevo --
    // hasta ahora el cliente hablaba con ms-auth (para el token) y con ms-tutorias (para todo lo
    // demas). Es aceptable porque es una lectura de catalogo, no parte de la Saga: si ms-usuarios
    // no responde, el selector queda vacio pero solicitar/cancelar/reprogramar siguen andando.
    usuariosServiceUrl: process.env.USUARIOS_SERVICE_URL
};
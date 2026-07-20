// ms-notificaciones/src/api/routes/notificaciones.routes.js
const express = require('express');
const router = express.Router();
const notificacionesController = require('../controllers/notificaciones.controller');

// David: SE AGREGA el import del middleware. Antes no existía, y era el
// único servicio de los 5 sin este "portero" en su ruta -- cualquiera con
// la URL podía mandar notificaciones sin identificarse.
const jwtMiddleware = require('../middlewares/jwt.middleware');

// David: jwtMiddleware se pone como segundo argumento. Express ejecuta los
// middlewares EN ORDEN: primero corre jwtMiddleware; si el token es válido,
// llama a next() y recién ahí se ejecuta postNotificacion. Si el token NO
// es válido, jwtMiddleware responde 401 y postNotificacion nunca se
// ejecuta -- la petición se corta ahí, como una chapa en la puerta.
router.post('/:canal', jwtMiddleware, notificacionesController.postNotificacion);

module.exports = router;
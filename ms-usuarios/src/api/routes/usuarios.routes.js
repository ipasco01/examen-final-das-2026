// src/api/routes/usuarios.routes.js

const express = require('express');
const router = express.Router();
const usuariosController = require('../controllers/usuarios.controller');
const verifyTokenMiddleware = require('../middlewares/jwt.middleware');

router.get('/estudiantes/:id', verifyTokenMiddleware, usuariosController.obtenerEstudiante);

// OJO CON EL ORDEN: esta ruta va ANTES que '/tutores/:id'. Express evalua en orden de
// declaracion, asi que si '/tutores/:id' estuviera primero capturaria cualquier GET a /tutores
// tratando el segmento siguiente como un id. Aca no colisionan (una tiene segmento extra y la
// otra no), pero dejarlas en este orden evita el problema si mañana alguien agrega
// '/tutores/:id/algo'. Es la clase de bug que solo aparece al agregar la tercera ruta.
router.get('/tutores', verifyTokenMiddleware, usuariosController.listarTutores);
router.get('/tutores/:id', verifyTokenMiddleware, usuariosController.obtenerTutor);

// Catálogo de materias (deuda #14): expone de dónde poblar un <select> de materias en el cliente,
// que antes no existía porque `especialidad` era texto libre sin catálogo.
router.get('/materias', verifyTokenMiddleware, usuariosController.listarMaterias);

module.exports = router;
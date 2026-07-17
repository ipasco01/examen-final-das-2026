// src/api/routes/usuarios.routes.js

const express = require('express');
const router = express.Router();
const usuariosController = require('../controllers/usuarios.controller');
const verifyTokenMiddleware = require('../middlewares/jwt.middleware');

router.get('/estudiantes/:id', verifyTokenMiddleware, usuariosController.obtenerEstudiante);
router.get('/tutores/:id', verifyTokenMiddleware, usuariosController.obtenerTutor);

module.exports = router;
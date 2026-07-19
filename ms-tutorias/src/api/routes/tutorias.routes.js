// ms-tutorias/src/api/routes/tutorias.routes.js

const express = require('express');
const router = express.Router();
const tutoriasController = require('../controllers/tutorias.controller');
const verifyTokenMiddleware = require('../middlewares/jwt.middleware.js'); // <-- 1. Importar el middleware

// 2. Añadir el middleware a la ruta que queremos proteger.
// Se ejecutará DESPUÉS de recibir la petición y ANTES de que llegue al controlador.
router.post('/', verifyTokenMiddleware, tutoriasController.postSolicitud);

// Listado de "mis tutorías" del estudiante autenticado. Va antes de /:id -- son patrones
// distintos (exacto vs. con parámetro) y Express no los confunde, pero el orden de lectura ayuda.
router.get('/', verifyTokenMiddleware, tutoriasController.getTutoriasDelEstudiante);

// S8: permite a un cliente consultar el estado de una tutoría después de crearla (ej. una que
// quedó PENDIENTE por una respuesta lenta), en vez de no tener ningún camino de vuelta.
router.get('/:id', verifyTokenMiddleware, tutoriasController.getTutoriaPorId);

// Cancelación de una tutoría CONFIRMADA (cierra el gap de CANCELADA documentado en S11).
router.delete('/:id', verifyTokenMiddleware, tutoriasController.cancelarTutoria);

module.exports = router;
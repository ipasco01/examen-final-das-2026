const express = require('express');
const router = express.Router();
const agendaController = require('../controllers/agenda.controller');
const verifyTokenMiddleware = require('../middlewares/jwt.middleware');

router.get('/tutores/:id_tutor/disponibilidad', verifyTokenMiddleware, agendaController.getDisponibilidad);
router.post('/tutores/:id_tutor/bloquear', verifyTokenMiddleware, agendaController.postBloqueo);
router.delete('/bloqueos/:idBloqueo', verifyTokenMiddleware, agendaController.deleteBloqueo);

module.exports = router;

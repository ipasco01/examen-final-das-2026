// ms-usuarios/src/api/controllers/usuarios.controller.js
const usuariosService = require('../../domain/services/usuarios.service');
const { track } = require('../../infrastructure/messaging/message.producer');

const obtenerEstudiante = async (req, res, next) => {
    const cid = req.correlationId; // <-- Obtener Correlation ID
    try {
        track(cid, `Buscando estudiante con ID: ${req.params.id}`);
        const { id } = req.params;
        const estudiante = await usuariosService.getEstudiante(id);
        track(cid, `Estudiante ${id} encontrado.`);
        res.status(200).json(estudiante);
    } catch (error) {
        track(cid, `Error buscando estudiante: ${error.message}`, 'ERROR'); // <-- Track de error
        next(error);
    }
};

const obtenerTutor = async (req, res, next) => {
    const cid = req.correlationId; // <-- Obtener Correlation ID
    try {
        track(cid, `Buscando tutor con ID: ${req.params.id}`);
        const { id } = req.params;
        const tutor = await usuariosService.getTutor(id);
        track(cid, `Tutor ${id} encontrado.`);
        res.status(200).json(tutor);
    } catch (error) {
        track(cid, `Error buscando tutor: ${error.message}`, 'ERROR'); // <-- Track de error
        next(error);
    }
};

const listarTutores = async (req, res, next) => {
    const cid = req.correlationId;
    try {
        track(cid, 'Listando tutores disponibles');
        const tutores = await usuariosService.listarTutores();
        track(cid, `${tutores.length} tutores encontrados.`);
        res.status(200).json(tutores);
    } catch (error) {
        track(cid, `Error listando tutores: ${error.message}`, 'ERROR');
        next(error);
    }
};

const listarMaterias = async (req, res, next) => {
    const cid = req.correlationId;
    try {
        track(cid, 'Listando catálogo de materias');
        const materias = await usuariosService.listarMaterias();
        track(cid, `${materias.length} materias encontradas.`);
        res.status(200).json(materias);
    } catch (error) {
        track(cid, `Error listando materias: ${error.message}`, 'ERROR');
        next(error);
    }
};

module.exports = {
    obtenerEstudiante,
    obtenerTutor,
    listarTutores,
    listarMaterias
};
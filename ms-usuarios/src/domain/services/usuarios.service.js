// src/domain/services/usuarios.service.js

const usuariosRepository = require('../../infrastructure/repositories/usuarios.repository');

const getEstudiante = async (id) => {
    const estudiante = await usuariosRepository.findEstudianteById(id);
    if (!estudiante) {
        // Lanzamos un error que será capturado por el controlador/middleware
        const error = new Error('Estudiante no encontrado');
        error.statusCode = 404;
        throw error;
    }
    return estudiante;
};

const getTutor = async (id) => {
    const tutor = await usuariosRepository.findTutorById(id);
    if (!tutor) {
        const error = new Error('Tutor no encontrado');
        error.statusCode = 404;
        throw error;
    }
    return tutor;
};

// A diferencia de getTutor, una lista vacia NO es un error: significa que todavia no hay tutores
// cargados, que es un estado legitimo del sistema. Devolver 404 aca obligaria al cliente a tratar
// "no hay nada" como una falla. Se devuelve [] y el llamador decide que mostrar.
const listarTutores = async () => usuariosRepository.findAllTutores();

module.exports = {
    getEstudiante,
    getTutor,
    listarTutores
};
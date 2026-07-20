// ms-agenda/src/api/controllers/agenda.controller.js
const agendaService = require('../../domain/services/agenda.service');
const { track } = require('../../infrastructure/messaging/message.producer'); // <-- IMPORTAR TRACK

const getDisponibilidad = async (req, res, next) => {
    const cid = req.correlationId; // <-- Obtener Correlation ID
    try {
        track(cid, `Verificando disponibilidad para tutor: ${req.params.id_tutor}`);
        const { id_tutor } = req.params;
        const { fechaHora } = req.query;

        if (!fechaHora) {
            throw Object.assign(new Error('El parámetro "fechaHora" es requerido.'), { statusCode: 400 });
        }

        const resultado = await agendaService.verificarDisponibilidad(id_tutor, fechaHora);
        track(cid, `Disponibilidad para tutor ${id_tutor}: ${resultado.disponible}`);
        res.status(200).json(resultado);
    } catch (error) {
        track(cid, `Error en getDisponibilidad: ${error.message}`, 'ERROR');
        next(error);
    }
};

const postBloqueo = async (req, res, next) => {
    const cid = req.correlationId; // <-- Obtener Correlation ID
    try {
        track(cid, `Intentando bloquear agenda para tutor: ${req.params.id_tutor}`);
        const { id_tutor } = req.params;
        const datosBloqueo = req.body;

        const nuevoBloqueo = await agendaService.crearBloqueo(id_tutor, datosBloqueo);

        track(cid, `Agenda bloqueada exitosamente. Bloqueo ID: ${nuevoBloqueo.idBloqueo || nuevoBloqueo.idbloqueo}`);
        res.status(201).json(nuevoBloqueo);

    } catch (error) {
        // Log para depurar qué código de error está lanzando Postgres
        console.log(`[AgendaController] Error capturado al crear bloqueo. Code: ${error.code}, Message: ${error.message}`);

        // Código 23505 de Postgres = unique_violation
        if (error.code === '23505') { // Postgres Unique Violation
            const msg = 'Conflicto: El horario ya está reservado (Doble Reserva evitada por BD).';

            // Reportamos el evento al dashboard
            track(cid, `ERROR CONTROLADO: ${msg}`, 'ERROR');

            const errorConflicto = new Error(msg);
            errorConflicto.statusCode = 409;
            return next(errorConflicto);
        }

        // Para otros errores no esperados
        track(cid, `ERROR CRÍTICO en Agenda: ${error.message}`, 'ERROR');
        next(error);
    }
};

const deleteBloqueo = async (req, res, next) => {
    const cid = req.correlationId; // <-- Obtener Correlation ID
    const { idBloqueo } = req.params;

    try {
        track(cid, `COMPENSACIÓN: Iniciando eliminación de bloqueo. idBloqueo: ${idBloqueo}`, 'INFO');
        await agendaService.compensarBloqueo(idBloqueo);
        track(cid, `COMPENSACIÓN: Bloqueo eliminado exitosamente. idBloqueo: ${idBloqueo}`, 'INFO');
        res.status(200).json({ message: 'Bloqueo compensado (eliminado)' });
    } catch (error) {
        track(cid, `COMPENSACIÓN FALLIDA: No se pudo eliminar bloqueo. idBloqueo: ${idBloqueo}. Error: ${error.message}`, 'ERROR');
        next(error);
    }
};

module.exports = {
    getDisponibilidad,
    postBloqueo,
    deleteBloqueo
};

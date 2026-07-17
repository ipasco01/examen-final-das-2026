// ms-tutorias/src/domain/services/tutoria.service.js
const tutoriaRepository = require('../../infrastructure/repositories/tutoria.repository');
const usuariosClient = require('../../infrastructure/clients/usuarios.client');
const agendaClient = require('../../infrastructure/clients/agenda.client');
const { publishTrackingEvent } = require('../../infrastructure/messaging/message.producer');
const { compensacionFallidaTotal } = require('../../infrastructure/observability/compensacion.metrics');

// Función helper para publicar tracking
const track = (cid, message, status = 'INFO', idempotencyKey) => {
    publishTrackingEvent({
        service: 'MS_Tutorias',
        message,
        cid,
        timestamp: new Date(),
        status,
        idempotencyKey: idempotencyKey || null
    });
};

const isDemoFaultInjectionEnabled = () => process.env.ENABLE_DEMO_FAULT_INJECTION === 'true';

const shouldFailAfterBloqueo = (options = {}) => {
    return isDemoFaultInjectionEnabled() && options.demoFailAfterBloqueo === true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COMPENSACION_MAX_INTENTOS = Number(process.env.COMPENSACION_AGENDA_MAX_INTENTOS || 3);
const COMPENSACION_BASE_DELAY_MS = Number(process.env.COMPENSACION_AGENDA_BASE_DELAY_MS || 200);

const solicitarTutoria = async (datosSolicitud, correlationId, options = {}) => {
    const { idEstudiante, idTutor, fechaSolicitada, duracionMinutos, materia, idempotencyKey } = datosSolicitud;

    // Envuelve track() para no repetir correlationId/idempotencyKey en cada llamada de este flujo;
    // el dashboard necesita la idempotencyKey en cada evento para poder filtrar la traza de una solicitud.
    const trackCid = (message, status = 'INFO') => track(correlationId, message, status, idempotencyKey);

    if (idempotencyKey) {
        const solicitudExistente = await tutoriaRepository.findByIdempotencyKey(idempotencyKey);
        if (solicitudExistente) {
            trackCid(`Solicitud idempotente detectada (key: ${idempotencyKey}). Retornando tutoría existente sin reejecutar la Saga.`);
            return solicitudExistente;
        }
    }

    let nuevaTutoria;
    let bloqueoRealizado = null;

    try {
        // --- 1. Validar usuarios ---
        trackCid('Validando usuarios...');
        const [estudiante, tutor] = await Promise.all([
            usuariosClient.getUsuario('estudiantes', idEstudiante, correlationId),
            usuariosClient.getUsuario('tutores', idTutor, correlationId)
        ]);
        if (!estudiante) throw Object.assign(new Error('Estudiante no encontrado'), { statusCode: 404 });
        if (!tutor) throw Object.assign(new Error('Tutor no encontrado'), { statusCode: 404 });
        trackCid('Usuarios validados exitosamente.');

        // --- 2. Verificar agenda ---
        trackCid('Verificando disponibilidad de agenda...');
        const disponible = await agendaClient.verificarDisponibilidad(idTutor, fechaSolicitada, correlationId);
        if (!disponible) throw Object.assign(new Error('Horario no disponible'), { statusCode: 409 });
        trackCid('Agenda verificada (disponible).');

        // --- 3. Crear PENDIENTE ---
        trackCid('Creando tutoría en estado PENDIENTE...');
        const tutoriaPendienteData = { idEstudiante, idTutor, fecha: new Date(fechaSolicitada), materia, estado: 'PENDIENTE', idempotencyKey };
        nuevaTutoria = await tutoriaRepository.save(tutoriaPendienteData);

        // Carrera de idempotencia: otra solicitud concurrente con la misma key ya insertó/avanzó su propia fila
        // y el repositorio nos devolvió esa fila en vez de crear una nueva. Cortamos aquí para no re-bloquear
        // agenda ni duplicar la notificación.
        if (idempotencyKey && nuevaTutoria.estado !== 'PENDIENTE') {
            trackCid(`Carrera de idempotencia detectada (key: ${idempotencyKey}). Retornando resultado existente.`);
            return nuevaTutoria;
        }
        trackCid(`Tutoría PENDIENTE guardada (ID: ${nuevaTutoria.idtutoria}).`);

        // --- 4. Comandos de la Saga ---
        trackCid('Bloqueando horario en agenda...');
        const payloadAgenda = { fechaInicio: fechaSolicitada, duracionMinutos, idEstudiante };
        bloqueoRealizado = await agendaClient.bloquearAgenda(idTutor, payloadAgenda, correlationId);
        const idBloqueo = bloqueoRealizado.idBloqueo || bloqueoRealizado.idbloqueo;
        trackCid(`Bloqueo de agenda exitoso. ID: ${idBloqueo}`);

        if (shouldFailAfterBloqueo(options)) {
            trackCid('Fault injection demo activado después del bloqueo de agenda.', 'ERROR');
            throw Object.assign(new Error('Falla demo controlada después del bloqueo de agenda'), {
                statusCode: 500,
                code: 'DEMO_FAULT_AFTER_BLOQUEO'
            });
        }

        const payloadNotificacion = {
            destinatario: estudiante.email,
            asunto: `Tutoría de ${materia} confirmada`,
            cuerpo: `Hola ${estudiante.nombrecompleto || estudiante.nombreCompleto}, tu tutoría con ${tutor.nombrecompleto || tutor.nombreCompleto} ha sido confirmada...`,
            correlationId: correlationId
        };

        // --- 5. Confirmar (patrón outbox) ---
        // El cambio de estado a CONFIRMADA y el encolado de la notificación se confirman en la
        // misma transacción (ver tutoria.repository.js#save + outbox.repository.js): si el proceso
        // cae entre medio, o si antes esto dependía de que el canal RabbitMQ estuviera disponible
        // en ese instante exacto, ya no se pierde la notificación en silencio. El poller
        // (outbox.publisher.js) es quien efectivamente llama a publishToQueue.
        trackCid('Confirmando tutoría y encolando notificación (outbox)...');
        const tutoriaConfirmadaPayload = { idTutoria: nuevaTutoria.idtutoria, estado: 'CONFIRMADA', error: null };
        const tutoriaConfirmada = await tutoriaRepository.save(tutoriaConfirmadaPayload, { outboxNotificacion: payloadNotificacion });
        trackCid('Actualización a CONFIRMADA exitosa; notificación en outbox pendiente de publicación.');
        return tutoriaConfirmada;

    } catch (error) {
        const status = error.response?.status || error.statusCode || 500;

        // Intentamos obtener el mensaje más específico posible (para logs/tracking internos).
        const msg = error.response?.data?.error?.message || error.message;

        // E4: solo reenviamos ese mensaje al cliente si viene de un error HTTP real (axios
        // error.response) o de un throw deliberado nuestro con statusCode explícito -- ambos casos
        // ya traen un mensaje pensado para mostrarse. Un error inesperado (timeout de red crudo,
        // ECONNREFUSED, una excepción de Postgres que burbujeó) no tiene statusCode ni response, y
        // su .message es un detalle interno que no debería llegar tal cual a quien llamó a la API.
        const tieneMensajeParaCliente = Boolean(error.response) || error.statusCode !== undefined;
        const msgParaCliente = tieneMensajeParaCliente ? msg : 'Ocurrió un error inesperado al procesar la solicitud.';

        console.error(`[MS_Tutorias Service] - CID: ${correlationId} - Finalizando con error. Status: ${status}. Mensaje: ${msg}`);

        trackCid(`Proceso fallido. Causa: ${msg}`, 'ERROR');
        // --- Compensación ---
        console.error(`[MS_Tutorias Service] - CID: ${correlationId} - ERROR CAPTURADO: ${error.message}`);
        trackCid(`ERROR: ${error.message}`, 'ERROR'); // <-- Publicar evento de error

        const idBloqueo = bloqueoRealizado?.idBloqueo || bloqueoRealizado?.idbloqueo;
        // Payload a persistir en compensaciones_pendientes si el loop síncrono de abajo se agota.
        // bloqueoRealizado (y por lo tanto idBloqueo) solo puede existir si nuevaTutoria ya fue
        // creada -- el bloqueo de agenda es el paso 4 de la Saga, siempre después de crear la
        // tutoría PENDIENTE en el paso 3 -- así que no hace falta un camino para "hay
        // compensacionPendientePayload pero no hay nuevaTutoria".
        let compensacionPendientePayload = null;

        if (idBloqueo) {
            trackCid('COMPENSACIÓN: Desbloqueando agenda...', 'ERROR');

            let compensacionExitosa = false;
            let ultimoErrorCompensacion;

            for (let intento = 1; intento <= COMPENSACION_MAX_INTENTOS && !compensacionExitosa; intento++) {
                try {
                    await agendaClient.cancelarBloqueo(idBloqueo, correlationId);
                    compensacionExitosa = true;
                    trackCid(`Compensación (Agenda) exitosa en intento ${intento}.`, 'ERROR');
                } catch (compError) {
                    ultimoErrorCompensacion = compError;
                    trackCid(`Intento ${intento}/${COMPENSACION_MAX_INTENTOS} de compensación de agenda falló: ${compError.message}`, 'ERROR');
                    if (intento < COMPENSACION_MAX_INTENTOS) {
                        await sleep(COMPENSACION_BASE_DELAY_MS * intento);
                    }
                }
            }

            if (!compensacionExitosa) {
                trackCid(`FALLÓ compensación de agenda tras ${COMPENSACION_MAX_INTENTOS} intentos: ${ultimoErrorCompensacion.message}`, 'ERROR');
                compensacionFallidaTotal.inc({ etapa: 'sincrona' });
                compensacionPendientePayload = {
                    idBloqueo,
                    idTutor,
                    correlationId,
                    motivo: ultimoErrorCompensacion.message
                };
                trackCid('Compensación pendiente registrada para reintento en segundo plano.', 'ERROR');
            }
        }

        if (nuevaTutoria && nuevaTutoria.idtutoria) {
            trackCid('Iniciando compensación: Marcando tutoría como FALLIDA.', 'ERROR');
            const compensacionPayload = { idTutoria: nuevaTutoria.idtutoria, estado: 'FALLIDA', error: error.message };
            try {
                // Patrón outbox aplicado a la compensación (D6): si hubo que registrar una
                // compensación pendiente, se inserta en la misma transacción que el UPDATE a
                // FALLIDA -- si el UPDATE no afecta ninguna fila, tampoco queda el registro de
                // compensación pendiente huérfano.
                const saveOptions = compensacionPendientePayload ? { compensacionPendiente: compensacionPendientePayload } : {};
                await tutoriaRepository.save(compensacionPayload, saveOptions);
                trackCid('Compensación (FALLIDA) guardada exitosamente.', 'ERROR');
            } catch (compensacionError) {
                trackCid(`¡¡ERROR CRÍTICO EN COMPENSACIÓN!!: ${compensacionError.message}`, 'ERROR');
            }
        }
        // Relanzar el error manteniendo el contrato público existente.
        throw Object.assign(new Error(`No se pudo completar la solicitud: ${msgParaCliente}`), { statusCode: status });
    }
};

module.exports = { solicitarTutoria };

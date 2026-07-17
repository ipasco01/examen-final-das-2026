// R4: dos Sagas realmente concurrentes (Promise.all, no una sola solicitud con retry) pidiendo el
// mismo tutor/horario. El stub de agendaClient.bloquearAgenda modela lo que hace la constraint
// UNIQUE(idTutor, fechaInicio) de ms-agenda en la práctica: la primera invocación que llega gana,
// la segunda recibe el 409 real que devolvería Postgres/ms-agenda por la reserva duplicada.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const modulePath = (relativePath) => path.join(ROOT, relativePath);

const servicePath = modulePath('src/domain/services/tutoria.service.js');
const repositoryPath = modulePath('src/infrastructure/repositories/tutoria.repository.js');
const usuariosClientPath = modulePath('src/infrastructure/clients/usuarios.client.js');
const agendaClientPath = modulePath('src/infrastructure/clients/agenda.client.js');
const messageProducerPath = modulePath('src/infrastructure/messaging/message.producer.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

test('dos Sagas concurrentes para el mismo tutor/horario: una gana, la otra queda FALLIDA sin bloqueo huérfano', async () => {
    const calls = { saves: [], cancellations: [], bloqueos: [] };
    let siguienteIdTutoria = 1;

    const repository = {
        findByIdempotencyKey: async () => null,
        save: async (payload) => {
            calls.saves.push(payload);
            if (payload.idTutoria) {
                return { idtutoria: payload.idTutoria, ...payload };
            }
            const idtutoria = `tutoria-${siguienteIdTutoria++}`;
            return { idtutoria, ...payload };
        }
    };

    const usuariosClient = {
        getUsuario: async (tipo) => (
            tipo === 'estudiantes'
                ? { email: 'estudiante@test.local', nombrecompleto: 'Estudiante Test' }
                : { email: 'tutor@test.local', nombrecompleto: 'Tutor Test' }
        )
    };

    // Simula la constraint UNIQUE(idTutor, fechaInicio) de ms-agenda: solo la primera invocación
    // que efectivamente llega gana el bloqueo; cualquier otra para el mismo slot recibe el 409 de
    // negocio real (mismo shape que devuelve agenda.client.js: error.response.status/data).
    let bloqueoCallCount = 0;
    const agendaClient = {
        verificarDisponibilidad: async () => true,
        bloquearAgenda: async (idTutor, payload, correlationId) => {
            bloqueoCallCount += 1;
            calls.bloqueos.push({ idTutor, payload, correlationId });
            if (bloqueoCallCount === 1) {
                return { idBloqueo: 'bloqueo-ganador' };
            }
            const conflictError = new Error('Conflicto: El horario ya está reservado (Doble Reserva evitada por BD).');
            conflictError.response = { status: 409, data: { error: { message: conflictError.message } } };
            throw conflictError;
        },
        cancelarBloqueo: async (idBloqueo, correlationId) => {
            calls.cancellations.push({ idBloqueo, correlationId });
        }
    };

    const messageProducer = {
        publishToQueue: async () => true,
        publishTrackingEvent: async () => undefined
    };

    for (const filePath of [servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }

    require.cache[require.resolve(repositoryPath)] = { exports: repository };
    require.cache[require.resolve(usuariosClientPath)] = { exports: usuariosClient };
    require.cache[require.resolve(agendaClientPath)] = { exports: agendaClient };
    require.cache[require.resolve(messageProducerPath)] = { exports: messageProducer };

    const tutoriaService = require(servicePath);

    const datosBase = {
        idEstudiante: 'estudiante-x',
        idTutor: 'tutor-concurrente',
        fechaSolicitada: '2026-08-01T10:00:00.000Z',
        duracionMinutos: 60,
        materia: 'Física'
    };

    try {
        const [resultadoA, resultadoB] = await Promise.allSettled([
            tutoriaService.solicitarTutoria({ ...datosBase, idempotencyKey: 'req-concurrente-a' }, 'cid-a'),
            tutoriaService.solicitarTutoria({ ...datosBase, idempotencyKey: 'req-concurrente-b' }, 'cid-b')
        ]);

        const resultados = [resultadoA, resultadoB];
        const ganadora = resultados.find((r) => r.status === 'fulfilled');
        const perdedora = resultados.find((r) => r.status === 'rejected');

        assert.ok(ganadora, 'una de las dos solicitudes concurrentes debe tener éxito');
        assert.ok(perdedora, 'la otra debe fallar por conflicto de agenda');

        assert.equal(ganadora.value.estado, 'CONFIRMADA');
        assert.equal(perdedora.reason.statusCode, 409);
        assert.match(perdedora.reason.message, /Doble Reserva evitada por BD/);

        // La Saga perdedora nunca obtuvo idBloqueo (bloquearAgenda le rechazó antes de devolver
        // uno), así que no debe haber intentado compensar nada -- no queda bloqueo huérfano.
        assert.deepEqual(calls.cancellations, []);
        assert.equal(calls.bloqueos.length, 2);

        // Ambas Sagas quedaron persistidas en un estado terminal -- ninguna se quedó en PENDIENTE.
        const estadosFinales = calls.saves
            .filter((s) => s.idTutoria)
            .map((s) => s.estado)
            .sort();
        assert.deepEqual(estadosFinales, ['CONFIRMADA', 'FALLIDA']);
    } finally {
        clearModule(servicePath);
    }
});

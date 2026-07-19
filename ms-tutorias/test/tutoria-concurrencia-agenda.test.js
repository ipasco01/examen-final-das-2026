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

// S12: la colisión concurrente (arriba) cubre dos requests corriendo a la vez para el mismo slot.
// Esta cubre el caso secuencial -- la solicitud B llega después de que A ya confirmó y liberó el
// slot como ocupado -- que pasa por un camino de rechazo distinto: verificarDisponibilidad (no
// bloquearAgenda) es quien la corta, así que nunca llega a intentar un bloqueo ni, por lo tanto, a
// necesitar compensación.
test('dos solicitudes secuenciales con distinta Idempotency-Key para el mismo tutor/horario: la segunda es rechazada por disponibilidad', async () => {
    const calls = { saves: [], cancellations: [] };
    let siguienteIdTutoria = 1;
    let slotOcupado = false;

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

    const agendaClient = {
        verificarDisponibilidad: async () => !slotOcupado,
        bloquearAgenda: async () => {
            slotOcupado = true;
            return { idBloqueo: 'bloqueo-secuencial' };
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
        idEstudiante: 'estudiante-y',
        idTutor: 'tutor-secuencial',
        fechaSolicitada: '2030-09-01T10:00:00.000Z',
        duracionMinutos: 60,
        materia: 'Química'
    };

    try {
        const primera = await tutoriaService.solicitarTutoria({ ...datosBase, idempotencyKey: 'req-secuencial-a' }, 'cid-a');
        assert.equal(primera.estado, 'CONFIRMADA');

        await assert.rejects(
            () => tutoriaService.solicitarTutoria({ ...datosBase, idempotencyKey: 'req-secuencial-b' }, 'cid-b'),
            (error) => {
                assert.equal(error.statusCode, 409);
                assert.match(error.message, /Horario no disponible/);
                return true;
            }
        );

        // La segunda solicitud nunca llegó a intentar un bloqueo (la cortó verificarDisponibilidad,
        // no bloquearAgenda), así que no hay nada que compensar.
        assert.deepEqual(calls.cancellations, []);
        const estadosFinales = calls.saves.filter((s) => s.idTutoria).map((s) => s.estado);
        assert.deepEqual(estadosFinales, ['CONFIRMADA']);
    } finally {
        clearModule(servicePath);
    }
});

// S12: la validación de estudiante y tutor corre en Promise.all -- ningún test cubría que uno de
// los dos falle mientras el otro resuelve. Como esto pasa en el paso 1, antes de crear la fila
// PENDIENTE (paso 3), el rechazo debe ser limpio: sin guardar nada y sin intentar compensación.
test('si uno de los dos usuarios falla en Promise.all, la Saga rechaza sin persistir nada ni compensar', async () => {
    const calls = { saves: [], cancellations: [], agenda: [] };

    const repository = {
        findByIdempotencyKey: async () => null,
        save: async (payload) => {
            calls.saves.push(payload);
            return { idtutoria: 'no-debería-crearse', ...payload };
        }
    };

    const usuariosClient = {
        getUsuario: async (tipo) => {
            if (tipo === 'estudiantes') {
                return { email: 'estudiante@test.local', nombrecompleto: 'Estudiante Test' };
            }
            // El tutor no existe / ms-usuarios lo rechaza -- sin statusCode ni response, para
            // ejercitar el camino de error "inesperado" (no un 404 deliberado).
            throw new Error('Fallo de red simulado al validar tutor');
        }
    };

    const agendaClient = {
        verificarDisponibilidad: async () => { calls.agenda.push('verificarDisponibilidad'); return true; },
        bloquearAgenda: async () => { calls.agenda.push('bloquearAgenda'); return { idBloqueo: 'no-debería-llamarse' }; },
        cancelarBloqueo: async (idBloqueo, correlationId) => { calls.cancellations.push({ idBloqueo, correlationId }); }
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

    try {
        await assert.rejects(
            () => tutoriaService.solicitarTutoria(
                {
                    idEstudiante: 'estudiante-z',
                    idTutor: 'tutor-inexistente',
                    fechaSolicitada: '2030-09-01T10:00:00.000Z',
                    duracionMinutos: 60,
                    materia: 'Historia',
                    idempotencyKey: 'req-fallo-parcial'
                },
                'cid-fallo-parcial'
            ),
            (error) => {
                // Sin statusCode/response deliberado -> cae al camino "inesperado" (E4): status
                // 500 y mensaje genérico, no el mensaje crudo de axios/red.
                assert.equal(error.statusCode, 500);
                assert.match(error.message, /inesperado/);
                return true;
            }
        );

        // Nada se persistió (el fallo ocurrió antes del paso 3) y no hubo ningún intento de tocar
        // agenda ni de compensar -- el resultado exitoso de getUsuario('estudiantes', ...) dentro
        // del Promise.all se descarta sin causar ningún efecto secundario adicional.
        assert.deepEqual(calls.saves, []);
        assert.deepEqual(calls.agenda, []);
        assert.deepEqual(calls.cancellations, []);
    } finally {
        clearModule(servicePath);
    }
});

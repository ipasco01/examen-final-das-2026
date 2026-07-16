const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const modulePath = (relativePath) => path.join(ROOT, relativePath);

const servicePath = modulePath('src/domain/services/tutoria.service.js');
const controllerPath = modulePath('src/api/controllers/tutorias.controller.js');
const repositoryPath = modulePath('src/infrastructure/repositories/tutoria.repository.js');
const usuariosClientPath = modulePath('src/infrastructure/clients/usuarios.client.js');
const agendaClientPath = modulePath('src/infrastructure/clients/agenda.client.js');
const messageProducerPath = modulePath('src/infrastructure/messaging/message.producer.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

const createRequest = ({ idempotencyKey, headerValue }) => ({
    user: { role: 'student', sub: 'student-from-token' },
    body: {
        idEstudiante: 'student-from-body',
        idTutor: 'tutor-1',
        fechaSolicitada: '2026-06-24T10:00:00.000Z',
        duracionMinutos: 60,
        materia: 'Arquitectura de Software'
    },
    correlationId: 'cid-test',
    header: (name) => {
        if (name === 'Idempotency-Key') return idempotencyKey;
        if (name === 'X-Demo-Fail-After-Bloqueo') return headerValue;
        return undefined;
    }
});

const createResponse = () => {
    const response = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };

    return response;
};

const loadControllerWithStubs = ({ cancelarBloqueoFailures = 0, seedTutorias = [] } = {}) => {
    const calls = {
        saves: [],
        users: [],
        agenda: [],
        cancellations: [],
        notifications: [],
        outbox: [],
        compensacionPendiente: [],
        tracking: [],
        order: []
    };

    let cancelarBloqueoRemainingFailures = cancelarBloqueoFailures;

    const tutoriasPorId = new Map();
    const tutoriasPorIdempotencyKey = new Map();
    let nextId = 1;

    for (const seed of seedTutorias) {
        tutoriasPorId.set(seed.idtutoria, seed);
        if (seed.idempotencyKey) tutoriasPorIdempotencyKey.set(seed.idempotencyKey, seed);
    }

    const repository = {
        findByIdempotencyKey: async (idempotencyKey) => {
            calls.order.push('idempotency:lookup');
            return tutoriasPorIdempotencyKey.get(idempotencyKey) || null;
        },
        save: async (payload, options = {}) => {
            calls.saves.push(payload);

            if (payload.idTutoria) {
                const actualizada = { ...tutoriasPorId.get(payload.idTutoria), ...payload, idtutoria: payload.idTutoria };
                tutoriasPorId.set(payload.idTutoria, actualizada);
                if (actualizada.idempotencyKey) tutoriasPorIdempotencyKey.set(actualizada.idempotencyKey, actualizada);
                if (options.outboxNotificacion) {
                    calls.outbox.push({ idTutoria: payload.idTutoria, payload: options.outboxNotificacion });
                    calls.order.push(`save:${payload.estado}+outbox`);
                } else if (options.compensacionPendiente) {
                    calls.compensacionPendiente.push({ idTutoria: payload.idTutoria, payload: options.compensacionPendiente });
                    calls.order.push(`save:${payload.estado}+compensacionPendiente`);
                } else {
                    calls.order.push(`save:${payload.estado}`);
                }
                return actualizada;
            }

            // Simula la restricción UNIQUE(idempotencyKey): si ya existe una fila con esa key
            // (carrera concurrente), devolvemos la existente en vez de crear una nueva.
            if (payload.idempotencyKey && tutoriasPorIdempotencyKey.has(payload.idempotencyKey)) {
                calls.order.push('save:idempotency-conflict');
                return tutoriasPorIdempotencyKey.get(payload.idempotencyKey);
            }

            const idtutoria = `tutoria-${nextId++}`;
            const creada = { idtutoria, ...payload };
            tutoriasPorId.set(idtutoria, creada);
            if (creada.idempotencyKey) tutoriasPorIdempotencyKey.set(creada.idempotencyKey, creada);
            calls.order.push('save:PENDIENTE');
            return creada;
        }
    };

    const usuariosClient = {
        getUsuario: async (tipo, id, correlationId) => {
            calls.users.push({ tipo, id, correlationId });
            calls.order.push(`users:${tipo}`);

            return tipo === 'estudiantes'
                ? { email: 'student@example.test', nombrecompleto: 'Student Test' }
                : { email: 'tutor@example.test', nombrecompleto: 'Tutor Test' };
        }
    };

    const agendaClient = {
        verificarDisponibilidad: async (idTutor, fechaHora, correlationId) => {
            calls.agenda.push({ operation: 'verificarDisponibilidad', idTutor, fechaHora, correlationId });
            calls.order.push('agenda:verificar');
            return true;
        },
        bloquearAgenda: async (idTutor, payload, correlationId) => {
            calls.agenda.push({ operation: 'bloquearAgenda', idTutor, payload, correlationId });
            calls.order.push('agenda:bloquear');
            return { idBloqueo: 'bloqueo-1' };
        },
        cancelarBloqueo: async (idBloqueo, correlationId) => {
            calls.cancellations.push({ idBloqueo, correlationId });
            calls.order.push('agenda:cancelar');
            if (cancelarBloqueoRemainingFailures > 0) {
                cancelarBloqueoRemainingFailures -= 1;
                throw new Error('Fallo simulado de red al cancelar bloqueo');
            }
        }
    };

    const messageProducer = {
        publishToQueue: async (queueName, payload) => {
            calls.notifications.push({ queueName, payload });
            calls.order.push(`queue:${queueName}`);
        },
        publishTrackingEvent: (payload) => {
            calls.tracking.push(payload);
        }
    };

    for (const filePath of [controllerPath, servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }

    require.cache[require.resolve(repositoryPath)] = { exports: repository };
    require.cache[require.resolve(usuariosClientPath)] = { exports: usuariosClient };
    require.cache[require.resolve(agendaClientPath)] = { exports: agendaClient };
    require.cache[require.resolve(messageProducerPath)] = { exports: messageProducer };

    return {
        controller: require(controllerPath),
        calls
    };
};

const withCompensacionEnv = async (overrides, fn) => {
    const keys = ['COMPENSACION_AGENDA_MAX_INTENTOS', 'COMPENSACION_AGENDA_BASE_DELAY_MS', 'ENABLE_DEMO_FAULT_INJECTION'];
    const originals = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

    for (const [key, value] of Object.entries(overrides)) {
        process.env[key] = value;
    }

    try {
        return await fn();
    } finally {
        for (const key of keys) {
            if (originals[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = originals[key];
            }
        }
        clearModule(controllerPath);
        clearModule(servicePath);
    }
};

// --- D1: compensación resiliente ---

test('D1: compensa exitosamente en el primer intento y no registra compensación pendiente', async () => {
    await withCompensacionEnv({
        COMPENSACION_AGENDA_MAX_INTENTOS: '2',
        COMPENSACION_AGENDA_BASE_DELAY_MS: '1',
        ENABLE_DEMO_FAULT_INJECTION: 'true'
    }, async () => {
        const { controller, calls } = loadControllerWithStubs({ cancelarBloqueoFailures: 0 });
        const req = createRequest({ idempotencyKey: 'idem-d1-a', headerValue: 'true' });
        const res = createResponse();
        let nextError;

        await controller.postSolicitud(req, res, (error) => { nextError = error; });

        assert.equal(nextError.statusCode, 500);
        assert.equal(calls.cancellations.length, 1);
        assert.equal(calls.compensacionPendiente.length, 0);
        assert.deepEqual(calls.saves.map((s) => s.estado), ['PENDIENTE', 'FALLIDA']);
    });
});

test('D1: compensa exitosamente tras un reintento y no registra compensación pendiente', async () => {
    await withCompensacionEnv({
        COMPENSACION_AGENDA_MAX_INTENTOS: '2',
        COMPENSACION_AGENDA_BASE_DELAY_MS: '1',
        ENABLE_DEMO_FAULT_INJECTION: 'true'
    }, async () => {
        const { controller, calls } = loadControllerWithStubs({ cancelarBloqueoFailures: 1 });
        const req = createRequest({ idempotencyKey: 'idem-d1-b', headerValue: 'true' });
        const res = createResponse();
        let nextError;

        await controller.postSolicitud(req, res, (error) => { nextError = error; });

        assert.equal(nextError.statusCode, 500);
        assert.equal(calls.cancellations.length, 2);
        assert.equal(calls.compensacionPendiente.length, 0);
    });
});

test('D1: si todos los intentos de compensación fallan, registra en compensaciones_pendientes junto con el UPDATE a FALLIDA', async () => {
    await withCompensacionEnv({
        COMPENSACION_AGENDA_MAX_INTENTOS: '2',
        COMPENSACION_AGENDA_BASE_DELAY_MS: '1',
        ENABLE_DEMO_FAULT_INJECTION: 'true'
    }, async () => {
        const { controller, calls } = loadControllerWithStubs({ cancelarBloqueoFailures: 99 });
        const req = createRequest({ idempotencyKey: 'idem-d1-c', headerValue: 'true' });
        const res = createResponse();
        let nextError;

        await controller.postSolicitud(req, res, (error) => { nextError = error; });

        assert.equal(nextError.statusCode, 500);
        assert.equal(calls.cancellations.length, 2);

        assert.equal(calls.compensacionPendiente.length, 1);
        const pendiente = calls.compensacionPendiente[0];
        assert.equal(pendiente.payload.idBloqueo, 'bloqueo-1');
        assert.equal(pendiente.payload.correlationId, 'cid-test');
        assert.match(pendiente.payload.motivo, /Fallo simulado/);

        // Se registra en la misma llamada a save() que transiciona a FALLIDA (misma transacción).
        assert.deepEqual(calls.saves.map((s) => s.estado), ['PENDIENTE', 'FALLIDA']);
        assert.equal(pendiente.idTutoria, calls.saves[1].idTutoria);
    });
});

// --- D5: Idempotency-Key ---

test('D5: falta el header Idempotency-Key -> 400 sin invocar al servicio', async () => {
    const { controller, calls } = loadControllerWithStubs();
    const req = createRequest({ idempotencyKey: undefined });
    const res = createResponse();
    let nextError;

    await controller.postSolicitud(req, res, (error) => { nextError = error; });

    assert.equal(nextError.statusCode, 400);
    assert.match(nextError.message, /Idempotency-Key/);
    assert.equal(calls.order.length, 0);
});

test('D5: primera solicitud con una key nueva ejecuta la Saga completa y persiste la key', async () => {
    const { controller, calls } = loadControllerWithStubs();
    const req = createRequest({ idempotencyKey: 'idem-d5-nueva' });
    const res = createResponse();
    let nextError;

    await controller.postSolicitud(req, res, (error) => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.estado, 'CONFIRMADA');
    assert.equal(calls.saves[0].idempotencyKey, 'idem-d5-nueva');
    assert.equal(calls.outbox.length, 1);
    assert.equal(calls.outbox[0].idTutoria, res.body.idtutoria);
});

test('D5: reintentar con una key ya CONFIRMADA corta antes de tocar usuarios, agenda o notificación', async () => {
    const tutoriaExistente = {
        idtutoria: 'tutoria-previa',
        idEstudiante: 'student-from-token',
        idTutor: 'tutor-1',
        estado: 'CONFIRMADA',
        idempotencyKey: 'idem-d5-repetida'
    };

    const { controller, calls } = loadControllerWithStubs({ seedTutorias: [tutoriaExistente] });
    const req = createRequest({ idempotencyKey: 'idem-d5-repetida' });
    const res = createResponse();
    let nextError;

    await controller.postSolicitud(req, res, (error) => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, tutoriaExistente);

    assert.deepEqual(calls.order, ['idempotency:lookup']);
    assert.equal(calls.users.length, 0);
    assert.equal(calls.agenda.length, 0);
    assert.equal(calls.notifications.length, 0);
});

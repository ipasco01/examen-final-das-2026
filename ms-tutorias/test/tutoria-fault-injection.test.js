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

const createRequest = ({ headerValue, idempotencyKey = 'idem-test-key' }) => ({
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
        if (name === 'X-Demo-Fail-After-Bloqueo') return headerValue;
        if (name === 'Idempotency-Key') return idempotencyKey;
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

const loadControllerWithStubs = () => {
    const calls = {
        saves: [],
        users: [],
        agenda: [],
        cancellations: [],
        notifications: [],
        outbox: [],
        tracking: [],
        order: []
    };

    const repository = {
        findByIdempotencyKey: async () => null,
        save: async (payload, options = {}) => {
            calls.saves.push(payload);

            if (payload.idTutoria) {
                if (options.outboxNotificacion) {
                    calls.outbox.push({ idTutoria: payload.idTutoria, payload: options.outboxNotificacion });
                    calls.order.push(`save:${payload.estado}+outbox`);
                } else {
                    calls.order.push(`save:${payload.estado}`);
                }
                return { idtutoria: payload.idTutoria, ...payload };
            }

            calls.order.push('save:PENDIENTE');
            return { idtutoria: 'tutoria-1', ...payload };
        }
    };

    const usuariosClient = {
        getUsuario: async (tipo, id, correlationId) => {
            calls.users.push({ tipo, id, correlationId });

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
        }
    };

    const messageProducer = {
        publishToQueue: (queueName, payload) => {
            calls.notifications.push({ queueName, payload });
            calls.order.push('queue:notificacion');
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

const runPostSolicitud = async ({ envValue, headerValue }) => {
    const originalEnv = process.env.ENABLE_DEMO_FAULT_INJECTION;

    if (envValue === undefined) {
        delete process.env.ENABLE_DEMO_FAULT_INJECTION;
    } else {
        process.env.ENABLE_DEMO_FAULT_INJECTION = envValue;
    }

    const { controller, calls } = loadControllerWithStubs();
    const req = createRequest({ headerValue });
    const res = createResponse();
    let nextError;

    try {
        await controller.postSolicitud(req, res, (error) => {
            nextError = error;
        });

        return { calls, req, res, nextError };
    } finally {
        if (originalEnv === undefined) {
            delete process.env.ENABLE_DEMO_FAULT_INJECTION;
        } else {
            process.env.ENABLE_DEMO_FAULT_INJECTION = originalEnv;
        }

        clearModule(controllerPath);
        clearModule(servicePath);
    }
};

test('does not inject failure by default even when the demo header is present', async () => {
    const { calls, res, nextError } = await runPostSolicitud({
        envValue: undefined,
        headerValue: 'true'
    });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.estado, 'CONFIRMADA');
    assert.deepEqual(calls.cancellations, []);
    assert.equal(calls.outbox.length, 1);
    assert.deepEqual(calls.saves.map((save) => save.estado), ['PENDIENTE', 'CONFIRMADA']);
});

test('does not inject failure when env is enabled but the demo header is absent', async () => {
    const { calls, res, nextError } = await runPostSolicitud({
        envValue: 'true',
        headerValue: undefined
    });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.estado, 'CONFIRMADA');
    assert.deepEqual(calls.cancellations, []);
    assert.equal(calls.outbox.length, 1);
    assert.deepEqual(calls.saves.map((save) => save.estado), ['PENDIENTE', 'CONFIRMADA']);
});

test('injects failure after agenda blocking and compensates the bloqueo when both signals are present', async () => {
    const { calls, res, nextError } = await runPostSolicitud({
        envValue: 'true',
        headerValue: 'true'
    });

    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
    assert.equal(nextError.statusCode, 500);
    assert.match(nextError.message, /Falla demo controlada después del bloqueo de agenda/);

    assert.deepEqual(calls.cancellations, [{ idBloqueo: 'bloqueo-1', correlationId: 'cid-test' }]);
    assert.equal(calls.notifications.length, 0);
    assert.equal(calls.outbox.length, 0);
    assert.deepEqual(calls.saves.map((save) => save.estado), ['PENDIENTE', 'FALLIDA']);
    assert.ok(calls.order.indexOf('agenda:bloquear') < calls.order.indexOf('agenda:cancelar'));
    assert.equal(calls.order.includes('queue:notificacion'), false);
});

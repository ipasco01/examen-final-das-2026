const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const agendaClientPath = path.join(ROOT, 'src/infrastructure/clients/agenda.client.js');
const messageProducerPath = path.join(ROOT, 'src/infrastructure/messaging/message.producer.js');
const configPath = require.resolve(path.join(ROOT, 'src/config/index.js'));
const axiosPath = require.resolve('axios');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

// axios se comporta como una función callable (usada por _makeRequest vía axios(config)) que
// además expone métodos estáticos como axios.delete (usado por cancelarBloqueo).
const createFakeAxios = () => {
    const calls = { request: [], delete: [] };
    let requestImpl = async () => ({ data: {} });
    let deleteImpl = async () => ({ data: {} });

    const fakeAxios = (config) => {
        calls.request.push(config);
        return requestImpl(config);
    };
    fakeAxios.delete = (url, config) => {
        calls.delete.push({ url, config });
        return deleteImpl(url, config);
    };

    return {
        fakeAxios,
        calls,
        setRequestImpl: (fn) => { requestImpl = fn; },
        setDeleteImpl: (fn) => { deleteImpl = fn; }
    };
};

const networkError = (message = 'ECONNREFUSED') => {
    const error = new Error(message);
    error.code = message;
    return error;
};

const httpError = (status, message) => {
    const error = new Error(message);
    error.response = { status, data: { error: { message } } };
    return error;
};

const loadAgendaClientWithStubs = () => {
    const axiosStub = createFakeAxios();
    const trackingEvents = [];

    // Delay base mínimo para que los tests de reintentos (backoff + jitter) no queden lentos.
    process.env.RETRY_AGENDA_BASE_DELAY_MS = '1';

    require.cache[axiosPath] = {
        id: axiosPath,
        filename: axiosPath,
        loaded: true,
        exports: axiosStub.fakeAxios
    };

    require.cache[messageProducerPath] = {
        id: messageProducerPath,
        filename: messageProducerPath,
        loaded: true,
        exports: {
            publishTrackingEvent: async (payload) => { trackingEvents.push(payload); },
            publishToQueue: async () => true,
            connect: async () => undefined
        }
    };

    // S4: config/index.js ahora falla rápido si falta alguna variable requerida (JWT_SECRET
    // incluida) -- este test no depende de eso, así que se stubbea igual que los otros módulos en
    // vez de depender de que el .env local del desarrollador tenga las tres variables completas.
    require.cache[configPath] = {
        id: configPath,
        filename: configPath,
        loaded: true,
        exports: { agendaServiceUrl: 'http://localhost:3002/agenda' }
    };

    clearModule(agendaClientPath);

    return {
        agendaClient: require(agendaClientPath),
        axiosStub,
        trackingEvents
    };
};

const withFreshAgendaClient = async (fn) => {
    const ctx = loadAgendaClientWithStubs();
    try {
        await fn(ctx);
    } finally {
        clearModule(agendaClientPath);
        delete require.cache[axiosPath];
        delete require.cache[messageProducerPath];
        delete process.env.RETRY_AGENDA_BASE_DELAY_MS;
    }
};

test('un 409 de bloquearAgenda no abre el breaker pero sigue lanzando el error original', async () => {
    await withFreshAgendaClient(async ({ agendaClient, axiosStub }) => {
        axiosStub.setRequestImpl(async () => {
            throw httpError(409, 'Conflicto: el horario ya está reservado');
        });

        await assert.rejects(
            () => agendaClient.bloquearAgenda('t1', {}, 'cid-1'),
            (error) => {
                assert.equal(error.response.status, 409);
                return true;
            }
        );

        // Repetir el 409 varias veces no debe abrir el circuito: cada intento debe seguir
        // llegando a axios (no fallar rápido con 503 sintético).
        for (let i = 0; i < 3; i += 1) {
            await assert.rejects(
                () => agendaClient.bloquearAgenda('t1', {}, 'cid-1'),
                (error) => error.response && error.response.status === 409
            );
        }

        assert.equal(axiosStub.calls.request.length, 4);
    });
});

test('fallos de red repetidos abren el breaker y las siguientes llamadas fallan rápido con 503', async () => {
    await withFreshAgendaClient(async ({ agendaClient, axiosStub, trackingEvents }) => {
        axiosStub.setRequestImpl(async () => { throw networkError(); });

        // volumeThreshold=2, errorThresholdPercentage=50: dos fallos consecutivos deben abrir el circuito.
        await assert.rejects(() => agendaClient.bloquearAgenda('t1', {}, 'cid-2'));
        await assert.rejects(() => agendaClient.bloquearAgenda('t1', {}, 'cid-2'));

        const llamadasAntesDeAbrir = axiosStub.calls.request.length;
        assert.equal(llamadasAntesDeAbrir, 2);

        await assert.rejects(
            () => agendaClient.bloquearAgenda('t1', {}, 'cid-2'),
            (error) => {
                assert.equal(error.statusCode, 503);
                return true;
            }
        );

        // El fast-fail no debe haber llegado a axios.
        assert.equal(axiosStub.calls.request.length, llamadasAntesDeAbrir);
        assert.ok(trackingEvents.some((e) => e.message === 'Circuit Breaker ABIERTO para ms-agenda'));
    });
});

test('fallos de cancelarBloqueo no afectan el estado del breaker compartido', async () => {
    await withFreshAgendaClient(async ({ agendaClient, axiosStub }) => {
        axiosStub.setDeleteImpl(async () => { throw networkError(); });
        axiosStub.setRequestImpl(async () => ({ data: { disponible: true } }));

        for (let i = 0; i < 5; i += 1) {
            await assert.rejects(() => agendaClient.cancelarBloqueo('bloqueo-1', 'cid-3'));
        }

        // El breaker compartido (verificar/bloquear) no debe haberse visto afectado: la llamada
        // de disponibilidad debe seguir llegando a axios con normalidad.
        const disponible = await agendaClient.verificarDisponibilidad('t1', '2026-01-01T00:00:00.000Z', 'cid-3');
        assert.equal(disponible, true);
        assert.equal(axiosStub.calls.request.length, 1);
        assert.equal(axiosStub.calls.delete.length, 5);
    });
});

test('verificarDisponibilidad reintenta (backoff + jitter) ante un fallo de red y luego tiene éxito', async () => {
    await withFreshAgendaClient(async ({ agendaClient, axiosStub }) => {
        let intentos = 0;
        axiosStub.setRequestImpl(async () => {
            intentos += 1;
            if (intentos === 1) throw networkError();
            return { data: { disponible: false } };
        });

        const disponible = await agendaClient.verificarDisponibilidad('t1', '2026-01-01T00:00:00.000Z', 'cid-4');

        assert.equal(disponible, false);
        assert.equal(intentos, 2);
    });
});

test('verificarDisponibilidad se rinde tras agotar los 3 intentos ante fallos de red persistentes', async () => {
    await withFreshAgendaClient(async ({ agendaClient, axiosStub }) => {
        axiosStub.setRequestImpl(async () => { throw networkError(); });

        await assert.rejects(
            () => agendaClient.verificarDisponibilidad('t1', '2026-01-01T00:00:00.000Z', 'cid-5'),
            (error) => !error.response // el 3er intento se agota como fallo de red crudo, no como 503 sintético de breaker abierto
        );

        // volumeThreshold=2 hace que el breaker se abra en el 2do intento -- el 3ro falla rápido
        // sin llegar a axios, así que solo deben verse 2 llamadas reales.
        assert.equal(axiosStub.calls.request.length, 2);
    });
});

test('bloquearAgenda reintenta (backoff + jitter) ante un fallo de red y luego tiene éxito', async () => {
    await withFreshAgendaClient(async ({ agendaClient, axiosStub }) => {
        let intentos = 0;
        axiosStub.setRequestImpl(async () => {
            intentos += 1;
            if (intentos === 1) throw networkError();
            return { data: { idBloqueo: 'b-1' } };
        });

        const resultado = await agendaClient.bloquearAgenda('t1', {}, 'cid-6');

        assert.equal(resultado.idBloqueo, 'b-1');
        assert.equal(intentos, 2);
    });
});

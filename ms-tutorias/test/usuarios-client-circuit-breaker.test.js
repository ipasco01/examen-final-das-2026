const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const usuariosClientPath = path.join(ROOT, 'src/infrastructure/clients/usuarios.client.js');
const messageProducerPath = path.join(ROOT, 'src/infrastructure/messaging/message.producer.js');
const configPath = require.resolve(path.join(ROOT, 'src/config/index.js'));
const axiosPath = require.resolve('axios');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

const createFakeAxios = () => {
    const calls = { get: [] };
    let getImpl = async () => ({ data: {} });

    return {
        fakeAxios: { get: (url, config) => { calls.get.push({ url, config }); return getImpl(url, config); } },
        calls,
        setGetImpl: (fn) => { getImpl = fn; }
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

const loadUsuariosClientWithStubs = () => {
    const axiosStub = createFakeAxios();
    const trackingEvents = [];

    // Delay base mínimo para que los tests de reintentos (backoff + jitter) no queden lentos.
    process.env.RETRY_USUARIOS_BASE_DELAY_MS = '1';

    require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosStub.fakeAxios };

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

    require.cache[configPath] = {
        id: configPath,
        filename: configPath,
        loaded: true,
        exports: { usuariosServiceUrl: 'http://localhost:3001/usuarios' }
    };

    clearModule(usuariosClientPath);

    return { usuariosClient: require(usuariosClientPath), axiosStub, trackingEvents };
};

const withFreshUsuariosClient = async (fn) => {
    const ctx = loadUsuariosClientWithStubs();
    try {
        await fn(ctx);
    } finally {
        clearModule(usuariosClientPath);
        delete require.cache[axiosPath];
        delete require.cache[messageProducerPath];
        delete process.env.RETRY_USUARIOS_BASE_DELAY_MS;
    }
};

test('getUsuario reintenta (backoff + jitter) ante un fallo de red y luego tiene éxito', async () => {
    await withFreshUsuariosClient(async ({ usuariosClient, axiosStub }) => {
        let intentos = 0;
        axiosStub.setGetImpl(async () => {
            intentos += 1;
            if (intentos === 1) throw networkError();
            return { data: { idestudiante: 'e1', email: 'e1@test.com' } };
        });

        const estudiante = await usuariosClient.getUsuario('estudiantes', 'e1', 'cid-1');

        assert.equal(estudiante.idestudiante, 'e1');
        assert.equal(intentos, 2);
    });
});

test('getUsuario no reintenta ante un 404 (usuario inexistente) y devuelve null', async () => {
    await withFreshUsuariosClient(async ({ usuariosClient, axiosStub }) => {
        axiosStub.setGetImpl(async () => { throw httpError(404, 'No encontrado'); });

        const estudiante = await usuariosClient.getUsuario('estudiantes', 'inexistente', 'cid-2');

        assert.equal(estudiante, null);
        assert.equal(axiosStub.calls.get.length, 1);
    });
});

test('getUsuario agota los 3 intentos ante fallos de red persistentes y abre el circuito', async () => {
    await withFreshUsuariosClient(async ({ usuariosClient, axiosStub, trackingEvents }) => {
        axiosStub.setGetImpl(async () => { throw networkError(); });

        await assert.rejects(
            () => usuariosClient.getUsuario('estudiantes', 'e1', 'cid-3'),
            (error) => error.statusCode === 503
        );

        // volumeThreshold=2: el circuito se abre en el 2do intento real, el 3ro falla rápido sin
        // llegar a axios.
        assert.equal(axiosStub.calls.get.length, 2);
        assert.ok(trackingEvents.some((e) => e.message === 'Circuit Breaker ABIERTO para ms-usuarios'));
    });
});

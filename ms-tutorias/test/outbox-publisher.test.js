const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const dbPath = require.resolve(path.join(ROOT, 'src/config/db'));
const messageProducerPath = require.resolve(path.join(ROOT, 'src/infrastructure/messaging/message.producer'));
const outboxRepositoryPath = require.resolve(path.join(ROOT, 'src/infrastructure/repositories/outbox.repository'));
const outboxPublisherPath = path.join(ROOT, 'src/infrastructure/messaging/outbox.publisher.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

let fakeRows = [];
let publishImpl = async () => true;
const fakeClient = { query: async () => ({ rows: [] }) };

require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        // withWorkerTransaction real (no stubbeamos su lógica) pero usando un client falso:
        // ejercita el orden real de runOnce sin necesitar Postgres. El worker usa el pool
        // reservado (S6).
        withWorkerTransaction: async (callback) => callback(fakeClient)
    }
};

require.cache[messageProducerPath] = {
    id: messageProducerPath,
    filename: messageProducerPath,
    loaded: true,
    exports: {
        publishToQueue: async (queueName, payload) => publishImpl(queueName, payload),
        publishTrackingEvent: async () => undefined,
        connect: async () => undefined
    }
};

let outboxCalls;

require.cache[outboxRepositoryPath] = {
    id: outboxRepositoryPath,
    filename: outboxRepositoryPath,
    loaded: true,
    exports: {
        reclamarPendientes: async () => fakeRows,
        marcarPublicado: async (client, idOutbox) => { outboxCalls.publicados.push(idOutbox); },
        registrarIntentoFallido: async (client, idOutbox, intentosActuales, mensajeError, maxIntentos) => {
            outboxCalls.fallidos.push({ idOutbox, intentosActuales, mensajeError, maxIntentos });
        },
        insertarPendiente: async () => { throw new Error('no debería llamarse desde el poller'); }
    }
};

clearModule(outboxPublisherPath);
const outboxPublisher = require(outboxPublisherPath);

beforeEach(() => {
    fakeRows = [];
    publishImpl = async () => true;
    outboxCalls = { publicados: [], fallidos: [] };
});

test('runOnce publica cada fila pendiente y la marca PUBLICADO', async () => {
    fakeRows = [
        { idoutbox: 'o1', payload: { a: 1 }, intentos: 0 },
        { idoutbox: 'o2', payload: { a: 2 }, intentos: 0 }
    ];

    const resultado = await outboxPublisher.runOnce({ limit: 10 });

    assert.equal(resultado.procesados, 2);
    assert.equal(resultado.publicados, 2);
    assert.equal(resultado.fallidos, 0);
    assert.deepEqual(outboxCalls.publicados, ['o1', 'o2']);
    assert.deepEqual(outboxCalls.fallidos, []);
});

test('runOnce registra un intento fallido cuando publishToQueue devuelve false', async () => {
    fakeRows = [{ idoutbox: 'o1', payload: { a: 1 }, intentos: 2 }];
    publishImpl = async () => false;

    const resultado = await outboxPublisher.runOnce({ limit: 10 });

    assert.equal(resultado.publicados, 0);
    assert.equal(resultado.fallidos, 1);
    assert.equal(outboxCalls.fallidos.length, 1);
    assert.equal(outboxCalls.fallidos[0].idOutbox, 'o1');
    assert.equal(outboxCalls.fallidos[0].intentosActuales, 2);
});

test('runOnce no hace nada si ya hay un ciclo en curso (guard de reentrancia)', async () => {
    fakeRows = [{ idoutbox: 'o1', payload: {}, intentos: 0 }];

    let resolverPublish;
    publishImpl = () => new Promise((resolve) => { resolverPublish = resolve; });

    const primerCiclo = outboxPublisher.runOnce({ limit: 10 });
    const segundoCiclo = await outboxPublisher.runOnce({ limit: 10 });

    assert.equal(segundoCiclo.omitido, true);

    resolverPublish(true);
    const resultadoPrimero = await primerCiclo;
    assert.equal(resultadoPrimero.publicados, 1);
});

test('S12: start() programa runOnce en un intervalo real y stop() lo detiene', async (t) => {
    const reclamarOriginal = require.cache[outboxRepositoryPath].exports.reclamarPendientes;
    let reclamos = 0;
    require.cache[outboxRepositoryPath].exports.reclamarPendientes = async () => { reclamos += 1; return []; };

    t.mock.timers.enable({ apis: ['setInterval'] });
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    try {
        outboxPublisher.start();

        t.mock.timers.tick(3000);
        await flush();
        t.mock.timers.tick(3000);
        await flush();
        assert.equal(reclamos, 2, 'dos intervalos completos deberían disparar dos ticks');

        outboxPublisher.stop();

        t.mock.timers.tick(3000);
        t.mock.timers.tick(3000);
        await flush();
        assert.equal(reclamos, 2, 'stop() debe impedir que se programen más ticks');
    } finally {
        outboxPublisher.stop();
        require.cache[outboxRepositoryPath].exports.reclamarPendientes = reclamarOriginal;
    }
});

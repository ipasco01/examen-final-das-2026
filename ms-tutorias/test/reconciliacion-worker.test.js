const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const tutoriaRepositoryPath = require.resolve(path.join(ROOT, 'src/infrastructure/repositories/tutoria.repository'));
const messageProducerPath = require.resolve(path.join(ROOT, 'src/infrastructure/messaging/message.producer'));
const reconciliacionWorkerPath = path.join(ROOT, 'src/infrastructure/workers/reconciliacion.worker.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

let fakeRows = [];
let reconciliarCalls;
let trackingEvents;

require.cache[tutoriaRepositoryPath] = {
    id: tutoriaRepositoryPath,
    filename: tutoriaRepositoryPath,
    loaded: true,
    exports: {
        reconciliarPendientesViejas: async (fechaCorte, limit) => {
            reconciliarCalls.push({ fechaCorte, limit });
            return fakeRows;
        }
    }
};

require.cache[messageProducerPath] = {
    id: messageProducerPath,
    filename: messageProducerPath,
    loaded: true,
    exports: {
        publishTrackingEvent: async (payload) => { trackingEvents.push(payload); }
    }
};

clearModule(reconciliacionWorkerPath);
const reconciliacionWorker = require(reconciliacionWorkerPath);

beforeEach(() => {
    fakeRows = [];
    reconciliarCalls = [];
    trackingEvents = [];
});

test('runOnce reclama filas PENDIENTE viejas y publica un evento de tracking por cada una', async () => {
    fakeRows = [
        { idtutoria: 't1', idtutor: 'tutor-1', idempotencykey: 'idem-1' },
        { idtutoria: 't2', idtutor: 'tutor-2', idempotencykey: null }
    ];

    const resultado = await reconciliacionWorker.runOnce({ limit: 10, umbralMs: 60000 });

    assert.equal(resultado.procesados, 2);
    assert.equal(reconciliarCalls.length, 1);
    assert.equal(reconciliarCalls[0].limit, 10);
    assert.ok(reconciliarCalls[0].fechaCorte instanceof Date);

    assert.equal(trackingEvents.length, 2);
    assert.match(trackingEvents[0].message, /t1/);
    assert.match(trackingEvents[0].message, /tutor-1/);
    assert.equal(trackingEvents[0].cid, 'idem-1');
    assert.equal(trackingEvents[0].status, 'ERROR');
    assert.equal(trackingEvents[1].cid, null);
});

test('runOnce no hace nada si no hay filas viejas', async () => {
    fakeRows = [];

    const resultado = await reconciliacionWorker.runOnce({ limit: 10 });

    assert.equal(resultado.procesados, 0);
    assert.equal(trackingEvents.length, 0);
});

test('runOnce no hace nada si ya hay un ciclo en curso (guard de reentrancia)', async () => {
    let resolverReclamo;
    reconciliarCalls = [];
    require.cache[tutoriaRepositoryPath].exports.reconciliarPendientesViejas = () => new Promise((resolve) => {
        resolverReclamo = () => resolve([]);
    });

    const primerCiclo = reconciliacionWorker.runOnce({ limit: 10 });
    const segundoCiclo = await reconciliacionWorker.runOnce({ limit: 10 });

    assert.equal(segundoCiclo.omitido, true);

    resolverReclamo();
    await primerCiclo;

    // Restaurar el stub original para no afectar otros tests de este archivo.
    require.cache[tutoriaRepositoryPath].exports.reconciliarPendientesViejas = async (fechaCorte, limit) => {
        reconciliarCalls.push({ fechaCorte, limit });
        return fakeRows;
    };
});

test('S12: start() programa runOnce en un intervalo real y stop() lo detiene', async (t) => {
    const reconciliarOriginal = require.cache[tutoriaRepositoryPath].exports.reconciliarPendientesViejas;
    let llamadas = 0;
    require.cache[tutoriaRepositoryPath].exports.reconciliarPendientesViejas = async () => { llamadas += 1; return []; };

    t.mock.timers.enable({ apis: ['setInterval'] });
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    try {
        reconciliacionWorker.start();

        t.mock.timers.tick(60000);
        await flush();
        t.mock.timers.tick(60000);
        await flush();
        assert.equal(llamadas, 2, 'dos intervalos completos deberían disparar dos ticks');

        reconciliacionWorker.stop();

        t.mock.timers.tick(60000);
        t.mock.timers.tick(60000);
        await flush();
        assert.equal(llamadas, 2, 'stop() debe impedir que se programen más ticks');
    } finally {
        reconciliacionWorker.stop();
        require.cache[tutoriaRepositoryPath].exports.reconciliarPendientesViejas = reconciliarOriginal;
    }
});

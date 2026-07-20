const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const dbPath = require.resolve(path.join(ROOT, 'src/config/db'));
const agendaClientPath = require.resolve(path.join(ROOT, 'src/infrastructure/clients/agenda.client'));
const compensacionRepositoryPath = require.resolve(path.join(ROOT, 'src/infrastructure/repositories/compensacion.repository'));
const compensacionWorkerPath = path.join(ROOT, 'src/infrastructure/workers/compensacion.worker.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

let fakeRows = [];
let cancelarBloqueoImpl = async () => undefined;
const fakeClient = { query: async () => ({ rows: [] }) };

require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        // withWorkerTransaction real (no stubbeamos su lógica) pero con un client falso: ejercita
        // el orden real de runOnce sin necesitar Postgres. El worker usa el pool reservado (S6).
        withWorkerTransaction: async (callback) => callback(fakeClient)
    }
};

require.cache[agendaClientPath] = {
    id: agendaClientPath,
    filename: agendaClientPath,
    loaded: true,
    exports: {
        cancelarBloqueo: async (idBloqueo, correlationId) => cancelarBloqueoImpl(idBloqueo, correlationId),
        verificarDisponibilidad: async () => { throw new Error('no debería llamarse desde el worker'); },
        bloquearAgenda: async () => { throw new Error('no debería llamarse desde el worker'); }
    }
};

let compensacionCalls;

require.cache[compensacionRepositoryPath] = {
    id: compensacionRepositoryPath,
    filename: compensacionRepositoryPath,
    loaded: true,
    exports: {
        reclamarPendientes: async () => fakeRows,
        marcarResuelto: async (client, idCompensacion) => { compensacionCalls.resueltos.push(idCompensacion); },
        registrarIntentoFallido: async (client, idCompensacion, intentosActuales, mensajeError, maxIntentos) => {
            const nuevosIntentos = intentosActuales + 1;
            const nuevoEstado = nuevosIntentos >= maxIntentos ? 'FALLIDO' : 'PENDIENTE';
            compensacionCalls.fallidos.push({ idCompensacion, intentosActuales, mensajeError, maxIntentos, nuevoEstado });
            return { nuevoEstado, nuevosIntentos };
        },
        insertarPendiente: async () => { throw new Error('no debería llamarse desde el worker'); }
    }
};

clearModule(compensacionWorkerPath);
const compensacionWorker = require(compensacionWorkerPath);

beforeEach(() => {
    fakeRows = [];
    cancelarBloqueoImpl = async () => undefined;
    compensacionCalls = { resueltos: [], fallidos: [] };
});

test('runOnce reintenta cancelarBloqueo para cada fila pendiente y marca RESUELTO en éxito', async () => {
    fakeRows = [
        { idcompensacion: 'c1', idbloqueo: 'b1', correlationid: 'cid-1', intentos: 0 },
        { idcompensacion: 'c2', idbloqueo: 'b2', correlationid: 'cid-2', intentos: 1 }
    ];

    const resultado = await compensacionWorker.runOnce({ limit: 10 });

    assert.equal(resultado.procesados, 2);
    assert.equal(resultado.resueltos, 2);
    assert.equal(resultado.fallidos, 0);
    assert.deepEqual(compensacionCalls.resueltos, ['c1', 'c2']);
    assert.deepEqual(compensacionCalls.fallidos, []);
});

test('runOnce registra un intento fallido cuando cancelarBloqueo vuelve a fallar (sin agotar el máximo)', async () => {
    fakeRows = [{ idcompensacion: 'c1', idbloqueo: 'b1', correlationid: 'cid-1', intentos: 0 }];
    cancelarBloqueoImpl = async () => { throw new Error('ms-agenda sigue caído'); };

    const resultado = await compensacionWorker.runOnce({ limit: 10 });

    assert.equal(resultado.resueltos, 0);
    assert.equal(resultado.fallidos, 1);
    assert.equal(compensacionCalls.fallidos.length, 1);
    assert.equal(compensacionCalls.fallidos[0].nuevoEstado, 'PENDIENTE');
});

test('runOnce marca FALLIDO tras agotar COMPENSACION_PENDIENTE_MAX_INTENTOS (default 3)', async () => {
    fakeRows = [{ idcompensacion: 'c1', idbloqueo: 'b1', correlationid: 'cid-1', intentos: 2 }];
    cancelarBloqueoImpl = async () => { throw new Error('ms-agenda sigue caído'); };

    await compensacionWorker.runOnce({ limit: 10 });

    assert.equal(compensacionCalls.fallidos[0].nuevoEstado, 'FALLIDO');
});

test('runOnce no hace nada si ya hay un ciclo en curso (guard de reentrancia)', async () => {
    fakeRows = [{ idcompensacion: 'c1', idbloqueo: 'b1', correlationid: 'cid-1', intentos: 0 }];

    let resolverCancelacion;
    cancelarBloqueoImpl = () => new Promise((resolve) => { resolverCancelacion = resolve; });

    const primerCiclo = compensacionWorker.runOnce({ limit: 10 });
    const segundoCiclo = await compensacionWorker.runOnce({ limit: 10 });

    assert.equal(segundoCiclo.omitido, true);

    resolverCancelacion();
    const resultadoPrimero = await primerCiclo;
    assert.equal(resultadoPrimero.resueltos, 1);
});

test('S12: start() programa runOnce en un intervalo real y stop() lo detiene', async (t) => {
    const reclamarOriginal = require.cache[compensacionRepositoryPath].exports.reclamarPendientes;
    let reclamos = 0;
    require.cache[compensacionRepositoryPath].exports.reclamarPendientes = async () => { reclamos += 1; return []; };

    t.mock.timers.enable({ apis: ['setInterval'] });
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    try {
        compensacionWorker.start();

        t.mock.timers.tick(5000);
        await flush();
        t.mock.timers.tick(5000);
        await flush();
        assert.equal(reclamos, 2, 'dos intervalos completos deberían disparar dos ticks');

        compensacionWorker.stop();

        t.mock.timers.tick(5000);
        t.mock.timers.tick(5000);
        await flush();
        assert.equal(reclamos, 2, 'stop() debe impedir que se programen más ticks');
    } finally {
        compensacionWorker.stop();
        require.cache[compensacionRepositoryPath].exports.reclamarPendientes = reclamarOriginal;
    }
});

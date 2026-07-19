const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dbPath = require.resolve(path.join(ROOT, 'src/config/db'));
const repositoryPath = path.join(ROOT, 'src/infrastructure/repositories/tutoria.repository.js');

let queryImpl = async () => ({ rows: [] });
// El client de una transacción "falsa": reusa el mismo queryImpl para que un test pueda observar,
// en un único array, tanto las queries del UPDATE guardado como las del INSERT en outbox.
const fakeClient = { query: (text, params) => queryImpl(text, params) };

require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        query: (text, params) => queryImpl(text, params),
        withTransaction: async (callback) => callback(fakeClient),
        // S6: reconciliarPendientesViejas usa el pool reservado para workers de fondo -- reusa el
        // mismo queryImpl falso para que los tests existentes de esa función no cambien.
        workerQuery: (text, params) => queryImpl(text, params)
    }
};

delete require.cache[require.resolve(repositoryPath)];
const tutoriaRepository = require(repositoryPath);

beforeEach(() => {
    queryImpl = async () => ({ rows: [] });
});

test('UPDATE hacia CONFIRMADA sobre una fila PENDIENTE actualiza normalmente', async () => {
    const queries = [];
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        // Simula que la fila PENDIENTE matchea el WHERE (incluyendo el guard de estado).
        return { rows: [{ idtutoria: 'tutoria-1', estado: 'CONFIRMADA' }] };
    };

    const resultado = await tutoriaRepository.save({ idTutoria: 'tutoria-1', estado: 'CONFIRMADA', error: null });

    assert.equal(resultado.estado, 'CONFIRMADA');
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /AND estado = ANY\(\$4\)/);
    assert.deepEqual(queries[0].params[queries[0].params.length - 1], ['PENDIENTE']);
});

test('UPDATE hacia CONFIRMADA sobre una fila que ya no está PENDIENTE lanza INVALID_STATE_TRANSITION', async () => {
    let call = 0;
    queryImpl = async (text) => {
        call += 1;
        if (call === 1) {
            // El UPDATE guardado no matchea ninguna fila (la fila real ya no es PENDIENTE).
            return { rows: [] };
        }
        // La consulta de desambiguación revela el estado real.
        assert.match(text, /SELECT estado FROM tutorias/);
        return { rows: [{ estado: 'CONFIRMADA' }] };
    };

    await assert.rejects(
        () => tutoriaRepository.save({ idTutoria: 'tutoria-1', estado: 'FALLIDA', error: 'boom' }),
        (error) => {
            assert.equal(error.statusCode, 409);
            assert.equal(error.code, 'INVALID_STATE_TRANSITION');
            assert.match(error.message, /no se puede pasar de 'CONFIRMADA' a 'FALLIDA'/);
            return true;
        }
    );
});

test('UPDATE sobre una tutoría inexistente sigue lanzando el error de "no encontrada"', async () => {
    let call = 0;
    queryImpl = async () => {
        call += 1;
        // Tanto el UPDATE como la desambiguación no encuentran ninguna fila.
        return { rows: [] };
    };

    await assert.rejects(
        () => tutoriaRepository.save({ idTutoria: 'no-existe', estado: 'CONFIRMADA', error: null }),
        (error) => {
            assert.match(error.message, /No se encontró tutoría con id no-existe/);
            return true;
        }
    );
    assert.equal(call, 2);
});

test('INSERT con estado inicial distinto de PENDIENTE es rechazado', async () => {
    await assert.rejects(
        () => tutoriaRepository.save({ idEstudiante: 'e1', idTutor: 't1', fecha: new Date(), materia: 'X', estado: 'CONFIRMADA' }),
        (error) => {
            assert.equal(error.statusCode, 400);
            assert.equal(error.code, 'INVALID_INITIAL_STATE');
            return true;
        }
    );
});

test('INSERT sin estado explícito (default PENDIENTE) funciona con normalidad', async () => {
    queryImpl = async (text, params) => {
        assert.match(text, /INSERT INTO tutorias/);
        return { rows: [{ idtutoria: 'tutoria-nueva', estado: 'PENDIENTE' }] };
    };

    const resultado = await tutoriaRepository.save({ idEstudiante: 'e1', idTutor: 't1', fecha: new Date(), materia: 'X' });

    assert.equal(resultado.estado, 'PENDIENTE');
});

test('save() con outboxNotificacion inserta en outbox tras un UPDATE exitoso, dentro de la misma transacción', async () => {
    const queries = [];
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        if (/UPDATE tutorias/.test(text)) {
            return { rows: [{ idtutoria: 'tutoria-1', estado: 'CONFIRMADA' }] };
        }
        if (/INSERT INTO tutorias_notificaciones_outbox/.test(text)) {
            return { rows: [{ idoutbox: 'outbox-1' }] };
        }
        throw new Error(`Query inesperada en el test: ${text}`);
    };

    const resultado = await tutoriaRepository.save(
        { idTutoria: 'tutoria-1', estado: 'CONFIRMADA', error: null },
        { outboxNotificacion: { destinatario: 'a@b.com' } }
    );

    assert.equal(resultado.estado, 'CONFIRMADA');
    assert.equal(queries.length, 2);
    assert.match(queries[0].text, /UPDATE tutorias/);
    assert.match(queries[1].text, /INSERT INTO tutorias_notificaciones_outbox/);
    assert.deepEqual(queries[1].params, ['tutoria-1', { destinatario: 'a@b.com' }]);
});

test('save() con outboxNotificacion NO inserta en outbox si el UPDATE guardado no matchea ninguna fila', async () => {
    const queries = [];
    let call = 0;
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        call += 1;
        if (call === 1) {
            // El UPDATE guardado no matchea (la fila ya no está PENDIENTE).
            return { rows: [] };
        }
        // Desambiguación.
        return { rows: [{ estado: 'FALLIDA' }] };
    };

    await assert.rejects(
        () => tutoriaRepository.save(
            { idTutoria: 'tutoria-1', estado: 'CONFIRMADA', error: null },
            { outboxNotificacion: { destinatario: 'a@b.com' } }
        ),
        (error) => {
            assert.equal(error.code, 'INVALID_STATE_TRANSITION');
            return true;
        }
    );

    // Punto crítico de D2: si el UPDATE no afectó ninguna fila, jamás debe llegar a insertarse la
    // notificación en outbox (evitaría un email para una Saga que en realidad falló).
    assert.ok(queries.every((q) => !/INSERT INTO tutorias_notificaciones_outbox/.test(q.text)));
});

test('save() con compensacionPendiente inserta en compensaciones_pendientes tras un UPDATE exitoso, dentro de la misma transacción', async () => {
    const queries = [];
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        if (/UPDATE tutorias/.test(text)) {
            return { rows: [{ idtutoria: 'tutoria-1', estado: 'FALLIDA' }] };
        }
        if (/INSERT INTO compensaciones_pendientes/.test(text)) {
            return { rows: [{ idcompensacion: 'compensacion-1' }] };
        }
        throw new Error(`Query inesperada en el test: ${text}`);
    };

    const resultado = await tutoriaRepository.save(
        { idTutoria: 'tutoria-1', estado: 'FALLIDA', error: 'boom' },
        { compensacionPendiente: { idBloqueo: 'bloqueo-1', idTutor: 't1', correlationId: 'cid-1', motivo: 'timeout' } }
    );

    assert.equal(resultado.estado, 'FALLIDA');
    assert.equal(queries.length, 2);
    assert.match(queries[0].text, /UPDATE tutorias/);
    assert.match(queries[1].text, /INSERT INTO compensaciones_pendientes/);
    assert.deepEqual(queries[1].params, ['bloqueo-1', 'tutoria-1', 't1', 'cid-1', 'timeout']);
});

test('save() con compensacionPendiente NO inserta en compensaciones_pendientes si el UPDATE guardado no matchea ninguna fila', async () => {
    const queries = [];
    let call = 0;
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        call += 1;
        if (call === 1) {
            // El UPDATE guardado no matchea (la fila ya no está PENDIENTE).
            return { rows: [] };
        }
        // Desambiguación.
        return { rows: [{ estado: 'CONFIRMADA' }] };
    };

    await assert.rejects(
        () => tutoriaRepository.save(
            { idTutoria: 'tutoria-1', estado: 'FALLIDA', error: 'boom' },
            { compensacionPendiente: { idBloqueo: 'bloqueo-1', idTutor: 't1', correlationId: 'cid-1', motivo: 'timeout' } }
        ),
        (error) => {
            assert.equal(error.code, 'INVALID_STATE_TRANSITION');
            return true;
        }
    );

    // Mismo punto crítico que para el outbox: si el UPDATE no afectó ninguna fila, no debe quedar
    // un registro de compensación pendiente huérfano para una tutoría que ni llegó a FALLIDA.
    assert.ok(queries.every((q) => !/INSERT INTO compensaciones_pendientes/.test(q.text)));
});

test('reconciliarPendientesViejas (S2) solo apunta a los orígenes válidos para FALLIDA, no a PENDIENTE hardcodeado', async () => {
    const queries = [];
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        return { rows: [{ idtutoria: 'tutoria-vieja', idtutor: 't1' }] };
    };

    const fechaCorte = new Date('2026-01-01T00:00:00.000Z');
    const filas = await tutoriaRepository.reconciliarPendientesViejas(fechaCorte, 20);

    assert.equal(filas.length, 1);
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /estado = ANY\(\$1\)/);
    assert.match(queries[0].text, /createdAt < \$2/);
    assert.deepEqual(queries[0].params, [['PENDIENTE'], fechaCorte, 20]);
});

test('findByEstudiante filtra por idEstudiante', async () => {
    const queries = [];
    queryImpl = async (text, params) => {
        queries.push({ text, params });
        return { rows: [{ idtutoria: 'tutoria-1', idestudiante: 'student-1' }] };
    };

    const filas = await tutoriaRepository.findByEstudiante('student-1');

    assert.equal(filas.length, 1);
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /WHERE idEstudiante = \$1/);
    assert.deepEqual(queries[0].params, ['student-1']);
});

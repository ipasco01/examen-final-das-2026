// Cancelación de una tutoría CONFIRMADA -- cierra el gap de CANCELADA documentado en S11.
// cancelarTutoria reusa el mismo mecanismo de reintento + compensación pendiente que el catch-all
// de la Saga (mismo COMPENSACION_AGENDA_MAX_INTENTOS/COMPENSACION_AGENDA_BASE_DELAY_MS).
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

const withCompensacionEnvRapido = async (fn) => {
    const originalMax = process.env.COMPENSACION_AGENDA_MAX_INTENTOS;
    const originalDelay = process.env.COMPENSACION_AGENDA_BASE_DELAY_MS;
    process.env.COMPENSACION_AGENDA_MAX_INTENTOS = '2';
    process.env.COMPENSACION_AGENDA_BASE_DELAY_MS = '1';
    try {
        return await fn();
    } finally {
        if (originalMax === undefined) delete process.env.COMPENSACION_AGENDA_MAX_INTENTOS; else process.env.COMPENSACION_AGENDA_MAX_INTENTOS = originalMax;
        if (originalDelay === undefined) delete process.env.COMPENSACION_AGENDA_BASE_DELAY_MS; else process.env.COMPENSACION_AGENDA_BASE_DELAY_MS = originalDelay;
    }
};

const loadServiceWithStubs = ({ tutoriaExistente, cancelarBloqueoImpl } = {}) => {
    const calls = { saves: [], cancelarBloqueo: [], compensacionPendiente: null };

    const repository = {
        findById: async (id) => (tutoriaExistente && tutoriaExistente.idtutoria === id ? tutoriaExistente : null),
        save: async (payload, options = {}) => {
            calls.saves.push(payload);
            if (options.compensacionPendiente) {
                calls.compensacionPendiente = options.compensacionPendiente;
            }
            return { ...tutoriaExistente, ...payload, idtutoria: payload.idTutoria };
        }
    };

    const agendaClient = {
        cancelarBloqueo: async (idBloqueo, correlationId) => {
            calls.cancelarBloqueo.push({ idBloqueo, correlationId });
            if (cancelarBloqueoImpl) return cancelarBloqueoImpl();
        }
    };

    for (const filePath of [servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }
    require.cache[require.resolve(repositoryPath)] = { exports: repository };
    require.cache[require.resolve(usuariosClientPath)] = { exports: {} };
    require.cache[require.resolve(agendaClientPath)] = { exports: agendaClient };
    require.cache[require.resolve(messageProducerPath)] = { exports: { publishTrackingEvent: async () => undefined } };

    return { tutoriaService: require(servicePath), calls };
};

test('cancelarTutoria libera el bloqueo y marca CANCELADA', async () => {
    const tutoriaExistente = {
        idtutoria: 'tutoria-1', idestudiante: 'student-1', idtutor: 'tutor-1',
        estado: 'CONFIRMADA', idbloqueo: 'bloqueo-1'
    };
    const { tutoriaService, calls } = loadServiceWithStubs({ tutoriaExistente });

    try {
        const resultado = await tutoriaService.cancelarTutoria('tutoria-1', 'student-1', 'cid-cancel');

        assert.equal(resultado.estado, 'CANCELADA');
        assert.deepEqual(calls.cancelarBloqueo, [{ idBloqueo: 'bloqueo-1', correlationId: 'cid-cancel' }]);
        assert.equal(calls.compensacionPendiente, null);
        assert.deepEqual(calls.saves[0], { idTutoria: 'tutoria-1', estado: 'CANCELADA', error: null });
    } finally {
        clearModule(servicePath);
    }
});

test('cancelarTutoria sin idBloqueo (fila legacy) cancela sin intentar liberar nada', async () => {
    const tutoriaExistente = {
        idtutoria: 'tutoria-1', idestudiante: 'student-1', idtutor: 'tutor-1',
        estado: 'CONFIRMADA', idbloqueo: null
    };
    const { tutoriaService, calls } = loadServiceWithStubs({ tutoriaExistente });

    try {
        const resultado = await tutoriaService.cancelarTutoria('tutoria-1', 'student-1', 'cid-cancel');

        assert.equal(resultado.estado, 'CANCELADA');
        assert.deepEqual(calls.cancelarBloqueo, []);
    } finally {
        clearModule(servicePath);
    }
});

test('cancelarTutoria registra compensación pendiente si liberar el bloqueo falla tras agotar reintentos, pero igual cancela', async () => {
    await withCompensacionEnvRapido(async () => {
        const tutoriaExistente = {
            idtutoria: 'tutoria-1', idestudiante: 'student-1', idtutor: 'tutor-1',
            estado: 'CONFIRMADA', idbloqueo: 'bloqueo-1'
        };
        const { tutoriaService, calls } = loadServiceWithStubs({
            tutoriaExistente,
            cancelarBloqueoImpl: () => { throw new Error('ms-agenda no responde'); }
        });

        try {
            const resultado = await tutoriaService.cancelarTutoria('tutoria-1', 'student-1', 'cid-cancel');

            assert.equal(resultado.estado, 'CANCELADA');
            assert.equal(calls.cancelarBloqueo.length, 2); // COMPENSACION_AGENDA_MAX_INTENTOS=2
            assert.ok(calls.compensacionPendiente);
            assert.equal(calls.compensacionPendiente.idBloqueo, 'bloqueo-1');
            assert.match(calls.compensacionPendiente.motivo, /ms-agenda no responde/);
        } finally {
            clearModule(servicePath);
        }
    });
});

test('cancelarTutoria responde 404 si la tutoría no existe', async () => {
    const { tutoriaService } = loadServiceWithStubs({ tutoriaExistente: null });

    try {
        await assert.rejects(
            () => tutoriaService.cancelarTutoria('no-existe', 'student-1', 'cid'),
            (error) => { assert.equal(error.statusCode, 404); return true; }
        );
    } finally {
        clearModule(servicePath);
    }
});

test('cancelarTutoria responde 404 si la tutoría es de otro estudiante', async () => {
    const tutoriaExistente = { idtutoria: 'tutoria-1', idestudiante: 'otro-estudiante', estado: 'CONFIRMADA', idbloqueo: 'bloqueo-1' };
    const { tutoriaService } = loadServiceWithStubs({ tutoriaExistente });

    try {
        await assert.rejects(
            () => tutoriaService.cancelarTutoria('tutoria-1', 'student-1', 'cid'),
            (error) => { assert.equal(error.statusCode, 404); return true; }
        );
    } finally {
        clearModule(servicePath);
    }
});

test('cancelarTutoria responde 409 si la tutoría no está CONFIRMADA', async () => {
    for (const estado of ['PENDIENTE', 'FALLIDA', 'CANCELADA']) {
        const tutoriaExistente = { idtutoria: 'tutoria-1', idestudiante: 'student-1', estado, idbloqueo: null };
        const { tutoriaService } = loadServiceWithStubs({ tutoriaExistente });

        try {
            await assert.rejects(
                () => tutoriaService.cancelarTutoria('tutoria-1', 'student-1', 'cid'),
                (error) => { assert.equal(error.statusCode, 409, `estado: ${estado}`); return true; }
            );
        } finally {
            clearModule(servicePath);
        }
    }
});

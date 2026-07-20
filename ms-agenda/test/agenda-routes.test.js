const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { after, before, beforeEach, test } = require('node:test');

// Debe fijarse antes de requerir '../src/app' (y su config), que lee JWT_SECRET al cargarse.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const testToken = jwt.sign({ sub: 'estudiante-1', role: 'student' }, process.env.JWT_SECRET);
const authHeaders = { Authorization: `Bearer ${testToken}` };

const servicePath = require.resolve('../src/domain/services/agenda.service');
const producerPath = require.resolve('../src/infrastructure/messaging/message.producer');

const calls = {
    crearBloqueo: [],
    compensarBloqueo: []
};

let crearBloqueoImpl = async () => ({ idBloqueo: 'bloqueo-1' });
let compensarBloqueoImpl = async () => ({ compensado: true });

require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
        verificarDisponibilidad: async () => ({ disponible: true }),
        crearBloqueo: async (idTutor, datosBloqueo) => {
            calls.crearBloqueo.push({ idTutor, datosBloqueo });
            return crearBloqueoImpl(idTutor, datosBloqueo);
        },
        compensarBloqueo: async (idBloqueo) => {
            calls.compensarBloqueo.push(idBloqueo);
            return compensarBloqueoImpl(idBloqueo);
        }
    }
};

require.cache[producerPath] = {
    id: producerPath,
    filename: producerPath,
    loaded: true,
    exports: {
        connect: async () => undefined,
        track: () => undefined
    }
};

const app = require('../src/app');

let server;
let baseUrl;

before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
});

beforeEach(() => {
    calls.crearBloqueo = [];
    calls.compensarBloqueo = [];
    crearBloqueoImpl = async () => ({ idBloqueo: 'bloqueo-1' });
    compensarBloqueoImpl = async () => ({ compensado: true });
});

const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            'content-type': 'application/json',
            ...(options.headers || {})
        }
    });

    const text = await response.text();
    return {
        status: response.status,
        body: text ? JSON.parse(text) : undefined
    };
};

test('POST /agenda/tutores/:id_tutor/bloquear maps duplicate reservation errors to 409', async () => {
    crearBloqueoImpl = async () => {
        const error = new Error('duplicate key value violates unique constraint');
        error.code = '23505';
        throw error;
    };

    const response = await request('/agenda/tutores/tutor-1/bloquear', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
            fechaInicio: '2026-07-01T10:00:00.000Z',
            duracionMinutos: 60,
            idEstudiante: 'estudiante-1'
        })
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.statusCode, 409);
    assert.match(response.body.error.message, /horario ya está reservado/i);
    assert.equal(calls.crearBloqueo.length, 1);
});

test('DELETE /agenda/bloqueos/:idBloqueo calls compensation service and returns success', async () => {
    const response = await request('/agenda/bloqueos/bloqueo-123', {
        method: 'DELETE',
        headers: authHeaders
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { message: 'Bloqueo compensado (eliminado)' });
    assert.deepEqual(calls.compensarBloqueo, ['bloqueo-123']);
});

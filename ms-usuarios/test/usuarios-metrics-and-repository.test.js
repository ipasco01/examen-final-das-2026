const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, beforeEach, test } = require('node:test');

process.env.SERVICE_NAME = 'MS_Usuarios';

const dbPath = require.resolve('../src/config/db');
const producerPath = require.resolve('../src/infrastructure/messaging/message.producer');

let queryImpl = async () => ({ rows: [] });

require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        query: (text, params) => queryImpl(text, params)
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

const usuariosRepository = require('../src/infrastructure/repositories/usuarios.repository');
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
    queryImpl = async () => ({ rows: [] });
});

test('GET /metrics exposes Prometheus metrics without connecting to RabbitMQ or PostgreSQL', async () => {
    await fetch(`${baseUrl}/metrics-probe`);

    const response = await fetch(`${baseUrl}/metrics`, {
        method: 'GET',
        headers: { accept: 'text/plain' }
    });

    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/plain/);
    assert.match(body, /^up 1$/m);
    assert.match(body, /service_name="MS_Usuarios"/);
});

test('repository maps undefined estudiantes table errors to an initialization contract', async () => {
    const dbError = new Error('relation "estudiantes" does not exist');
    dbError.code = '42P01';
    dbError.stack = dbError.message;
    queryImpl = async () => { throw dbError; };

    await assert.rejects(
        () => usuariosRepository.findEstudianteById('estudiante-1'),
        (error) => {
            assert.equal(error.statusCode, 500);
            assert.equal(error.code, '42P01');
            assert.equal(error.cause, dbError);
            assert.match(error.message, /falta la tabla estudiantes/i);
            return true;
        }
    );
});

test('repository preserves non-schema database errors', async () => {
    const dbError = new Error('connection refused');
    dbError.code = 'ECONNREFUSED';
    dbError.stack = dbError.message;
    queryImpl = async () => { throw dbError; };

    await assert.rejects(
        () => usuariosRepository.findTutorById('tutor-1'),
        (error) => error === dbError
    );
});

// GET /usuarios/tutores -- listado para poblar el desplegable del simulador.

test('findAllTutores selecciona columnas explicitas, no SELECT *', async () => {
    // Un listado publico no debe arrastrar columnas nuevas que alguien agregue a `tutores` mas
    // adelante. Se afirma sobre el SQL emitido porque es la unica forma de verificar la intencion:
    // con datos de prueba controlados, un SELECT * pasaria igual.
    let sqlEmitido = null;
    queryImpl = async (text) => { sqlEmitido = text; return { rows: [] }; };

    await usuariosRepository.findAllTutores();

    assert.doesNotMatch(sqlEmitido, /SELECT\s+\*/i, 'no debe usar SELECT *');
    assert.match(sqlEmitido, /id.*nombreCompleto.*especialidad/is);
    assert.match(sqlEmitido, /ORDER BY/i, 'el orden estable evita que las opciones salten entre recargas');
});

test('findAllTutores devuelve [] cuando no hay tutores, no un error', async () => {
    // Lista vacia es un estado legitimo, no una falla: si devolviera 404 el cliente tendria que
    // tratar "todavia no hay tutores cargados" como si el servicio estuviera roto.
    queryImpl = async () => ({ rows: [] });

    const tutores = await usuariosRepository.findAllTutores();

    assert.deepEqual(tutores, []);
});

test('findAllTutores mapea el error de tabla ausente al mismo contrato que el resto', async () => {
    const dbError = new Error('relation "tutores" does not exist');
    dbError.code = '42P01';
    dbError.stack = dbError.message;
    queryImpl = async () => { throw dbError; };

    await assert.rejects(
        () => usuariosRepository.findAllTutores(),
        (error) => {
            assert.equal(error.statusCode, 500);
            assert.match(error.message, /falta la tabla tutores/i);
            return true;
        }
    );
});

test('GET /usuarios/tutores exige token, igual que el resto de las rutas', async () => {
    // El catalogo no es informacion publica: va detras del mismo jwt.middleware que protege
    // /estudiantes/:id y /tutores/:id. Sin este test, agregar la ruta sin el middleware pasaria
    // desapercibido -- es exactamente el hueco que tenia ms-notificaciones antes del 19/07.
    const response = await fetch(`${baseUrl}/usuarios/tutores`);

    assert.equal(response.status, 401);
});

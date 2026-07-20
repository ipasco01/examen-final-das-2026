// S5: validación de campos de la solicitud. La forma (presencia/tipo) se valida en el controller
// para TODO request, incluidos los reintentos idempotentes; "fechaSolicitada debe ser futura" es
// una regla de negocio que vive en el servicio, después del short-circuit de idempotencia (ver
// tutoria-compensacion-idempotencia.test.js para el caso de reintento con fecha ya pasada).
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const modulePath = (relativePath) => path.join(ROOT, relativePath);

const controllerPath = modulePath('src/api/controllers/tutorias.controller.js');
const servicePath = modulePath('src/domain/services/tutoria.service.js');
const repositoryPath = modulePath('src/infrastructure/repositories/tutoria.repository.js');
const usuariosClientPath = modulePath('src/infrastructure/clients/usuarios.client.js');
const agendaClientPath = modulePath('src/infrastructure/clients/agenda.client.js');
const messageProducerPath = modulePath('src/infrastructure/messaging/message.producer.js');

const clearModule = (filePath) => {
    delete require.cache[require.resolve(filePath)];
};

const BODY_VALIDO = {
    idTutor: 'tutor-1',
    fechaSolicitada: '2030-06-24T10:00:00.000Z',
    duracionMinutos: 60,
    materia: 'Física'
};

const createRequest = (bodyOverrides = {}) => ({
    user: { role: 'student', sub: 'student-1' },
    body: { ...BODY_VALIDO, ...bodyOverrides },
    correlationId: 'cid-test',
    header: (name) => (name === 'Idempotency-Key' ? 'idem-validacion' : undefined)
});

const createResponse = () => {
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    return response;
};

const loadControllerNeverReachingService = () => {
    // El servicio no debería ejecutarse en ninguno de estos casos -- si algo lo invoca, el stub
    // revienta el test con un mensaje claro en vez de fallar silenciosamente.
    const noop = () => { throw new Error('tutoriaService.solicitarTutoria no debería llamarse: la validación de forma debería cortar antes.'); };

    for (const filePath of [controllerPath, servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }
    require.cache[require.resolve(repositoryPath)] = { exports: { findByIdempotencyKey: noop, save: noop } };
    require.cache[require.resolve(usuariosClientPath)] = { exports: { getUsuario: noop } };
    require.cache[require.resolve(agendaClientPath)] = { exports: { verificarDisponibilidad: noop, bloquearAgenda: noop, cancelarBloqueo: noop } };
    require.cache[require.resolve(messageProducerPath)] = { exports: { publishToQueue: noop, publishTrackingEvent: noop } };

    return require(controllerPath);
};

const casosInvalidos = [
    { nombre: 'idTutor ausente', overrides: { idTutor: undefined }, mensaje: /idTutor/ },
    { nombre: 'idTutor vacío', overrides: { idTutor: '' }, mensaje: /idTutor/ },
    { nombre: 'materia vacía', overrides: { materia: '' }, mensaje: /materia/ },
    { nombre: 'materia solo espacios', overrides: { materia: '   ' }, mensaje: /materia/ },
    { nombre: 'duracionMinutos ausente', overrides: { duracionMinutos: undefined }, mensaje: /duracionMinutos/ },
    { nombre: 'duracionMinutos cero', overrides: { duracionMinutos: 0 }, mensaje: /duracionMinutos/ },
    { nombre: 'duracionMinutos negativo', overrides: { duracionMinutos: -30 }, mensaje: /duracionMinutos/ },
    { nombre: 'duracionMinutos como string', overrides: { duracionMinutos: '60' }, mensaje: /duracionMinutos/ },
    { nombre: 'fechaSolicitada ausente', overrides: { fechaSolicitada: undefined }, mensaje: /fechaSolicitada/ },
    { nombre: 'fechaSolicitada no parseable', overrides: { fechaSolicitada: 'no-es-una-fecha' }, mensaje: /fechaSolicitada/ }
];

for (const caso of casosInvalidos) {
    test(`postSolicitud rechaza con 400 cuando ${caso.nombre}`, async () => {
        const controller = loadControllerNeverReachingService();
        const req = createRequest(caso.overrides);
        const res = createResponse();
        let nextError;

        await controller.postSolicitud(req, res, (error) => { nextError = error; });

        assert.equal(nextError?.statusCode, 400);
        assert.match(nextError.message, caso.mensaje);
        assert.equal(res.statusCode, null);
    });
}

test('postSolicitud NO rechaza fechaSolicitada en el pasado por forma (esa regla vive en el servicio)', async () => {
    // fecha bien formada pero pasada -- validarSolicitud (form-only, en el controller) no debe
    // rechazarla; el stub del repositorio revienta con un mensaje distinguible apenas se toca, así
    // que si el error capturado es ESE (no el de "fechaSolicitada debe ser válida"), confirma que
    // la validación de forma la dejó pasar y la Saga real siguió de largo.
    const controller = loadControllerNeverReachingService();
    const req = createRequest({ fechaSolicitada: '2020-01-01T00:00:00.000Z' });
    const res = createResponse();
    let nextError;

    await controller.postSolicitud(req, res, (error) => { nextError = error; });

    assert.ok(nextError);
    assert.doesNotMatch(nextError.message, /fechaSolicitada.*ISO 8601/);
});

test('ejecutarSagaSolicitudTutoria (vía solicitarTutoria) rechaza con 400 una fechaSolicitada ya pasada, para una Saga nueva', async () => {
    for (const filePath of [servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }
    require.cache[require.resolve(repositoryPath)] = { exports: { findByIdempotencyKey: async () => null } };
    require.cache[require.resolve(usuariosClientPath)] = {
        exports: { getUsuario: () => { throw new Error('no debería llamarse: la validación de fecha futura corta antes'); } }
    };
    require.cache[require.resolve(agendaClientPath)] = { exports: {} };
    require.cache[require.resolve(messageProducerPath)] = { exports: { publishTrackingEvent: async () => undefined } };

    const tutoriaService = require(servicePath);

    await assert.rejects(
        () => tutoriaService.solicitarTutoria(
            { ...BODY_VALIDO, idEstudiante: 'e1', fechaSolicitada: '2020-01-01T00:00:00.000Z', idempotencyKey: 'idem-fecha-pasada' },
            'cid-fecha-pasada'
        ),
        (error) => {
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /fechaSolicitada.*futura/);
            return true;
        }
    );

    clearModule(servicePath);
});

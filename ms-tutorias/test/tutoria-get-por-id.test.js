// S8: GET /v1/tutorias/:id -- antes no existía forma de consultar el estado de una tutoría ya
// creada. No debe distinguir "no existe" de "no es tuya": ambos casos responden 404.
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

const createRequest = (id, sub = 'student-1') => ({
    params: { id },
    user: { role: 'student', sub },
    header: () => undefined
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

const loadControllerWithFindById = (findByIdImpl) => {
    for (const filePath of [controllerPath, servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }
    require.cache[require.resolve(repositoryPath)] = { exports: { findById: findByIdImpl } };
    require.cache[require.resolve(usuariosClientPath)] = { exports: {} };
    require.cache[require.resolve(agendaClientPath)] = { exports: {} };
    require.cache[require.resolve(messageProducerPath)] = { exports: { publishTrackingEvent: async () => undefined } };

    return require(controllerPath);
};

test('getTutoriaPorId responde 200 con el DTO cuando la tutoría existe y es del estudiante autenticado', async () => {
    const controller = loadControllerWithFindById(async (id) => {
        assert.equal(id, 'tutoria-1');
        return {
            idtutoria: 'tutoria-1',
            idestudiante: 'student-1',
            idtutor: 'tutor-1',
            nombretutor: 'Dra. Elena Solano',
            fecha: '2030-01-01T10:00:00.000Z',
            materia: 'Física',
            estado: 'CONFIRMADA',
            error: null
        };
    });

    const req = createRequest('tutoria-1', 'student-1');
    const res = createResponse();
    let nextError;

    await controller.getTutoriaPorId(req, res, (error) => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
        idTutoria: 'tutoria-1',
        idEstudiante: 'student-1',
        idTutor: 'tutor-1',
        tutorNombre: 'Dra. Elena Solano',
        fecha: '2030-01-01T10:00:00.000Z',
        materia: 'Física',
        estado: 'CONFIRMADA'
    });
});

test('getTutoriaPorId responde 404 cuando la tutoría no existe', async () => {
    const controller = loadControllerWithFindById(async () => null);

    const req = createRequest('tutoria-inexistente');
    const res = createResponse();
    let nextError;

    await controller.getTutoriaPorId(req, res, (error) => { nextError = error; });

    assert.equal(nextError?.statusCode, 404);
    assert.equal(res.statusCode, null);
});

test('getTutoriaPorId responde 404 (no 403) cuando la tutoría existe pero es de otro estudiante', async () => {
    const controller = loadControllerWithFindById(async () => ({
        idtutoria: 'tutoria-ajena',
        idestudiante: 'otro-estudiante',
        estado: 'CONFIRMADA',
        error: null
    }));

    const req = createRequest('tutoria-ajena', 'student-1');
    const res = createResponse();
    let nextError;

    await controller.getTutoriaPorId(req, res, (error) => { nextError = error; });

    assert.equal(nextError?.statusCode, 404);
    assert.equal(res.statusCode, null);
});

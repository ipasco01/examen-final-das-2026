// GET /v1/tutorias -- listado de "mis tutorías" del estudiante autenticado. Pedido explícito tras
// agregar getTutoriaPorId (S8): consultar una por id es poco útil desde un cliente si primero no
// sabés el id.
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

const createRequest = (sub = 'student-1') => ({
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

const loadControllerWithFindByEstudiante = (findByEstudianteImpl) => {
    for (const filePath of [controllerPath, servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }
    require.cache[require.resolve(repositoryPath)] = { exports: { findByEstudiante: findByEstudianteImpl } };
    require.cache[require.resolve(usuariosClientPath)] = { exports: {} };
    require.cache[require.resolve(agendaClientPath)] = { exports: {} };
    require.cache[require.resolve(messageProducerPath)] = { exports: { publishTrackingEvent: async () => undefined } };

    return require(controllerPath);
};

test('getTutoriasDelEstudiante responde 200 con el listado mapeado al DTO, la más reciente primero', async () => {
    const controller = loadControllerWithFindByEstudiante(async (idEstudiante) => {
        assert.equal(idEstudiante, 'student-1');
        return [
            {
                idtutoria: 'tutoria-2', idestudiante: 'student-1', idtutor: 'tutor-2', nombretutor: 'Tutor Dos',
                fecha: '2030-02-01T10:00:00.000Z', materia: 'Química', estado: 'PENDIENTE', error: null
            },
            {
                idtutoria: 'tutoria-1', idestudiante: 'student-1', idtutor: 'tutor-1', nombretutor: null,
                fecha: '2030-01-01T10:00:00.000Z', materia: 'Física', estado: 'FALLIDA', error: 'Horario no disponible'
            }
        ];
    });

    const req = createRequest('student-1');
    const res = createResponse();
    let nextError;

    await controller.getTutoriasDelEstudiante(req, res, (error) => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 2);
    assert.deepEqual(res.body[0], {
        idTutoria: 'tutoria-2', idEstudiante: 'student-1', idTutor: 'tutor-2', tutorNombre: 'Tutor Dos',
        fecha: '2030-02-01T10:00:00.000Z', materia: 'Química', estado: 'PENDIENTE'
    });
    assert.deepEqual(res.body[1], {
        idTutoria: 'tutoria-1', idEstudiante: 'student-1', idTutor: 'tutor-1', tutorNombre: null,
        fecha: '2030-01-01T10:00:00.000Z', materia: 'Física', estado: 'FALLIDA',
        motivoFallo: 'Horario no disponible'
    });
});

test('getTutoriasDelEstudiante responde 200 con un array vacío si el estudiante no tiene tutorías', async () => {
    const controller = loadControllerWithFindByEstudiante(async () => []);

    const req = createRequest('student-sin-tutorias');
    const res = createResponse();
    let nextError;

    await controller.getTutoriasDelEstudiante(req, res, (error) => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, []);
});

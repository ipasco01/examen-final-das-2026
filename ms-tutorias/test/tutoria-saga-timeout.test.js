// S1: la Saga debe rechazar con 504 si se cuelga más allá de SAGA_TIMEOUT_MS, en vez de dejar el
// request esperando indefinidamente.
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

test('solicitarTutoria rechaza con 504 si la Saga interna se cuelga más de SAGA_TIMEOUT_MS', async () => {
    const originalTimeout = process.env.SAGA_TIMEOUT_MS;
    process.env.SAGA_TIMEOUT_MS = '50';

    const repository = { findByIdempotencyKey: async () => null };
    // Nunca resuelve ni rechaza -- simula un colgado real (ej. lock de Postgres contendido sin timeout).
    const usuariosClient = { getUsuario: () => new Promise(() => {}) };
    const agendaClient = {
        verificarDisponibilidad: async () => true,
        bloquearAgenda: async () => ({ idBloqueo: 'no-debería-llegar-aquí' }),
        cancelarBloqueo: async () => undefined
    };
    const messageProducer = {
        publishToQueue: async () => true,
        publishTrackingEvent: async () => undefined
    };

    for (const filePath of [servicePath, repositoryPath, usuariosClientPath, agendaClientPath, messageProducerPath]) {
        clearModule(filePath);
    }
    require.cache[require.resolve(repositoryPath)] = { exports: repository };
    require.cache[require.resolve(usuariosClientPath)] = { exports: usuariosClient };
    require.cache[require.resolve(agendaClientPath)] = { exports: agendaClient };
    require.cache[require.resolve(messageProducerPath)] = { exports: messageProducer };

    const tutoriaService = require(servicePath);

    try {
        await assert.rejects(
            () => tutoriaService.solicitarTutoria(
                {
                    idEstudiante: 'e1',
                    idTutor: 't1',
                    fechaSolicitada: '2026-08-01T10:00:00.000Z',
                    duracionMinutos: 60,
                    materia: 'Física',
                    idempotencyKey: 'idem-timeout'
                },
                'cid-timeout'
            ),
            (error) => {
                assert.equal(error.statusCode, 504);
                assert.match(error.message, /tiempo máximo de procesamiento/);
                return true;
            }
        );
    } finally {
        if (originalTimeout === undefined) {
            delete process.env.SAGA_TIMEOUT_MS;
        } else {
            process.env.SAGA_TIMEOUT_MS = originalTimeout;
        }
        clearModule(servicePath);
    }
});

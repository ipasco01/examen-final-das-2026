// ms-tutorias/src/infrastructure/messaging/outbox.publisher.js
//
// Poller del patrón outbox (D2): lee filas pendientes de tutorias_notificaciones_outbox y las
// publica en notificaciones_email_queue, la misma cola/contrato de siempre -- ms-notificaciones no
// cambia. Reemplaza la publicación directa y fire-and-forget que hacía tutoria.service.js.
const db = require('../../config/db');
const messageProducer = require('./message.producer');
const outboxRepository = require('../repositories/outbox.repository');
const { outboxPublicacionTotal } = require('../observability/outbox.metrics');

const NOTIFICACIONES_QUEUE = 'notificaciones_email_queue';
const OUTBOX_MAX_INTENTOS = Number(process.env.OUTBOX_MAX_INTENTOS || 5);
const OUTBOX_POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS || 3000);
const OUTBOX_BATCH_LIMIT = Number(process.env.OUTBOX_BATCH_LIMIT || 20);

// Guard en memoria: si un tick tarda más que el intervalo (DB o RabbitMQ lentos), el siguiente
// tick de setInterval se salta en vez de solaparse -- el SKIP LOCKED del reclamo ya protege contra
// duplicados entre instancias, pero esto evita además reintentos innecesarios en el mismo proceso.
let isRunning = false;

const runOnce = async ({ limit = OUTBOX_BATCH_LIMIT } = {}) => {
    if (isRunning) {
        return { procesados: 0, omitido: true };
    }
    isRunning = true;

    try {
        // S6: pool reservado para workers de fondo, separado del que atiende el tráfico HTTP.
        return await db.withWorkerTransaction(async (client) => {
            const pendientes = await outboxRepository.reclamarPendientes(client, limit);

            let publicados = 0;
            let fallidos = 0;

            for (const fila of pendientes) {
                const publicoOk = await messageProducer.publishToQueue(NOTIFICACIONES_QUEUE, fila.payload);

                if (publicoOk) {
                    await outboxRepository.marcarPublicado(client, fila.idoutbox);
                    outboxPublicacionTotal.inc({ resultado: 'publicado' });
                    publicados += 1;
                } else {
                    await outboxRepository.registrarIntentoFallido(
                        client,
                        fila.idoutbox,
                        fila.intentos,
                        'publishToQueue devolvió false (canal RabbitMQ no disponible o error al publicar)',
                        OUTBOX_MAX_INTENTOS
                    );
                    outboxPublicacionTotal.inc({ resultado: 'fallido' });
                    fallidos += 1;
                }
            }

            return { procesados: pendientes.length, publicados, fallidos };
        });
    } finally {
        isRunning = false;
    }
};

let intervalHandle = null;

const start = () => {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
        runOnce().catch((err) => console.error('[OutboxPublisher] Error en runOnce:', err.stack));
    }, OUTBOX_POLL_INTERVAL_MS);
};

const stop = () => {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
};

module.exports = { runOnce, start, stop };

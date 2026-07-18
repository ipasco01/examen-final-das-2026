// ms-tutorias/src/infrastructure/workers/reconciliacion.worker.js
//
// Worker de reconciliación (S2): a diferencia del outbox y de compensaciones_pendientes, la tabla
// tutorias no tenía ningún proceso que detectara filas PENDIENTE huérfanas -- si el proceso muere
// entre el INSERT PENDIENTE y el resto de la Saga, la fila quedaba en PENDIENTE para siempre (y
// bloqueaba además cualquier reintento con la misma Idempotency-Key, porque el short-circuit de
// idempotencia devuelve la fila tal cual esté, incluso en PENDIENTE).
//
// Limitación conocida, importante: esta tabla no persiste idBloqueo (solo vive en memoria durante
// la ejecución de la Saga), así que este worker NO puede saber si bloquearAgenda llegó a
// completarse antes del crash ni compensarlo automáticamente -- solo cierra el lado de `tutorias`
// (PENDIENTE -> FALLIDA) y deja un evento de tracking explícito pidiendo verificación manual del
// horario en ms-agenda. Un fix completo de ese lado requeriría persistir idBloqueo en `tutorias`,
// fuera de alcance de este cambio.
const tutoriaRepository = require('../repositories/tutoria.repository');
const { publishTrackingEvent } = require('../messaging/message.producer');

const RECONCILIACION_PENDIENTE_UMBRAL_MS = Number(process.env.RECONCILIACION_PENDIENTE_UMBRAL_MS || 5 * 60 * 1000);
const RECONCILIACION_POLL_INTERVAL_MS = Number(process.env.RECONCILIACION_POLL_INTERVAL_MS || 60 * 1000);
const RECONCILIACION_BATCH_LIMIT = Number(process.env.RECONCILIACION_BATCH_LIMIT || 20);

let isRunning = false;

const runOnce = async ({ limit = RECONCILIACION_BATCH_LIMIT, umbralMs = RECONCILIACION_PENDIENTE_UMBRAL_MS } = {}) => {
    if (isRunning) {
        return { procesados: 0, omitido: true };
    }
    isRunning = true;

    try {
        const fechaCorte = new Date(Date.now() - umbralMs);
        const filas = await tutoriaRepository.reconciliarPendientesViejas(fechaCorte, limit);

        for (const fila of filas) {
            await publishTrackingEvent({
                service: 'MS_Tutorias',
                message: `Reconciliación: tutoría ${fila.idtutoria} (tutor ${fila.idtutor}) quedó PENDIENTE por más de ${umbralMs}ms sin completar la Saga -- marcada FALLIDA. Verificar manualmente si el horario quedó bloqueado en ms-agenda.`,
                cid: fila.idempotencykey || null,
                timestamp: new Date(),
                status: 'ERROR'
            });
        }

        return { procesados: filas.length };
    } finally {
        isRunning = false;
    }
};

let intervalHandle = null;

const start = () => {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
        runOnce().catch((err) => console.error('[ReconciliacionWorker] Error en runOnce:', err.stack));
    }, RECONCILIACION_POLL_INTERVAL_MS);
};

const stop = () => {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
};

module.exports = { runOnce, start, stop };

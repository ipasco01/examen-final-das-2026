// ms-tutorias/src/infrastructure/workers/compensacion.worker.js
//
// Worker de reintentos en segundo plano para compensaciones de agenda que agotaron sus intentos
// síncronos (D6, etapa 2 de la deuda técnica de compensación). Reintenta agendaClient.cancelarBloqueo
// -- una llamada HTTP, no RabbitMQ, por eso vive en infrastructure/workers/ y no en
// infrastructure/messaging/ junto a outbox.publisher.js.
const jwt = require('jsonwebtoken');
const db = require('../../config/db');
const agendaClient = require('../clients/agenda.client');
const compensacionRepository = require('../repositories/compensacion.repository');
const { compensacionFallidaTotal } = require('../observability/compensacion.metrics');
const config = require('../../config');

const COMPENSACION_PENDIENTE_MAX_INTENTOS = Number(process.env.COMPENSACION_PENDIENTE_MAX_INTENTOS || 3);
const COMPENSACION_PENDIENTE_POLL_INTERVAL_MS = Number(process.env.COMPENSACION_PENDIENTE_POLL_INTERVAL_MS || 5000);
const COMPENSACION_PENDIENTE_BATCH_LIMIT = Number(process.env.COMPENSACION_PENDIENTE_BATCH_LIMIT || 20);

// El worker corre en background, sin ninguna request de usuario de la que reenviar un token, así
// que firma su propio JWT de corta duración con el mismo secreto compartido para autenticarse
// contra ms-agenda (ver A1 del hallazgo de seguridad).
const getServiceAuthHeader = () => {
    const token = jwt.sign({ sub: 'ms-tutorias', role: 'service' }, config.jwtSecret, { expiresIn: '1m' });
    return `Bearer ${token}`;
};

// Guard en memoria: si un tick tarda más que el intervalo, el siguiente se salta en vez de
// solaparse -- el SKIP LOCKED del reclamo ya protege contra duplicados entre instancias.
let isRunning = false;

const runOnce = async ({ limit = COMPENSACION_PENDIENTE_BATCH_LIMIT } = {}) => {
    if (isRunning) {
        return { procesados: 0, omitido: true };
    }
    isRunning = true;

    try {
        // S6: pool reservado para workers de fondo, separado del que atiende el tráfico HTTP.
        return await db.withWorkerTransaction(async (client) => {
            const pendientes = await compensacionRepository.reclamarPendientes(client, limit);

            let resueltos = 0;
            let fallidos = 0;

            for (const fila of pendientes) {
                try {
                    await agendaClient.cancelarBloqueo(fila.idbloqueo, fila.correlationid, getServiceAuthHeader());
                    await compensacionRepository.marcarResuelto(client, fila.idcompensacion);
                    resueltos += 1;
                } catch (err) {
                    const { nuevoEstado } = await compensacionRepository.registrarIntentoFallido(
                        client,
                        fila.idcompensacion,
                        fila.intentos,
                        err.message,
                        COMPENSACION_PENDIENTE_MAX_INTENTOS
                    );
                    if (nuevoEstado === 'FALLIDO') {
                        // Ni el retry en segundo plano lo resolvió: requiere intervención manual.
                        compensacionFallidaTotal.inc({ etapa: 'worker' });
                    }
                    fallidos += 1;
                }
            }

            return { procesados: pendientes.length, resueltos, fallidos };
        });
    } finally {
        isRunning = false;
    }
};

let intervalHandle = null;

const start = () => {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
        runOnce().catch((err) => console.error('[CompensacionWorker] Error en runOnce:', err.stack));
    }, COMPENSACION_PENDIENTE_POLL_INTERVAL_MS);
};

const stop = () => {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
};

module.exports = { runOnce, start, stop };

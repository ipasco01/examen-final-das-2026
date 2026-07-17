// ms-tutorias/scripts/reintentar-fallidos.js
//
// Comando de operación (R3): reabre filas FALLIDO de tutorias_notificaciones_outbox y/o
// compensaciones_pendientes para que el poller/worker correspondiente las vuelva a intentar en su
// próximo tick. Antes de esto, la única forma de recuperar una fila FALLIDO era escribir el UPDATE
// a mano contra Postgres.
//
// Uso:
//   node scripts/reintentar-fallidos.js --outbox                 # todas las FALLIDO de outbox
//   node scripts/reintentar-fallidos.js --outbox id1 id2         # solo esos idOutbox
//   node scripts/reintentar-fallidos.js --compensaciones         # todas las FALLIDO de compensación
//   node scripts/reintentar-fallidos.js --compensaciones id1     # solo esos idCompensacion
//   node scripts/reintentar-fallidos.js --outbox --compensaciones  # ambas tablas
require('dotenv').config();
const db = require('../src/config/db');
const outboxRepository = require('../src/infrastructure/repositories/outbox.repository');
const compensacionRepository = require('../src/infrastructure/repositories/compensacion.repository');

const parseArgs = (argv) => {
    const flags = { outbox: false, compensaciones: false, ids: [] };
    for (const arg of argv) {
        if (arg === '--outbox') flags.outbox = true;
        else if (arg === '--compensaciones') flags.compensaciones = true;
        else flags.ids.push(arg);
    }
    return flags;
};

const main = async () => {
    const { outbox, compensaciones, ids } = parseArgs(process.argv.slice(2));

    if (!outbox && !compensaciones) {
        console.error('Uso: node scripts/reintentar-fallidos.js --outbox|--compensaciones [ids...]');
        process.exitCode = 1;
        return;
    }

    if (outbox) {
        const filas = await outboxRepository.reencolarFallidos(db, ids);
        console.log(`[reintentar-fallidos] outbox: ${filas.length} fila(s) reabiertas a PENDIENTE.`, filas.map((f) => f.idoutbox));
    }

    if (compensaciones) {
        const filas = await compensacionRepository.reencolarFallidos(db, ids);
        console.log(`[reintentar-fallidos] compensaciones_pendientes: ${filas.length} fila(s) reabiertas a PENDIENTE.`, filas.map((f) => f.idcompensacion));
    }
};

main()
    .catch((err) => {
        console.error('[reintentar-fallidos] Error:', err.stack);
        process.exitCode = 1;
    })
    .finally(() => db.pool.end());

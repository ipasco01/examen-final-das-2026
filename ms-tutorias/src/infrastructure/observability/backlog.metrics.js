// ms-tutorias/src/infrastructure/observability/backlog.metrics.js
//
// S7: sin esto, un backlog que crece lentamente (ej. tras una caída prolongada de Postgres) es
// indistinguible de estado estable en los logs actuales -- ninguna métrica exponía cuántas filas
// seguían PENDIENTE. Un Gauge con `collect()` async consulta la tabla recién cuando Prometheus
// scrapea GET /metrics (prom-client >=14 soporta collect async) -- no hace falta un poller propio
// ni tocar app.js para que se registre, mismo mecanismo que compensacion.metrics.js.
const client = require('prom-client');
const db = require('../../config/db');

const contarPendientes = async (tabla) => {
    // Ambas tablas tienen un índice sobre `estado` (idx_outbox_estado,
    // idx_compensaciones_pendientes_estado) -- el COUNT usa el índice, no hace un seq scan.
    const res = await db.workerQuery(`SELECT COUNT(*)::int AS total FROM ${tabla} WHERE estado = 'PENDIENTE'`);
    return res.rows[0].total;
};

const outboxBacklog = new client.Gauge({
    name: 'outbox_notificaciones_backlog',
    help: 'Filas PENDIENTE en tutorias_notificaciones_outbox al momento del scrape',
    async collect() {
        this.set(await contarPendientes('tutorias_notificaciones_outbox'));
    }
});

const compensacionesPendientesBacklog = new client.Gauge({
    name: 'compensaciones_pendientes_backlog',
    help: 'Filas PENDIENTE en compensaciones_pendientes al momento del scrape',
    async collect() {
        this.set(await contarPendientes('compensaciones_pendientes'));
    }
});

module.exports = { outboxBacklog, compensacionesPendientesBacklog };

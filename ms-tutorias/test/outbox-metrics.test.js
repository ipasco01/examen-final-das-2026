// S7: métricas de backlog para outbox y compensaciones_pendientes, más el contador de
// éxito/fallo del poller de outbox (antes no existía ninguna métrica para el outbox).
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dbPath = require.resolve(path.join(ROOT, 'src/config/db'));
const backlogMetricsPath = path.join(ROOT, 'src/infrastructure/observability/backlog.metrics.js');
const outboxMetricsPath = path.join(ROOT, 'src/infrastructure/observability/outbox.metrics.js');

let queryImpl = async () => ({ rows: [{ total: 0 }] });

// Los gauges de backlog consultan Postgres real vía db.workerQuery -- se stubbea el mismo patrón
// que el resto de la suite en vez de depender de una base real corriendo durante los tests.
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { workerQuery: (text, params) => queryImpl(text, params) }
};

delete require.cache[require.resolve(backlogMetricsPath)];
const { outboxBacklog, compensacionesPendientesBacklog } = require(backlogMetricsPath);
const { outboxPublicacionTotal } = require(outboxMetricsPath);

test('outboxBacklog.collect() consulta tutorias_notificaciones_outbox y setea el gauge', async () => {
    let queryText;
    queryImpl = async (text) => { queryText = text; return { rows: [{ total: 7 }] }; };

    await outboxBacklog.collect();

    assert.match(queryText, /tutorias_notificaciones_outbox/);
    assert.match(queryText, /estado = 'PENDIENTE'/);
    const valor = await outboxBacklog.get();
    assert.equal(valor.values[0].value, 7);
});

test('compensacionesPendientesBacklog.collect() consulta compensaciones_pendientes y setea el gauge', async () => {
    let queryText;
    queryImpl = async (text) => { queryText = text; return { rows: [{ total: 3 }] }; };

    await compensacionesPendientesBacklog.collect();

    assert.match(queryText, /compensaciones_pendientes/);
    assert.match(queryText, /estado = 'PENDIENTE'/);
    const valor = await compensacionesPendientesBacklog.get();
    assert.equal(valor.values[0].value, 3);
});

test('outbox_publicacion_total se registra y se incrementa por label "resultado"', async () => {
    outboxPublicacionTotal.reset();

    outboxPublicacionTotal.inc({ resultado: 'publicado' });
    outboxPublicacionTotal.inc({ resultado: 'publicado' });
    outboxPublicacionTotal.inc({ resultado: 'fallido' });

    const valor = await outboxPublicacionTotal.get();
    const publicado = valor.values.find((v) => v.labels.resultado === 'publicado');
    const fallido = valor.values.find((v) => v.labels.resultado === 'fallido');

    assert.equal(publicado.value, 2);
    assert.equal(fallido.value, 1);
});

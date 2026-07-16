const assert = require('node:assert/strict');
const test = require('node:test');
const client = require('prom-client');

const { compensacionFallidaTotal } = require('../src/infrastructure/observability/compensacion.metrics');

test('compensacion_fallida_total se registra en el registro global de prom-client', async () => {
    const metricasTexto = await client.register.metrics();
    assert.match(metricasTexto, /# HELP compensacion_fallida_total/);
    assert.match(metricasTexto, /# TYPE compensacion_fallida_total counter/);
});

test('compensacion_fallida_total incrementa por label "etapa"', async () => {
    compensacionFallidaTotal.reset();

    compensacionFallidaTotal.inc({ etapa: 'sincrona' });
    compensacionFallidaTotal.inc({ etapa: 'sincrona' });
    compensacionFallidaTotal.inc({ etapa: 'worker' });

    const valorSincrona = await compensacionFallidaTotal.get();
    const sincrona = valorSincrona.values.find((v) => v.labels.etapa === 'sincrona');
    const worker = valorSincrona.values.find((v) => v.labels.etapa === 'worker');

    assert.equal(sincrona.value, 2);
    assert.equal(worker.value, 1);
});

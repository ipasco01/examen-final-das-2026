// ms-tutorias/src/infrastructure/observability/compensacion.metrics.js
//
// Métrica de negocio para compensaciones de agenda fallidas (Etapa 1 de la deuda técnica de
// compensación). express-prom-bundle usa el registro global de prom-client para exponer
// GET /metrics; un Counter construido con `new client.Counter({...})` se auto-registra ahí, así
// que no hace falta tocar app.js para que aparezca en el scrape de Prometheus.
const client = require('prom-client');

const compensacionFallidaTotal = new client.Counter({
    name: 'compensacion_fallida_total',
    help: 'Compensaciones de agenda (cancelarBloqueo) que agotaron sus reintentos',
    // 'sincrona': el loop de reintentos dentro del propio request (tutoria.service.js) se agotó.
    // 'worker': el worker en segundo plano (compensacion.worker.js) también agotó sus reintentos.
    // 'cancelacion': el loop de reintentos al liberar el horario en cancelarTutoria se agotó.
    labelNames: ['etapa']
});

module.exports = { compensacionFallidaTotal };

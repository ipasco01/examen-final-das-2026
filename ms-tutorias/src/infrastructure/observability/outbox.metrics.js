// ms-tutorias/src/infrastructure/observability/outbox.metrics.js
//
// S7: a diferencia de compensacion_fallida_total (compensacion.metrics.js), el poller de outbox
// no tenía ninguna métrica -- ni de éxito ni de fallo. Mismo mecanismo: un Counter construido con
// `new client.Counter({...})` se auto-registra en el registro global de prom-client, expuesto por
// express-prom-bundle en GET /metrics sin tocar app.js.
const client = require('prom-client');

const outboxPublicacionTotal = new client.Counter({
    name: 'outbox_publicacion_total',
    help: 'Resultados de publicación del poller de outbox de notificaciones',
    // 'publicado': el broker confirmó el mensaje (ver publisher confirms en message.producer.js).
    // 'fallido': la publicación falló en este intento (puede reintentarse en el próximo tick).
    labelNames: ['resultado']
});

module.exports = { outboxPublicacionTotal };

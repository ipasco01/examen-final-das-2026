// src/observability/rabbitmq-propagation.js
//
// La auto-instrumentación de OpenTelemetry propaga el trace_id solo entre HTTP/gRPC
// (vía headers 'traceparent', estándar W3C). RabbitMQ no es request/response, así que
// aquí sí hace falta código manual: inyectar el contexto de traza en las propiedades
// del mensaje al publicar, y extraerlo al consumir.

const { context, propagation, trace } = require('@opentelemetry/api');

// Llamar justo antes de channel.publish(...) / channel.sendToQueue(...).
// Devuelve un objeto 'headers' con el trace_id activo (el del request HTTP que disparó
// la publicación) codificado como header AMQP estándar 'traceparent'.
function injectTraceContext(extraHeaders = {}) {
    const headers = { ...extraHeaders };
    propagation.inject(context.active(), headers);
    return headers;
}

// Llamar dentro del handler de channel.consume(queueName, async (msg) => { ... }).
// Envuelve 'fn' para que se ejecute "dentro" del contexto de traza que venía en msg.properties.headers,
// de modo que cualquier span que se cree en 'fn' (automático o manual) aparezca como hijo de la
// traza original de ms-tutorias, y no como una traza nueva y desconectada.
function runWithExtractedContext(msg, fn) {
    const headers = msg?.properties?.headers || {};
    const parentContext = propagation.extract(context.active(), headers);
    return context.with(parentContext, fn);
}

module.exports = { injectTraceContext, runWithExtractedContext };

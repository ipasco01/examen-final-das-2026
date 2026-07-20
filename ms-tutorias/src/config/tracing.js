// src/config/tracing.js
//
// Arranca el SDK de OpenTelemetry ANTES que cualquier otro módulo del servicio.
// Por eso se carga con `node -r ./src/config/tracing.js src/app.js` (ver CMD en el
// Dockerfile) y no con un simple require() dentro de app.js: la auto-instrumentación
// necesita "parchar" (monkey-patch) los módulos de Node (http, express, pg, amqplib...)
// antes de que app.js los importe.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'unknown-service';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs genera un span por cada lectura de archivo (incluso los del propio Node al
      // arrancar) -- sería puro ruido en las trazas, no aporta nada a "qué pasó entre
      // microservicios".
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Apagado ordenado: si no se hace flush antes de salir, los últimos spans generados justo
// antes de un redeploy/reinicio se pierden (quedan en el buffer del exporter, nunca llegan
// al Collector).
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log(`[${serviceName}] OpenTelemetry SDK apagado correctamente`))
    .catch((err) => console.error(`[${serviceName}] Error apagando OpenTelemetry SDK`, err))
    .finally(() => process.exit(0));
});

module.exports = sdk;

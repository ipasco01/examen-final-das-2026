// ms-notificaciones/src/app.js
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const notificacionesRouter = require('./api/routes/notificaciones.routes');
const errorHandler = require('./api/middlewares/errorHandler'); // Reutilizamos el mismo middleware
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');
const requestLogger = require('./api/middlewares/requestLogger.js');
const amqp = require('amqplib');
const notificacionService = require('./domain/services/notificacion.service'); //  Importar el servicio de notificaciones
const messageProducer = require('./infrastructure/messaging/message.producer'); // <-- IMPORTAR PRODUCTOR
const promBundle = require("express-prom-bundle");
const { trace } = require('@opentelemetry/api');
const { runWithExtractedContext } = require('./config/rabbitmq-propagation');

const RABBITMQ_RETRY_DELAY_MS = 5000;

// David: SE AGREGA. Cuántas veces se reintenta un mensaje antes de darlo
// por perdido y mandarlo a la DLQ. Es una variable de entorno (no un
// número fijo en el código) para poder ajustarla sin tener que redesplegar,
// igual que hicieron en tutoria.service.js con COMPENSACION_AGENDA_MAX_INTENTOS.
const MAX_REINTENTOS = Number(process.env.NOTIFICACIONES_MAX_REINTENTOS || 3);


const app = express();

// --- Equipo 5 (20/07), deuda #2: endpoint /health propio ---
//
// VA ANTES DE TODO LO DEMAS, Y ESO ES EL PUNTO. Se registra por encima del rateLimit y del
// middleware de metricas, asi que no lo afecta ninguno de los dos.
//
// POR QUE EXISTE. Hasta hoy las probes de Kubernetes apuntaban a /metrics, y eso fallo por dos
// causas independientes, las dos comprobadas ejecutando:
//
//   1. RATE LIMIT (hallazgo #19). El limitador permite 100 peticiones cada 15 min por IP. Las
//      probes de un solo pod hacen 150: readiness cada 10s (90) + liveness cada 15s (60). A los
//      ~10 minutos el kubelet empieza a recibir 429, la probe lo cuenta como fallo y Kubernetes
//      reinicia el pod. Evidencia:
//        Liveness probe failed: HTTP probe failed with statuscode: 429
//      Los 5 microservicios reiniciaban cada ~10 minutos por esto.
//
//   2. ACOPLAMIENTO CON LA BASE (hallazgo #17). El Equipo 4 agrego Gauges con collect() que
//      consultan Postgres al pedir /metrics. Cuando falto una tabla, /metrics devolvio 500, la
//      liveness fallo y Kubernetes mato pods de aplicacion sanos. Un problema de la capa de datos
//      derribando la de computo.
//
// QUE VERIFICA Y QUE NO -- deliberadamente NO consulta la base ni el broker.
// Una liveness probe responde "¿hay que reiniciar este proceso?". Reiniciar el pod no arregla una
// base caida: solo agrega un pod menos a un sistema ya degradado. Si manana se quiere una probe
// que SI mire dependencias, va en un endpoint aparte (/ready) y solo para readiness, nunca para
// liveness.
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.use(helmet());
app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    includeUp: true,
    customLabels: { project_name: 'tutorias_app', service_name: process.env.SERVICE_NAME || 'unknown_service' },
    promClient: {
        collectDefaultMetrics: {
        }
    }
});
app.use(metricsMiddleware);

app.use(express.json());
app.use(correlationIdMiddleware); // Middleware para manejar el Correlation ID
app.use(requestLogger);
app.use('/notificaciones', notificacionesRouter);

app.use(errorHandler);

// --- Lógica del Consumidor de RabbitMQ ---
const startConsumer = async () => {
    let connection;
    try {
        connection = await amqp.connect(config.rabbitmqUrl);
        const channel = await connection.createChannel();

        const queueName = 'notificaciones_email_queue';
        const dlxName = 'notificaciones_dlx';
        const dlqName = 'notificaciones_dlq';

        await channel.assertExchange(dlxName, 'direct', { durable: true });
        await channel.assertQueue(dlqName, { durable: true });
        await channel.bindQueue(dlqName, dlxName, dlqName);
        await channel.assertQueue(queueName, {
            durable: true,
            deadLetterExchange: dlxName,
            deadLetterRoutingKey: dlqName
        });

        // prefetch(1) asegura que el worker solo tome 1 mensaje a la vez.
        // No tomará el siguiente hasta que haga 'ack' (acuse) del actual.
        channel.prefetch(1);

        console.log(`[MS_Notificaciones] Esperando mensajes en la cola: ${queueName}`);
        console.log(`[MS_Notificaciones] DLQ configurada: ${queueName} -> ${dlxName} -> ${dlqName}`);

        const tracer = trace.getTracer('ms-notificaciones');

        channel.consume(queueName, async (msg) => {
            if (msg !== null) {
                // runWithExtractedContext reconecta este mensaje con el trace_id que venía en
                // msg.properties.headers (inyectado por ms-tutorias al publicar). Sin esto, todo
                // lo que pase acá adentro arrancaría una traza nueva y desconectada en Tempo.
                await runWithExtractedContext(msg, () => tracer.startActiveSpan(
                    'procesar notificacion.email',
                    async (span) => {
                        let payload;
                        try {
                            // 1. Parsear el mensaje
                            payload = JSON.parse(msg.content.toString());
                            console.log(`[MS_Notificaciones] Mensaje recibido de RabbitMQ:`, JSON.stringify(payload));

                            // 2. Procesar el mensaje usando nuestro servicio
                            await notificacionService.enviarEmailNotificacion(payload);

                            // 3. Confirmar (ack) que el mensaje fue procesado exitosamente
                            channel.ack(msg);
                            console.log(`[MS_Notificaciones] Mensaje procesado y confirmado (ack).`);

                        } catch (error) {
                            const rawMessage = msg.content.toString();
                            console.error(`[MS_Notificaciones] Error al procesar mensaje: ${error.message}`, payload || rawMessage);
                            span.recordException(error);


                            const esErrorDeValidacion = error.statusCode === 400;
                            const reintentosPrevios =
                                (msg.properties.headers && msg.properties.headers['x-reintentos']) || 0;

                            if (esErrorDeValidacion || reintentosPrevios >= MAX_REINTENTOS) {
                                channel.nack(msg, false, false);
                                console.log(
                                    `[MS_Notificaciones] Mensaje descartado a DLQ (${dlqName}). ` +
                                    `Motivo: ${esErrorDeValidacion ? 'error de validación' : 'reintentos agotados'} ` +
                                    `(reintentos previos: ${reintentosPrevios}).`
                                );
                            } else {
                                // David: confirmamos (ack) el mensaje viejo y publicamos
                                // uno NUEVO con el contador de reintentos incrementado.
                                // No es "reenviar la misma carta" -- es "escribir la
                                // misma carta de nuevo, pero anotando en la esquina
                                // 'este es el intento número 2'".
                                //
                                // Ojo: se parte de los headers ORIGINALES (msg.properties.headers)
                                // en vez de crear un objeto nuevo desde cero -- así el 'traceparent'
                                // inyectado por ms-tutorias sobrevive a los reintentos, y no se
                                // "corta" la traza en Tempo cada vez que un mensaje se reencola.
                                channel.ack(msg);
                                channel.sendToQueue(queueName, msg.content, {
                                    persistent: true,
                                    headers: {
                                        ...(msg.properties.headers || {}),
                                        'x-reintentos': reintentosPrevios + 1
                                    }
                                });
                                console.log(
                                    `[MS_Notificaciones] Mensaje reencolado para reintento ` +
                                    `${reintentosPrevios + 1}/${MAX_REINTENTOS}.`
                                );
                            }
                        } finally {
                            span.end();
                        }
                    }
                ));
            }
        }, { noAck: false });
    
    
        // Consumidor de la DLQ (ya resuelto en una iteración anterior).
        channel.consume(dlqName, (msg) => {
            if (msg !== null) {
                const rawMessage = msg.content.toString();
                let payload;
                try {
                    payload = JSON.parse(rawMessage);
                } catch {
                    payload = null;
                }

                const cid = payload?.correlationId || 'N/A';

                console.error(
                    `[MS_Notificaciones][DLQ] Mensaje en dead-letter (${dlqName}). CID: ${cid}`,
                    payload || rawMessage
                );

                messageProducer.track(
                    cid,
                    `Mensaje enviado a DLQ (${dlqName}): requiere revisión manual`,
                    'ERROR'
                );

                channel.ack(msg);
            }
        }, {
            noAck: false
        });

    } catch (error) {
        console.error('[MS_Notificaciones] Error al conectar/consumir de RabbitMQ:', error.message);
        setTimeout(startConsumer, RABBITMQ_RETRY_DELAY_MS);
    }
};



if (require.main === module) {
    // Iniciar el servidor y el consumidor de RabbitMQ
    app.listen(config.port, () => {
        console.log(`MS_Notificaciones (API) escuchando en el puerto ${config.port}`);
        startConsumer();
        messageProducer.connect(); // <-- INICIAR CONEXIÓN DEL PRODUCTOR
    });
}

module.exports = app;

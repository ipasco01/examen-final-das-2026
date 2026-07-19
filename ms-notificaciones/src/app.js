// ms-notificaciones/src/app.js
const express = require('express');
const config = require('./config');
const notificacionesRouter = require('./api/routes/notificaciones.routes');
const errorHandler = require('./api/middlewares/errorHandler'); // Reutilizamos el mismo middleware
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');
const requestLogger = require('./api/middlewares/requestLogger.js');
const amqp = require('amqplib');
const notificacionService = require('./domain/services/notificacion.service'); //  Importar el servicio de notificaciones
const messageProducer = require('./infrastructure/messaging/message.producer'); // <-- IMPORTAR PRODUCTOR
const promBundle = require("express-prom-bundle");

const RABBITMQ_RETRY_DELAY_MS = 5000;

const app = express();

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

        channel.consume(queueName, async (msg) => {
            if (msg !== null) {
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
                    // 4. Rechazar (nack) el mensaje. false = no volver a encolar.
                    // RabbitMQ lo enviará a la DLQ configurada en la cola principal.
                    channel.nack(msg, false, false);
                    console.log(`[MS_Notificaciones] Mensaje rechazado (nack) y enviado a DLQ: ${dlqName}.`);
                }
            }
        }, {
            noAck: false // Importante: Requerimos confirmación manual (ack/nack)
        });

    } catch (error) {
        console.error('[MS_Notificaciones] Error al conectar/consumir de RabbitMQ:', error.message);
        setTimeout(startConsumer, RABBITMQ_RETRY_DELAY_MS); // Reintentar conexión en 5 segundos
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

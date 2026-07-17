// ms-tutorias/src/infrastructure/messaging/message.producer.js
const amqp = require('amqplib');
const { rabbitmqUrl } = require('../../config');

let connection = null;
let channel = null;
const EXCHANGE_NAME = 'tracking_events_exchange'; // Nombre del exchange de tracking
const NOTIFICACIONES_QUEUE = 'notificaciones_email_queue';
const NOTIFICACIONES_DLX = 'notificaciones_dlx';
const NOTIFICACIONES_DLQ_ROUTING_KEY = 'notificaciones_dlq';

const connect = async () => {
    try {
        connection = await amqp.connect(rabbitmqUrl);
        // Canal en modo confirm: publishToQueue espera el ack real del broker antes de reportar
        // éxito (ver más abajo), en vez de asumir éxito apenas se escribe en el socket TCP.
        channel = await connection.createConfirmChannel();

        connection.on('error', (error) => {
            console.error('[MS_Tutorias] Error en conexión RabbitMQ:', error.message);
        });

        channel.on('error', (error) => {
            console.error('[MS_Tutorias] Error en canal RabbitMQ:', error.message);
        });

        // Asegurarse que el exchange de tracking exista
        await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });

        console.log('[MS_Tutorias] Conectado a RabbitMQ y exchange de tracking asegurado.');
    } catch (error) {
        console.error('[MS_Tutorias] Error al conectar con RabbitMQ:', error.message);
        setTimeout(connect, 5000);
    }
};

// connect(); // Removed auto-connect to allow better control and testing

// Función para publicar en una COLA (para notificaciones)
// Retorna true/false para que callers como el poller del outbox (D2) puedan distinguir éxito de
// fallo y decidir si reintentar -- antes no retornaba nada útil en ningún camino.
const publishToQueue = async (queueName, messagePayload) => {
    if (!channel) {
        console.warn(`[MS_Tutorias] No se pudo publicar en '${queueName}': canal RabbitMQ no disponible.`);
        return false;
    }
    try {
        const queueOptions = queueName === NOTIFICACIONES_QUEUE
            ? {
                durable: true,
                deadLetterExchange: NOTIFICACIONES_DLX,
                deadLetterRoutingKey: NOTIFICACIONES_DLQ_ROUTING_KEY
            }
            : { durable: true };

        await channel.assertQueue(queueName, queueOptions);
        const messageBuffer = Buffer.from(JSON.stringify(messagePayload));
        // sendToQueue en un confirm channel invoca este callback solo cuando el broker confirma
        // (ack) o rechaza (nack) el mensaje -- ya no asumimos éxito con solo haberlo escrito en el
        // socket TCP, que es lo que podía marcar una fila del outbox como PUBLICADO sin que
        // RabbitMQ la hubiera persistido/ruteado realmente.
        await new Promise((resolve, reject) => {
            channel.sendToQueue(queueName, messageBuffer, { persistent: true }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        console.log(`[MS_Tutorias] Mensaje publicado y confirmado por el broker en la cola '${queueName}'`);
        return true;
    } catch (error) {
        console.error(`[MS_Tutorias] Error al publicar en cola:`, error.message);
        return false;
    }
};

// --- NUEVA FUNCIÓN ---
// Función para publicar en un EXCHANGE (para tracking)
const publishTrackingEvent = async (payload) => {
    if (!channel) { return; }
    try {
        const messageBuffer = Buffer.from(JSON.stringify(payload));
        // Publicar en el exchange. El routing key ('') es ignorado por 'fanout'.
        channel.publish(EXCHANGE_NAME, '', messageBuffer);
        console.log(`[MS_Tutorias] Evento de tracking publicado:`, payload.message);
    } catch (error) {
        console.error(`[MS_Tutorias] Error al publicar evento de tracking:`, error.message);
    }
};

module.exports = {
    connect,
    publishToQueue,
    publishTrackingEvent // <-- Exportar la nueva función
};

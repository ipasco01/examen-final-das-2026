// ms-usuarios/src/infrastructure/messaging/message.producer.js
const amqp = require('amqplib');
const { rabbitmqUrl } = require('../../config'); // Importar desde el nuevo config
const { injectTraceContext } = require('../../config/rabbitmq-propagation');

let channel = null;
const EXCHANGE_NAME = 'tracking_events_exchange';

const connect = async () => {
    try {
        const connection = await amqp.connect(rabbitmqUrl);
        channel = await connection.createChannel();
        await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
        console.log('[MS_Usuarios] Conectado a RabbitMQ y exchange de tracking asegurado.');
    } catch (error) {
        console.error('[MS_Usuarios] Error al conectar con RabbitMQ:', error.message);
        setTimeout(connect, 5000);
    }
};

const publishTrackingEvent = async (payload) => {
    if (!channel) { return; }
    try {
        const messageBuffer = Buffer.from(JSON.stringify(payload));
        channel.publish(EXCHANGE_NAME, '', messageBuffer, { headers: injectTraceContext() });
    } catch (error) {
        console.error(`[MS_Usuarios] Error al publicar evento de tracking:`, error.message);
    }
};

// Función helper para publicar tracking
const track = (cid, message, status = 'INFO') => {
    publishTrackingEvent({
        service: 'MS_Usuarios',
        message,
        cid,
        timestamp: new Date(),
        status
    });
};

module.exports = {
    connect, // Exportar connect para llamarlo en app.js
    track      // Exportar la función helper
};
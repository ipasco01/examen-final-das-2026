// ms-notificaciones/src/infrastructure/messaging/message.producer.js
const amqp = require('amqplib');
const { rabbitmqUrl } = require('../../config');

let channel = null;
const EXCHANGE_NAME = 'tracking_events_exchange';

const connect = async () => {
    try {
        const connection = await amqp.connect(rabbitmqUrl);
        channel = await connection.createChannel();
        await channel.assertExchange(EXCHANGE_NAME, 'fanout', { durable: true });
        console.log('[MS_Notificaciones] Conectado a RabbitMQ y exchange de tracking asegurado.');
    } catch (error) {
        console.error('[MS_Notificaciones] Error al conectar con RabbitMQ:', error.message);
        setTimeout(connect, 5000);
    }
};

// David: MISMO ARREGLO que se hizo en ms-tutorias (D1). Antes, si el canal
// no estaba listo, esta función hacía "return" en silencio -- el evento de
// tracking simplemente desaparecía, sin log, sin aviso. Ahora se anota en
// consola (console.warn) y se retorna true/false para que quien la llame
// (track(), justo abajo) también pueda saber si de verdad se publicó.
const publishTrackingEvent = async (payload) => {
    if (!channel) {
        console.warn('[MS_Notificaciones] No se pudo publicar evento de tracking: canal RabbitMQ no disponible.');
        return false;
    }
    try {
        const messageBuffer = Buffer.from(JSON.stringify(payload));
        channel.publish(EXCHANGE_NAME, '', messageBuffer);
        return true;
    } catch (error) {
        console.error('[MS_Notificaciones] Error al publicar evento de tracking:', error.message);
        return false;
    }
};

const track = (cid, message, status = 'INFO') => {
    publishTrackingEvent({
        service: 'MS_Notificaciones',
        message,
        cid,
        timestamp: new Date(),
        status
    });
};

module.exports = {
    connect,
    publishTrackingEvent,
    track
};
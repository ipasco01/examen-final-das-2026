// ms-notificaciones/scripts/reencolar-dlq.js
//
// Comando de operación (R3): reencola en notificaciones_email_queue los mensajes que quedaron en
// notificaciones_dlq (dead-letter sin ningún consumidor automático hasta ahora). Toma un snapshot
// de lo que hay en la DLQ en el momento en que corre -- no se queda escuchando -- y por cada
// mensaje: lo publica de nuevo en la cola principal y recién entonces confirma (ack) su salida de
// la DLQ, para no perder el mensaje si la republicación falla a mitad de camino.
//
// Uso:
//   node scripts/reencolar-dlq.js            # reencola todo lo que haya en la DLQ ahora mismo
//   node scripts/reencolar-dlq.js --limit 10  # como máximo 10 mensajes
require('dotenv').config();
const amqp = require('amqplib');
const config = require('../src/config');

const QUEUE_NAME = 'notificaciones_email_queue';
const DLQ_NAME = 'notificaciones_dlq';

const parseLimit = (argv) => {
    const idx = argv.indexOf('--limit');
    if (idx === -1) return Infinity;
    const value = Number(argv[idx + 1]);
    return Number.isFinite(value) && value > 0 ? value : Infinity;
};

const main = async () => {
    const limit = parseLimit(process.argv.slice(2));
    const connection = await amqp.connect(config.rabbitmqUrl);
    const channel = await connection.createConfirmChannel();

    await channel.assertQueue(DLQ_NAME, { durable: true });
    await channel.assertQueue(QUEUE_NAME, { durable: true });

    let reencolados = 0;
    while (reencolados < limit) {
        const msg = await channel.get(DLQ_NAME, { noAck: false });
        if (msg === false) break; // DLQ vacía

        await new Promise((resolve, reject) => {
            channel.sendToQueue(QUEUE_NAME, msg.content, { persistent: true }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        channel.ack(msg);
        reencolados += 1;
    }

    console.log(`[reencolar-dlq] ${reencolados} mensaje(s) reencolados de '${DLQ_NAME}' a '${QUEUE_NAME}'.`);
    await channel.close();
    await connection.close();
};

main().catch((err) => {
    console.error('[reencolar-dlq] Error:', err.stack);
    process.exitCode = 1;
});

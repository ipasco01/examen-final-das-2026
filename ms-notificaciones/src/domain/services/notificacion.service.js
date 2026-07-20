// ms-notificaciones/src/domain/services/notificacion.service.js
const { randomUUID } = require('crypto');
const emailProvider = require('../../infrastructure/providers/email.provider');
const { track } = require('../../infrastructure/messaging/message.producer'); // <-- IMPORTAR TRACK

// David: ESTA LÍNEA FALTABA. El código ya usaba "logNotificacionRepository"
// más abajo (en enviarEmailNotificacion) pero nadie lo había importado --
// eso rompía el servicio con "ReferenceError: logNotificacionRepository is
// not defined" en cuanto llegaba el primer mensaje real.

const logNotificacionRepository = require('../../infrastructure/repositories/logNotificacion.repository'); // <-- IMPORTAR REPOSITORY

const enviarNotificacion = async (canal, datosNotificacion) => {
    const { destinatario, asunto, cuerpo } = datosNotificacion;

    // --- BLOQUE DE VALIDACIÓN AÑADIDO ---
    if (!destinatario || !asunto || !cuerpo) {
        const error = new Error('Faltan datos requeridos en el cuerpo de la petición: se necesita destinatario, asunto y cuerpo.');
        error.statusCode = 400; // Bad Request
        throw error;
    }
    // ------------------------------------

    let resultadoEnvio;

    switch (canal.toLowerCase()) {
        case 'email':
            resultadoEnvio = await emailProvider.enviarEmail(destinatario, asunto, cuerpo);
            break;
        case 'sms':
            const smsError = new Error(`El canal 'sms' no está implementado.`);
            smsError.statusCode = 501; // Not Implemented
            throw smsError;
        default:
            const channelError = new Error(`El canal '${canal}' no es soportado.`);
            channelError.statusCode = 400; // Bad Request
            throw channelError;
    }

    const log = {
        logId: randomUUID(),
        canal: canal,
        destinatario: destinatario, // Ahora este valor sí existirá
        timestamp: new Date().toISOString(),
        estado: resultadoEnvio.estado
    };

    return log;
};

// David: enviarEmailNotificacion (la que usa el consumidor de RabbitMQ en
// app.js) ahora sí puede usar logNotificacionRepository porque ya está
// importado arriba. La lógica de deduplicación que ya estaba escrita aquí
// abajo ahora funciona de verdad.
const enviarEmailNotificacion = async (payloadNotificacion) => {
    const { destinatario, asunto, cuerpo, correlationId } = payloadNotificacion;
    const cid = correlationId || randomUUID();
 
    // David: pregunta de deduplicación -- "¿ya mandé esta carta antes?"
    // Esto resuelve el Crítico D4: si RabbitMQ reentrega el mismo mensaje
    // (algo normal en su garantía de "al menos una entrega"), no se manda
    // el correo dos veces.
    const yaEnviado = await logNotificacionRepository.existsByCorrelationId(cid);
    if (yaEnviado) {
        track(cid, `Email ya fue enviado previamente para este correlationId (${cid}). Omitiendo reenvío duplicado.`);
        return { logId: null, canal: 'email', destinatario, estado: 'DUPLICADO_OMITIDO', correlationId: cid };
    }
 
    try {
        track(cid, `Procesando email para: ${destinatario}`);
 
        if (!destinatario || !asunto || !cuerpo) {
            const error = new Error('Datos incompletos para enviar email: se necesita destinatario, asunto y cuerpo.');
            error.statusCode = 400;
            throw error;
        }
 
        const resultadoEnvio = await emailProvider.enviarEmail(destinatario, asunto, cuerpo);
 
        const log = {
            logId: randomUUID(),
            canal: 'email',
            destinatario,
            timestamp: new Date().toISOString(),
            estado: resultadoEnvio.estado,
            correlationId: cid
        };
 
        // David: se persiste en la base de datos ANTES de que app.js haga
        // el ack. Así, si el proceso se cayera justo después de enviar el
        // email pero antes del ack, y RabbitMQ reentregara el mensaje, el
        // chequeo de arriba (existsByCorrelationId) ya lo va a encontrar y
        // no se reenviará el correo.
        await logNotificacionRepository.save(log);
 
        track(cid, `Email simulado enviado a: ${destinatario}`);
        return log;
 
    } catch (error) {
        track(cid, `Error al enviar email: ${error.message}`, 'ERROR');
        throw error;
    }
};


module.exports = {
    enviarNotificacion,
    enviarEmailNotificacion
};

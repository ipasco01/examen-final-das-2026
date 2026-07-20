// ms-notificaciones/src/domain/models/LogNotificacion.js
//
// David: este archivo existía pero estaba vacío. Un "modelo" de dominio no
// habla con la base de datos -- solo describe la FORMA de un dato, como un
// molde de galletas. Quien sí habla con la base de datos es
// logNotificacion.repository.js (archivo nuevo, ver infrastructure/repositories).
class LogNotificacion {
    constructor({ logId, correlationId, canal, destinatario, estado, timestamp }) {
        this.logId = logId;
        this.correlationId = correlationId;
        this.canal = canal;
        this.destinatario = destinatario;
        this.estado = estado;
        this.timestamp = timestamp;
    }
}

module.exports = LogNotificacion;
// ms-notificaciones/src/infrastructure/repositories/logNotificacion.repository.js
//
// David: archivo NUEVO. Es el único lugar del código que sabe hablar
// directamente con la tabla logs_notificacion. notificacion.service.js le
// pregunta cosas a este archivo, pero nunca escribe SQL él mismo -- así,
// si algún día cambia la base de datos, solo hay que tocar este archivo.
const pool = require('../../config/db');

// David: "¿ya mandé esta carta antes?" -- se apoya en el UNIQUE de la
// tabla (ver 01-schema.sql), pero preguntar primero evita hacer el envío
// de email en el camino feliz (más rápido que esperar a que la base de
// datos rechace un INSERT duplicado).
const existsByCorrelationId = async (correlationId) => {
    const { rows } = await pool.query(
        'SELECT 1 FROM logs_notificacion WHERE correlation_id = $1 LIMIT 1',
        [correlationId]
    );
    return rows.length > 0;
};

// David: ON CONFLICT DO NOTHING es la RED DE SEGURIDAD final. Si dos
// intentos casi simultáneos pasan el chequeo de existsByCorrelationId al
// mismo tiempo (antes de que cualquiera de los dos haya insertado nada
// todavía), esto evita que el segundo INSERT cree una fila duplicada.
const save = async (log) => {
    await pool.query(
        `INSERT INTO logs_notificacion (log_id, correlation_id, canal, destinatario, estado, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (correlation_id) DO NOTHING`,
        [log.logId, log.correlationId, log.canal, log.destinatario, log.estado, log.timestamp]
    );
};

module.exports = { existsByCorrelationId, save };
// ms-tutorias/src/infrastructure/repositories/outbox.repository.js
const OUTBOX_TABLE = 'tutorias_notificaciones_outbox';

// Todas las funciones reciben un `client` explícito (de una transacción ya abierta vía
// db.withTransaction) porque el patrón outbox depende de que el INSERT/UPDATE de esta tabla
// ocurra en la misma transacción que el cambio de estado de la tutoría, o que el reclamo de filas
// pendientes en el poller.

const insertarPendiente = async (client, idTutoria, payload) => {
    const res = await client.query(
        `INSERT INTO ${OUTBOX_TABLE}(idTutoria, payload) VALUES ($1, $2) RETURNING *`,
        [idTutoria, payload]
    );
    return res.rows[0];
};

// SELECT ... FOR UPDATE SKIP LOCKED evita que dos ticks del poller (uno solapado con el anterior
// por lentitud, o dos instancias de ms-tutorias) procesen la misma fila dos veces: cada uno
// simplemente salta las filas que el otro ya tiene bloqueadas dentro de su transacción.
const reclamarPendientes = async (client, limit) => {
    const res = await client.query(
        `SELECT * FROM ${OUTBOX_TABLE}
         WHERE estado = 'PENDIENTE'
         ORDER BY createdAt ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
    );
    return res.rows;
};

const marcarPublicado = async (client, idOutbox) => {
    await client.query(
        `UPDATE ${OUTBOX_TABLE} SET estado = 'PUBLICADO', publishedAt = CURRENT_TIMESTAMP WHERE idOutbox = $1`,
        [idOutbox]
    );
};

const registrarIntentoFallido = async (client, idOutbox, intentosActuales, mensajeError, maxIntentos) => {
    const nuevosIntentos = intentosActuales + 1;
    const nuevoEstado = nuevosIntentos >= maxIntentos ? 'FALLIDO' : 'PENDIENTE';
    await client.query(
        `UPDATE ${OUTBOX_TABLE} SET intentos = $1, ultimoError = $2, estado = $3 WHERE idOutbox = $4`,
        [nuevosIntentos, mensajeError, nuevoEstado, idOutbox]
    );
};

module.exports = { insertarPendiente, reclamarPendientes, marcarPublicado, registrarIntentoFallido };

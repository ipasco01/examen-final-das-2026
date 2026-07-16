// ms-tutorias/src/infrastructure/repositories/compensacion.repository.js
const COMPENSACIONES_TABLE = 'compensaciones_pendientes';

// Todas las funciones reciben un `client` explícito (de una transacción ya abierta vía
// db.withTransaction), mismo criterio que outbox.repository.js: el INSERT de esta tabla debe
// ocurrir en la misma transacción que el UPDATE a FALLIDA, o dentro del reclamo transaccional del
// worker.

const insertarPendiente = async (client, idTutoria, payload) => {
    const { idBloqueo, idTutor, correlationId, motivo } = payload;
    const res = await client.query(
        `INSERT INTO ${COMPENSACIONES_TABLE}(idBloqueo, idTutoria, idTutor, correlationId, motivo)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [idBloqueo, idTutoria, idTutor, correlationId, motivo]
    );
    return res.rows[0];
};

// SELECT ... FOR UPDATE SKIP LOCKED evita que dos ticks del worker (uno solapado con el anterior,
// o dos instancias de ms-tutorias) procesen la misma fila dos veces.
const reclamarPendientes = async (client, limit) => {
    const res = await client.query(
        `SELECT * FROM ${COMPENSACIONES_TABLE}
         WHERE estado = 'PENDIENTE'
         ORDER BY createdAt ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
    );
    return res.rows;
};

const marcarResuelto = async (client, idCompensacion) => {
    await client.query(
        `UPDATE ${COMPENSACIONES_TABLE} SET estado = 'RESUELTO', resolvedAt = CURRENT_TIMESTAMP WHERE idCompensacion = $1`,
        [idCompensacion]
    );
};

const registrarIntentoFallido = async (client, idCompensacion, intentosActuales, mensajeError, maxIntentos) => {
    const nuevosIntentos = intentosActuales + 1;
    const nuevoEstado = nuevosIntentos >= maxIntentos ? 'FALLIDO' : 'PENDIENTE';
    await client.query(
        `UPDATE ${COMPENSACIONES_TABLE} SET intentos = $1, ultimoError = $2, estado = $3 WHERE idCompensacion = $4`,
        [nuevosIntentos, mensajeError, nuevoEstado, idCompensacion]
    );
    return { nuevoEstado, nuevosIntentos };
};

module.exports = { insertarPendiente, reclamarPendientes, marcarResuelto, registrarIntentoFallido };

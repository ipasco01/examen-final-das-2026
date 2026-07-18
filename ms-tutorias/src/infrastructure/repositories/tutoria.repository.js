// const { randomUUID } = require('crypto');
// const tutoriasDB = [];

// const save = async (tutoria) => {
//     // Si la tutoría ya existe, la actualiza. Si no, la crea.
//     const index = tutoriasDB.findIndex(t => t.idTutoria === tutoria.idTutoria);
//     if (index !== -1) {
//         tutoriasDB[index] = tutoria;
//     } else {
//         tutoria.idTutoria = randomUUID();
//         tutoriasDB.push(tutoria);
//     }
//     return tutoria;
// };

// module.exports = { save };

// ms-tutorias/src/infrastructure/repositories/tutoria.repository.js
const db = require('../../config/db');
const { ESTADOS, obtenerEstadosOrigenValidos } = require('../../domain/models/tutoria-estado');
const outboxRepository = require('./outbox.repository');
const compensacionRepository = require('./compensacion.repository');

const save = async (tutoria, options = {}) => {
    const { outboxNotificacion, compensacionPendiente } = options;

    // Imprimimos el objeto recibido para depuración
    console.log('[TutoriaRepository] save() recibió:', JSON.stringify(tutoria));

    // Desestructuramos los campos del objeto tutoria
    const { idTutoria, idEstudiante, idTutor, nombreTutor, fecha, materia, estado, error, idempotencyKey, idBloqueo } = tutoria;

    if (idTutoria) {
        // --- Lógica de UPDATE ---
        console.log(`[TutoriaRepository] Ejecutando UPDATE para idTutoria: ${idTutoria}`);
        // Construimos los campos a actualizar dinámicamente para más flexibilidad (opcional pero robusto)
        const fields = [];
        const values = [];
        let paramIndex = 1;

        // Solo añadimos campos que realmente vienen en el objeto 'tutoria' para actualizar
        if (idEstudiante !== undefined) { fields.push(`idEstudiante = $${paramIndex++}`); values.push(idEstudiante); }
        if (idTutor !== undefined) { fields.push(`idTutor = $${paramIndex++}`); values.push(idTutor); }
        if (nombreTutor !== undefined) { fields.push(`nombreTutor = $${paramIndex++}`); values.push(nombreTutor); }
        if (fecha !== undefined) { fields.push(`fecha = $${paramIndex++}`); values.push(fecha); }
        if (materia !== undefined) { fields.push(`materia = $${paramIndex++}`); values.push(materia); }
        if (estado !== undefined) { fields.push(`estado = $${paramIndex++}`); values.push(estado); }
        // idBloqueo: se setea una sola vez, al confirmar la tutoría (bloquearAgenda ya devolvió un
        // id). cancelarTutoria lo lee más tarde para saber qué bloqueo liberar en ms-agenda.
        if (idBloqueo !== undefined) { fields.push(`idBloqueo = $${paramIndex++}`); values.push(idBloqueo); }
        // Manejamos el error explícitamente (puede ser null)
        fields.push(`error = $${paramIndex++}`); values.push(error === undefined ? null : error);

        // Añadimos el idTutoria para la cláusula WHERE al final
        values.push(idTutoria);

        if (fields.length === 0) {
             console.warn(`[TutoriaRepository] UPDATE llamado para ${idTutoria} sin campos para actualizar.`);
             return tutoria; // Nada que actualizar, retornamos el objeto tal cual
        }

        // Máquina de estados: si esta actualización cambia `estado`, restringimos el UPDATE a las
        // filas cuyo estado actual sea un origen válido para el destino (ver tutoria-estado.js).
        // Un destino sin orígenes válidos (array vacío) hace que `estado = ANY($array)` no matchee
        // ninguna fila -- falla cerrado, no es un bug. Esto hace el guard atómico (sin carrera
        // SELECT-then-UPDATE): la corrección de la transición la garantiza el propio WHERE.
        let whereEstadoClause = '';
        if (estado !== undefined) {
            const estadosOrigenValidos = obtenerEstadosOrigenValidos(estado);
            values.push(estadosOrigenValidos);
            whereEstadoClause = ` AND estado = ANY($${paramIndex + 1})`;
        }

        const queryText = `
            UPDATE tutorias
            SET ${fields.join(', ')}, updatedAt = CURRENT_TIMESTAMP
            WHERE idTutoria = $${paramIndex}${whereEstadoClause}
            RETURNING *`;

        console.log(`[TutoriaRepository] UPDATE Query: ${queryText}`);
        console.log(`[TutoriaRepository] UPDATE Values: ${JSON.stringify(values)}`);

        // Ejecuta el UPDATE guardado con el `executor` dado (db.query directo, o client.query
        // dentro de una transacción) y desambigua un resultado vacío. Compartida entre el camino
        // plano y el transaccional para no duplicar la lógica de construcción del WHERE/SET.
        const ejecutarUpdateGuardado = async (executor) => {
            const res = await executor(queryText, values);
            if (res.rows.length === 0) {
                // ¿La tutoría no existe, o existe pero su estado actual no es un origen válido
                // para el destino pedido? No necesita ser atómica con el UPDATE de arriba -- solo
                // decide qué mensaje mostrar, la corrección de la máquina de estados ya la
                // garantizó el WHERE.
                if (estado !== undefined) {
                    const filaActual = await executor('SELECT estado FROM tutorias WHERE idTutoria = $1', [idTutoria]);
                    if (filaActual.rows.length > 0) {
                        const estadoActual = filaActual.rows[0].estado;
                        const transitionError = new Error(
                            `Transición de estado inválida: no se puede pasar de '${estadoActual}' a '${estado}' para la tutoría ${idTutoria}.`
                        );
                        transitionError.statusCode = 409;
                        transitionError.code = 'INVALID_STATE_TRANSITION';
                        throw transitionError;
                    }
                }
                throw new Error(`UPDATE fallido: No se encontró tutoría con id ${idTutoria}`);
            }
            console.log('[TutoriaRepository] UPDATE exitoso:', JSON.stringify(res.rows[0]));
            return res.rows[0];
        };

        try {
            if (outboxNotificacion || compensacionPendiente) {
                // Patrón outbox (D2) / compensación pendiente (D6): el UPDATE de estado y el
                // INSERT dependiente (notificación a publicar, o compensación a reintentar en
                // segundo plano) deben confirmarse juntos o no confirmarse -- si el UPDATE afecta
                // 0 filas, no se toca ninguna de las dos tablas; el rollback lo maneja withTransaction.
                return await db.withTransaction(async (client) => {
                    const executor = (text, params) => client.query(text, params);
                    const filaActualizada = await ejecutarUpdateGuardado(executor);
                    if (outboxNotificacion) {
                        await outboxRepository.insertarPendiente(client, idTutoria, outboxNotificacion);
                    }
                    if (compensacionPendiente) {
                        await compensacionRepository.insertarPendiente(client, idTutoria, compensacionPendiente);
                    }
                    return filaActualizada;
                });
            }

            return await ejecutarUpdateGuardado((text, params) => db.query(text, params));
        } catch (err) {
            console.error('[TutoriaRepository] Error ejecutando query UPDATE tutoria:', err.stack);
            console.error('[TutoriaRepository] UPDATE Query que falló:', queryText);
            console.error('[TutoriaRepository] UPDATE Values que fallaron:', JSON.stringify(values));
            throw err; // Re-lanzar el error para manejo superior
        }

    } else {
        // --- Lógica de INSERT ---
        console.log('[TutoriaRepository] Ejecutando INSERT');
        const queryText = `
            INSERT INTO tutorias(idEstudiante, idTutor, nombreTutor, fecha, materia, estado, error, idempotencyKey)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *`;
        const insertValues = [idEstudiante, idTutor, nombreTutor || null, fecha, materia, estado || 'PENDIENTE', error || null, idempotencyKey || null];

        console.log(`[TutoriaRepository] INSERT Query: ${queryText}`);
        console.log(`[TutoriaRepository] INSERT Values: ${JSON.stringify(insertValues)}`);

        try {
            // Validación adicional para evitar insertar con idEstudiante nulo
             if (idEstudiante == null) {
                console.error('[TutoriaRepository] ¡ERROR PREVIO AL INSERT! idEstudiante es null o undefined.');
                throw new Error('idEstudiante no puede ser null para un nuevo registro de tutoría.');
             }
            // Máquina de estados: toda tutoría nueva debe nacer PENDIENTE (nada hoy pasa otro
            // valor, pero cierra el hueco de que cualquier estado sea válido como inicial).
            if (estado !== undefined && estado !== ESTADOS.PENDIENTE) {
                const err = new Error(`Estado inicial inválido: una tutoría nueva debe crearse como '${ESTADOS.PENDIENTE}', no '${estado}'.`);
                err.statusCode = 400;
                err.code = 'INVALID_INITIAL_STATE';
                throw err;
            }
            const res = await db.query(queryText, insertValues);
             console.log('[TutoriaRepository] INSERT exitoso:', JSON.stringify(res.rows[0]));
            return res.rows[0];
        } catch (err) { // Manejo de errores en INSERT
            // Carrera de idempotencia: otra solicitud concurrente con la misma idempotencyKey ya insertó su fila.
            // En vez de tratarlo como bug, recuperamos y devolvemos el registro ya existente (mismo criterio que
            // ms-agenda usa para 23505: es una condición recuperable, no una falla).
            if (err.code === '23505' && idempotencyKey && err.constraint === 'tutorias_idempotencykey_key') {
                console.warn(`[TutoriaRepository] INSERT en conflicto por idempotencyKey duplicada: ${idempotencyKey}. Recuperando registro existente.`);
                const existente = await findByIdempotencyKey(idempotencyKey);
                if (existente) return existente;
            }
            console.error('[TutoriaRepository] Error ejecutando query INSERT tutoria:', err.stack);
            console.error('[TutoriaRepository] INSERT Query que falló:', queryText);
            console.error('[TutoriaRepository] INSERT Values que fallaron:', JSON.stringify(insertValues));
            throw err;
        }
    }
};

const findByIdempotencyKey = async (idempotencyKey) => {
    if (!idempotencyKey) return null;

    const queryText = 'SELECT * FROM tutorias WHERE idempotencyKey = $1';
    try {
        const res = await db.query(queryText, [idempotencyKey]);
        return res.rows[0] || null;
    } catch (err) {
        console.error('[TutoriaRepository] Error ejecutando query findByIdempotencyKey:', err.stack);
        throw err;
    }
};

// S2: a diferencia del outbox y de compensaciones_pendientes, no hay ningún proceso que reclame
// filas PENDIENTE huérfanas (el proceso murió a mitad de la Saga, antes de llegar al catch que
// transiciona a FALLIDA). Un UPDATE...RETURNING atómico alcanza aquí -- no hace falta el patrón
// SELECT...FOR UPDATE SKIP LOCKED de los otros workers porque no hay ningún side-effect adicional
// por fila (no se inserta en otra tabla): dos instancias corriendo esto a la vez simplemente no se
// pisan, porque en cuanto una fila deja de estar en PENDIENTE el WHERE de la otra deja de matchearla.
const reconciliarPendientesViejas = async (fechaCorte, limit) => {
    // Misma fuente de verdad que save(): solo se reconcilian filas cuyo estado actual es un origen
    // válido para FALLIDA según la máquina de estados, en vez de hardcodear 'PENDIENTE' aquí.
    const estadosOrigenValidos = obtenerEstadosOrigenValidos(ESTADOS.FALLIDA);
    if (estadosOrigenValidos.length === 0) return [];

    const queryText = `
        UPDATE tutorias
        SET estado = 'FALLIDA',
            error = 'Reconciliación automática: la tutoría quedó PENDIENTE sin completar la Saga dentro del umbral esperado.',
            updatedAt = CURRENT_TIMESTAMP
        WHERE idTutoria IN (
            SELECT idTutoria FROM tutorias
            WHERE estado = ANY($1) AND createdAt < $2
            ORDER BY createdAt ASC
            LIMIT $3
        )
        RETURNING idTutoria, idTutor, idEstudiante, fecha, idempotencyKey`;

    // S6: esta función solo la llama el worker de reconciliación (nunca el camino HTTP) -- usa el
    // pool reservado para workers de fondo.
    const res = await db.workerQuery(queryText, [estadosOrigenValidos, fechaCorte, limit]);
    return res.rows;
};

// S8: soporte para GET /v1/tutorias/:id -- antes no existía ninguna forma de consultar el estado
// de una tutoría después de crearla (ej. una que quedó PENDIENTE por una respuesta lenta).
const findById = async (idTutoria) => {
    const res = await db.query('SELECT * FROM tutorias WHERE idTutoria = $1', [idTutoria]);
    return res.rows[0] || null;
};

// Listado de "mis tutorías" para GET /v1/tutorias -- más recientes primero, es lo que un cliente
// esperaría ver arriba al abrir la lista.
const findByEstudiante = async (idEstudiante) => {
    const res = await db.query(
        'SELECT * FROM tutorias WHERE idEstudiante = $1 ORDER BY createdAt DESC',
        [idEstudiante]
    );
    return res.rows;
};

module.exports = { save, findByIdempotencyKey, reconciliarPendientesViejas, findById, findByEstudiante };
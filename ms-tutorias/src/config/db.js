// ms-tutorias/src/config/db.js
const { Pool } = require('pg');

const basePoolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5434, // Puerto para desarrollo local sin Docker
    user: process.env.DB_USER || 'user_tutorias',
    password: process.env.DB_PASSWORD || 'password_tutorias',
    database: process.env.DB_NAME || 'db_tutorias',
    // S1: sin esto, un lock contendido o una conexión colgada bloquea la query (y por lo tanto el
    // request HTTP) indefinidamente -- a diferencia de las llamadas a ms-usuarios/ms-agenda, que sí
    // tienen 1.5s de tope vía Opossum + axios. statement_timeout aborta la query en el propio
    // Postgres (libera locks); connectionTimeoutMillis acota cuánto se espera por una conexión
    // libre del pool.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 5000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
};

// S6: antes, un único Pool (sin `max` explícito -> default de `pg`: 10) atendía tanto el tráfico
// HTTP como los tres workers de fondo (outbox, compensación, reconciliación), cada uno reteniendo
// una conexión durante todo un tick transaccional -- un pico de tráfico coincidiendo con los
// workers a mitad de tick podía agotarlo. Se separan en dos pools: uno para el camino HTTP (más
// grande, más consumidores concurrentes) y uno reservado para los workers de fondo (más chico, a
// propósito, para que nunca puedan acaparar todas las conexiones disponibles).
const pool = new Pool({ ...basePoolConfig, max: Number(process.env.DB_POOL_MAX || 15) });
const workerPool = new Pool({ ...basePoolConfig, max: Number(process.env.DB_WORKER_POOL_MAX || 3) });

 pool.connect((err, client, release) => {
     if (err) {
         console.error('[ms-tutorias] Error al conectar con PostgreSQL:', err.stack);
     } else {
         console.log('[ms-tutorias] Conexión exitosa a PostgreSQL');
         release();
     }
 });

const ejecutarTransaccion = async (poolElegido, callback) => {
    const client = await poolElegido.connect();
    let liberado = false;
    try {
        await client.query('BEGIN');
        const resultado = await callback(client);
        await client.query('COMMIT');
        return resultado;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('[ms-tutorias] Error ejecutando ROLLBACK:', rollbackErr.stack);
        }
        client.release(err);
        liberado = true;
        throw err;
    } finally {
        if (!liberado) client.release();
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
    // Helper de transacción reutilizable (primer uso de BEGIN/COMMIT/ROLLBACK en este servicio,
    // para el patrón outbox: la actualización de estado y el encolado de notificación deben
    // confirmarse juntos o no confirmarse). Pasar el error a `client.release(err)` en el camino de
    // fallo hace que `pg` descarte esa conexión del pool en vez de devolver una potencialmente
    // envenenada. Usa el pool del camino HTTP.
    withTransaction: (callback) => ejecutarTransaccion(pool, callback),
    // Contraparte de `query`/`withTransaction` para los workers de fondo (S6): mismo Postgres,
    // pool separado y más chico a propósito.
    workerQuery: (text, params) => workerPool.query(text, params),
    withWorkerTransaction: (callback) => ejecutarTransaccion(workerPool, callback),
};
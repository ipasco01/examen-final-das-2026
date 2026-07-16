// ms-tutorias/src/config/db.js
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5434, // Puerto para desarrollo local sin Docker
    user: process.env.DB_USER || 'user_tutorias',
    password: process.env.DB_PASSWORD || 'password_tutorias',
    database: process.env.DB_NAME || 'db_tutorias',
});

 pool.connect((err, client, release) => {
     if (err) {
         console.error('[ms-tutorias] Error al conectar con PostgreSQL:', err.stack);
     } else {
         console.log('[ms-tutorias] Conexión exitosa a PostgreSQL');
         release();
     }
 });

// Helper de transacción reutilizable (primer uso de BEGIN/COMMIT/ROLLBACK en este servicio, para
// el patrón outbox: la actualización de estado y el encolado de notificación deben confirmarse
// juntos o no confirmarse). Pasar el error a `client.release(err)` en el camino de fallo hace que
// `pg` descarte esa conexión del pool en vez de devolver una potencialmente envenenada.
const withTransaction = async (callback) => {
    const client = await pool.connect();
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
    withTransaction,
};
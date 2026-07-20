// ms-auth/src/infrastructure/repositories/user.repository.js
const db = require('../../config/db');

const buildUndefinedTableError = (err) => {
    if (err.code !== '42P01') return err;

    const relationMatch = err.message?.match(/relation "([^"]+)" does not exist/);
    const tableName = err.table || relationMatch?.[1] || 'desconocida';
    const error = new Error(`Base de datos de autenticación no inicializada: falta la tabla ${tableName}. Ejecuta el script SQL de inicialización.`);
    error.statusCode = 500;
    error.code = err.code;
    error.cause = err;
    return error;
};

const findByUsername = async (username) => {
    const queryText = 'SELECT * FROM users WHERE username = $1';
    try {
        const res = await db.query(queryText, [username]);
        return res.rows[0];
    } catch (err) {
        console.error('Error ejecutando query findByUsername:', err.stack);
        throw buildUndefinedTableError(err);
    }
};

module.exports = { findByUsername };
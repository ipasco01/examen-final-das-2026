// ms-auth/src/config/db.js
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5435,
    user: process.env.DB_USER || 'user_auth',
    password: process.env.DB_PASSWORD || 'password_auth',
    database: process.env.DB_NAME || 'db_auth',
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('Error al conectar con la base de datos PostgreSQL:', err.stack);
    } else {
        console.log('Conexión exitosa a la base de datos PostgreSQL (ms-auth)');
        release();
    }
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
};

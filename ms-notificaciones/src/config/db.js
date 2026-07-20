// ms-notificaciones/src/config/db.js
//
// David: este archivo NO existía. ms-notificaciones nunca tuvo su propia
// base de datos -- por eso LogNotificacion.js estaba vacío, no había dónde
// guardar nada de verdad. Los demás microservicios (ms-tutorias, ms-agenda,
// ms-usuarios) ya tienen un archivo como este; aquí copiamos el mismo patrón
// para no inventar una forma distinta de conectarse a PostgreSQL.
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// David: si la conexión a la base de datos se cae después de haber
// arrancado, este listener evita que el proceso entero de Node se caiga
// con un error no capturado -- solo lo registramos.
pool.on('error', (err) => {
    console.error('[MS_Notificaciones] Error inesperado en el pool de PostgreSQL:', err.message);
});

module.exports = pool;
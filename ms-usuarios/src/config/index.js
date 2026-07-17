// ms-usuarios/src/config/index.js
require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3001,
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
    jwtSecret: process.env.JWT_SECRET,
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER || 'user_usuarios',
        password: process.env.DB_PASSWORD || 'password_usuarios',
        database: process.env.DB_NAME || 'db_usuarios',
    }
};
-- docker/init/notificaciones/01-schema.sql
--
-- David: este archivo tampoco existía. Es el "molde" de la tabla donde
-- Beto va a anotar cada correo que manda. El UNIQUE en correlation_id es
-- lo que hace posible la deduplicación de forma robusta: aunque el
-- código de JS tenga una carrera (dos intentos casi al mismo tiempo), la
-- propia base de datos rechaza el segundo INSERT si el correlation_id
-- se repite.
CREATE TABLE IF NOT EXISTS logs_notificacion (
    log_id UUID PRIMARY KEY,
    correlation_id VARCHAR(255) NOT NULL UNIQUE,
    canal VARCHAR(50) NOT NULL,
    destinatario VARCHAR(255) NOT NULL,
    estado VARCHAR(100) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL
);
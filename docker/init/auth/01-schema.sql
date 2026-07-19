-- docker/init/auth/01-schema.sql — base db_auth (ms-auth)
--
-- Equipo 5 (Deployment). Postgres ejecuta automáticamente todo .sql montado en
-- /docker-entrypoint-initdb.d/ la PRIMERA vez que se inicializa el volumen de datos.
--
-- Por qué existe este archivo: hasta ahora el esquema vivía solo como bloques de código dentro
-- de docs/setup-and-usage.md, para copiar y pegar a mano en cada base. Eso significa que un
-- `docker compose down -v`, un clon nuevo del repo o una máquina distinta producían un sistema
-- sin tablas, y el fallo aparecía recién en runtime (500 en los endpoints, o /metrics roto en
-- ms-tutorias por los Gauges que consultan la base al hacer scrape).
--
-- El esquema es parte de cómo se levanta el sistema, no documentación: acá es ejecutable,
-- versionado y revisable en el PR.
--
-- Idempotencia: se usa IF NOT EXISTS y ON CONFLICT DO NOTHING para que reaplicarlo a mano sobre
-- una base existente no falle (initdb solo corre en volumen vacío, pero el archivo también sirve
-- como script de reparación: psql -U user_auth -d db_auth -f 01-schema.sql).

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    passwordHash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL
);

-- Usuarios de demostración. Los hashes corresponden a las contraseñas 'password_ana' y
-- 'password_elena' (bcrypt). NO usar fuera de desarrollo local: son públicos en el repo.
INSERT INTO users (id, username, passwordHash, name, role) VALUES
('e12345', 'ana.torres', '$2a$10$l9BWZgXLWxnVg.3B74PNi.0CTb93Wsin/XzzqGJLKT0/NrT7epiSm', 'Ana Torres', 'student'),
('t09876', 'elena.solano', '$2a$10$gKxWS9CIu7QUq9ySaw6cSuns8gXvY/x/ynjj/X.giRWgN4jBuQ46W', 'Dra. Elena Solano', 'tutor')
ON CONFLICT (id) DO NOTHING;

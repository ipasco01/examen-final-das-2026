-- docker/init/agenda/01-schema.sql — base db_agenda (ms-agenda)
-- Equipo 5 (Deployment). Se ejecuta solo en la primera inicialización del volumen.
-- Ver docker/init/auth/01-schema.sql para el razonamiento completo.

-- gen_random_uuid() vive en pgcrypto en PostgreSQL 14 (en 13+ también está en pgcrypto; recién
-- desde 13 existe nativo como gen_random_uuid en core, pero la imagen usa 14-alpine y la
-- extensión garantiza el comportamiento en ambos casos).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS bloqueos (
    idBloqueo UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idTutor VARCHAR(50) NOT NULL,
    fechaInicio TIMESTAMPTZ NOT NULL,
    duracionMinutos INTEGER NOT NULL,
    idEstudiante VARCHAR(50) NOT NULL,
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- Esta restricción es la que hace atómico el "reservar horario" de la Saga: dos solicitudes
    -- concurrentes para el mismo tutor y horario no pueden ganar las dos.
    CONSTRAINT uq_bloqueos_tutor_fecha_inicio UNIQUE (idTutor, fechaInicio)
);

CREATE INDEX IF NOT EXISTS idx_bloqueos_idTutor ON bloqueos(idTutor);

-- Bloqueo de demostración: ocupa un horario del tutor t54321 para poder probar el camino de
-- conflicto (409) sin tener que crear uno a mano.
INSERT INTO bloqueos (idTutor, fechaInicio, duracionMinutos, idEstudiante)
SELECT 't54321', '2025-10-22T10:00:00.000Z', 60, 'e12345'
WHERE NOT EXISTS (
    SELECT 1 FROM bloqueos WHERE idTutor = 't54321' AND fechaInicio = '2025-10-22T10:00:00.000Z'
);

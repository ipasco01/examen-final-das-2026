-- docker/init/tutorias/01-schema.sql — base db_tutorias (ms-tutorias, orquestador de la Saga)
-- Equipo 5 (Deployment). Se ejecuta solo en la primera inicialización del volumen.
-- Ver docker/init/auth/01-schema.sql para el razonamiento completo.
--
-- Esta es la base más crítica del sistema: además de las tutorías, guarda el outbox y las
-- compensaciones pendientes del Equipo 1. Si estas tablas no existen:
--   - la Saga no puede registrar compensaciones y una reserva de agenda queda huérfana;
--   - los Gauges de backlog.metrics.js (Equipo 4) consultan estas tablas EN CADA SCRAPE de
--     Prometheus, así que GET /metrics devuelve 500 -- y ese endpoint es el objetivo de las
--     probes de readiness y liveness en kubernetes-manifests/ms-tutorias.yaml.
-- Es decir: sin esquema, el pod de ms-tutorias nunca llega a Ready.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tutorias (
    idTutoria UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idEstudiante VARCHAR(50) NOT NULL,
    idTutor VARCHAR(50) NOT NULL,
    -- Denormalización del nombre ya resuelto contra ms-usuarios en el paso 1 de la Saga.
    nombreTutor VARCHAR(255),
    materia VARCHAR(255),
    fecha TIMESTAMPTZ NOT NULL,
    estado VARCHAR(50) NOT NULL CHECK (estado IN ('PENDIENTE', 'CONFIRMADA', 'FALLIDA', 'CANCELADA')),
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    error VARCHAR(500),
    -- POST /v1/tutorias exige el header Idempotency-Key; se persiste acá para deduplicar
    -- reintentos del cliente.
    idempotencyKey VARCHAR(255) UNIQUE,
    -- Necesario para liberar el horario en ms-agenda al cancelar: antes solo vivía en memoria
    -- durante la Saga, así que un reinicio perdía la referencia al bloqueo.
    idBloqueo UUID
);

CREATE INDEX IF NOT EXISTS idx_tutorias_idEstudiante ON tutorias(idEstudiante);
CREATE INDEX IF NOT EXISTS idx_tutorias_idTutor ON tutorias(idTutor);
CREATE INDEX IF NOT EXISTS idx_tutorias_estado ON tutorias(estado);

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updatedAt = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_timestamp ON tutorias;
CREATE TRIGGER set_timestamp
BEFORE UPDATE ON tutorias
FOR EACH ROW
EXECUTE PROCEDURE trigger_set_timestamp();

-- Patrón outbox (Equipo 1): la confirmación de la tutoría y el encolado de su notificación se
-- confirman en la MISMA transacción (tutoria.repository.js#save + outbox.repository.js). Un
-- poller (outbox.publisher.js) publica las filas PENDIENTE en notificaciones_email_queue.
-- Por esto db-tutorias necesita volumen persistente en Kubernetes: sin él, un reinicio pierde
-- notificaciones ya comprometidas al usuario.
CREATE TABLE IF NOT EXISTS tutorias_notificaciones_outbox (
    idOutbox UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idTutoria UUID NOT NULL REFERENCES tutorias(idTutoria),
    payload JSONB NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'PUBLICADO', 'FALLIDO')),
    intentos INTEGER NOT NULL DEFAULT 0,
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    publishedAt TIMESTAMPTZ,
    ultimoError VARCHAR(500)
);

-- Lo usa el poller y también el Gauge outbox_notificaciones_backlog: el COUNT por estado va por
-- índice, no hace seq scan en cada scrape de Prometheus.
CREATE INDEX IF NOT EXISTS idx_outbox_estado ON tutorias_notificaciones_outbox(estado);

-- Compensación de agenda pendiente (Equipo 1): si el loop de reintentos síncronos agota sus
-- intentos al desbloquear agenda, se registra acá en la misma transacción que el UPDATE a
-- FALLIDA, en vez de publicarse a una cola sin consumidor. compensacion.worker.js reclama las
-- filas PENDIENTE y reintenta agendaClient.cancelarBloqueo en segundo plano.
CREATE TABLE IF NOT EXISTS compensaciones_pendientes (
    idCompensacion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idBloqueo UUID NOT NULL,
    idTutoria UUID NOT NULL REFERENCES tutorias(idTutoria),
    idTutor VARCHAR(50) NOT NULL,
    correlationId VARCHAR(255),
    motivo VARCHAR(500),
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'RESUELTO', 'FALLIDO')),
    intentos INTEGER NOT NULL DEFAULT 0,
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    resolvedAt TIMESTAMPTZ,
    ultimoError VARCHAR(500)
);

CREATE INDEX IF NOT EXISTS idx_compensaciones_pendientes_estado ON compensaciones_pendientes(estado);

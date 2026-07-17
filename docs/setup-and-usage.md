# Configuración y uso local

Esta guía concentra los pasos operativos para levantar el ecosistema local, inicializar datos de ejemplo y ejecutar una prueba integrada. El README principal mantiene la visión del caso; este documento conserva los detalles largos de instalación y uso.

## Ruta recomendada para estudiantes

Use esta ruta antes de responder la Parte A de PC03. El objetivo no es memorizar comandos, sino entender el flujo real del sistema y reunir evidencia mínima.

1. Leer el `README.md` para comprender el caso **Tutorías Universitarias**.
2. Preparar archivos `.env` desde sus plantillas.
3. Levantar servicios con Docker Compose.
4. Inicializar bases de datos PostgreSQL con los scripts de esta guía.
5. Abrir cliente, dashboard, RabbitMQ Management, Prometheus y Grafana.
6. Obtener un token, ejecutar una solicitud de tutoría confirmada y revisar trazabilidad.
7. Probar o inspeccionar un conflicto `409` y registrar qué evidencia lo demuestra.

Los comandos usan `docker compose`, que es la sintaxis moderna integrada a Docker. Si su instalación solo reconoce el binario anterior, use `docker-compose` como fallback manteniendo los mismos argumentos.

## Prerrequisitos

- Git.
- Node.js 18+ si se ejecutan servicios o pruebas fuera de Docker.
- Docker Desktop en ejecución.
- Cliente SQL: DBeaver, pgAdmin o `psql`.

## Configurar variables de entorno

`docker-compose.yml` no trae ningún secreto por defecto: `JWT_SECRET`, las contraseñas de las 4 bases de datos, las credenciales de RabbitMQ y la contraseña de Grafana son obligatorias. Sin un `.env` en la **raíz** del repositorio, `docker compose up` falla con un mensaje indicando qué variable falta.

```bash
cp .env.example .env
```

Los valores de ejemplo son placeholders (`cambia-esta-password`, etc.) — reemplázalos por valores propios de desarrollo local antes de levantar el entorno. `.env` está en `.gitignore`; nunca commitear el real.

Además, crear los `.env` por servicio a partir de sus plantillas (usados solo si corres algún servicio fuera de Docker con `npm run dev`; Docker Compose no los lee, ya que inyecta sus propias variables):

```bash
cp ms-auth/.env.example ms-auth/.env
cp ms-usuarios/.env.example ms-usuarios/.env
cp ms-agenda/.env.example ms-agenda/.env
cp ms-tutorias/.env.example ms-tutorias/.env
cp ms-notificaciones/.env.example ms-notificaciones/.env
cp client-mobile-sim/.env.example client-mobile-sim/.env
cp tracking-dashboard/.env.example tracking-dashboard/.env
```

> Los valores de ejemplo están pensados para desarrollo local. No deben usarse como secretos productivos.

## Levantar el ecosistema

```bash
docker compose up --build
```

Esperar a que los logs indiquen conexiones exitosas a PostgreSQL y RabbitMQ. El entorno local expone servicios de aplicación, bases de datos, RabbitMQ, Toxiproxy, Prometheus y Grafana según `docker-compose.yml`.

Resultado esperado después del arranque:

| Servicio o recurso | Puerto local | Resultado esperado |
| --- | ---: | --- |
| `ms-tutorias` | `3000` | API orquestadora disponible para crear solicitudes de tutoría. |
| `ms-usuarios` | `3001` | API de usuarios disponible para validar estudiantes y tutores. |
| `ms-agenda` | `3002` | API de agenda disponible para verificar y bloquear horarios. |
| `ms-notificaciones` | `3003` | Consumidor de notificaciones conectado a RabbitMQ. |
| `ms-auth` | `4000` | Servicio de autenticación disponible para emitir token. |
| Cliente web | `8080` | Formulario local para simular la solicitud de tutoría. |
| Dashboard de tracking | `9000` | Vista local para observar eventos del flujo. |
| RabbitMQ Management | `15672` | Panel disponible con usuario/contraseña local `rabbit` / `rabbit`. |
| Prometheus | `9091` | Interfaz de consultas disponible si el contenedor está activo. |
| Grafana | `3005` | Login local disponible; contraseña por defecto `local-dev-admin`. |

> Si un servicio no aparece disponible, no avance a la prueba integrada todavía. Primero revise logs, puertos ocupados, variables `.env` y estado de RabbitMQ/PostgreSQL.

## Inicializar bases de datos

Los contenedores PostgreSQL se crean vacíos. Ejecutar los siguientes scripts en cada base de datos.

### `db_auth` en puerto `5435`

Conexión:

| Campo | Valor |
| --- | --- |
| Host | `localhost` |
| Puerto | `5435` |
| Base de datos | `db_auth` |
| Usuario | `user_auth` |
| Contraseña | `password_auth` |

```sql
CREATE TABLE users (
    id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    passwordHash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL
);

INSERT INTO users (id, username, passwordHash, name, role) VALUES
('e12345', 'ana.torres', '$2a$10$l9BWZgXLWxnVg.3B74PNi.0CTb93Wsin/XzzqGJLKT0/NrT7epiSm', 'Ana Torres', 'student'),
('t09876', 'elena.solano', '$2a$10$gKxWS9CIu7QUq9ySaw6cSuns8gXvY/x/ynjj/X.giRWgN4jBuQ46W', 'Dra. Elena Solano', 'tutor');
```

> Los hashes de ejemplo corresponden a las contraseñas demo `password_ana` y `password_elena` (bcrypt). Reemplázalos por hashes propios antes de cualquier uso fuera de desarrollo local.

### `db_usuarios` en puerto `5432`

Conexión:

| Campo | Valor |
| --- | --- |
| Host | `localhost` |
| Puerto | `5432` |
| Base de datos | `db_usuarios` |
| Usuario | `user_usuarios` |
| Contraseña | `password_usuarios` |

```sql
CREATE TABLE estudiantes (
    id VARCHAR(50) PRIMARY KEY,
    nombreCompleto VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    carrera VARCHAR(255)
);

CREATE TABLE tutores (
    id VARCHAR(50) PRIMARY KEY,
    nombreCompleto VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    especialidad VARCHAR(255)
);

INSERT INTO estudiantes (id, nombreCompleto, email, carrera) VALUES
('e12345', 'Ana Torres', 'ana.torres@universidad.edu', 'Ingeniería de Software'),
('e67890', 'Luis Garcia', 'luis.garcia@universidad.edu', 'Medicina');

INSERT INTO tutores (id, nombreCompleto, email, especialidad) VALUES
('t54321', 'Dr. Carlos Rojas', 'carlos.rojas@universidad.edu', 'Bases de Datos Avanzadas'),
('t09876', 'Dra. Elena Solano', 'elena.solano@universidad.edu', 'Cálculo Multivariable');
```

### `db_agenda` en puerto `5433`

Conexión:

| Campo | Valor |
| --- | --- |
| Host | `localhost` |
| Puerto | `5433` |
| Base de datos | `db_agenda` |
| Usuario | `user_agenda` |
| Contraseña | `password_agenda` |

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE bloqueos (
    idBloqueo UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idTutor VARCHAR(50) NOT NULL,
    fechaInicio TIMESTAMPTZ NOT NULL,
    duracionMinutos INTEGER NOT NULL,
    idEstudiante VARCHAR(50) NOT NULL,
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_bloqueos_tutor_fecha_inicio UNIQUE (idTutor, fechaInicio)
);

CREATE INDEX idx_bloqueos_idTutor ON bloqueos(idTutor);

INSERT INTO bloqueos (idTutor, fechaInicio, duracionMinutos, idEstudiante) VALUES
('t54321', '2025-10-22T10:00:00.000Z', 60, 'e12345');
```

### `db_tutorias` en puerto `5434`

Conexión:

| Campo | Valor |
| --- | --- |
| Host | `localhost` |
| Puerto | `5434` |
| Base de datos | `db_tutorias` |
| Usuario | `user_tutorias` |
| Contraseña | `password_tutorias` |

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tutorias (
    idTutoria UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idEstudiante VARCHAR(50) NOT NULL,
    idTutor VARCHAR(50) NOT NULL,
    materia VARCHAR(255),
    fecha TIMESTAMPTZ NOT NULL,
    estado VARCHAR(50) NOT NULL CHECK (estado IN ('PENDIENTE', 'CONFIRMADA', 'FALLIDA', 'CANCELADA')),
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    error VARCHAR(500),
    idempotencyKey VARCHAR(255) UNIQUE
);

CREATE INDEX idx_tutorias_idEstudiante ON tutorias(idEstudiante);
CREATE INDEX idx_tutorias_idTutor ON tutorias(idTutor);
CREATE INDEX idx_tutorias_estado ON tutorias(estado);

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updatedAt = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_timestamp
BEFORE UPDATE ON tutorias
FOR EACH ROW
EXECUTE PROCEDURE trigger_set_timestamp();

-- Patrón outbox (D2): la confirmación de la tutoría y el encolado de su notificación se
-- confirman en la misma transacción (ver tutoria.repository.js#save + outbox.repository.js). Un
-- poller en ms-tutorias (outbox.publisher.js) publica las filas PENDIENTE en
-- notificaciones_email_queue.
CREATE TABLE tutorias_notificaciones_outbox (
    idOutbox UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idTutoria UUID NOT NULL REFERENCES tutorias(idTutoria),
    payload JSONB NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'PUBLICADO', 'FALLIDO')),
    intentos INTEGER NOT NULL DEFAULT 0,
    createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    publishedAt TIMESTAMPTZ,
    ultimoError VARCHAR(500)
);

CREATE INDEX idx_outbox_estado ON tutorias_notificaciones_outbox(estado);

-- Compensación de agenda pendiente (D6): si el loop de reintentos síncronos de
-- tutoria.service.js agota sus intentos al desbloquear agenda, se registra aquí (misma
-- transacción que el UPDATE a FALLIDA) en vez de solo publicarse a una cola sin consumidor. Un
-- worker en ms-tutorias (compensacion.worker.js) reclama las filas PENDIENTE y reintenta
-- agendaClient.cancelarBloqueo en segundo plano.
CREATE TABLE compensaciones_pendientes (
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

CREATE INDEX idx_compensaciones_pendientes_estado ON compensaciones_pendientes(estado);
```

> `POST /v1/tutorias` exige el header `Idempotency-Key`; `ms-tutorias` la persiste en la columna
> `idempotencyKey` para deduplicar reintentos. Si `db_tutorias` ya existe de una instalación previa (sin esta
> columna), aplicar manualmente en vez de recrear la tabla:
>
> ```sql
> ALTER TABLE tutorias ADD COLUMN idempotencyKey VARCHAR(255) UNIQUE;
> ```

> Si `db_tutorias` ya existe de una instalación previa (sin la tabla `tutorias_notificaciones_outbox` del
> patrón outbox), aplicar manualmente en vez de recrear la base:
>
> ```sql
> CREATE TABLE tutorias_notificaciones_outbox (
>     idOutbox UUID PRIMARY KEY DEFAULT gen_random_uuid(),
>     idTutoria UUID NOT NULL REFERENCES tutorias(idTutoria),
>     payload JSONB NOT NULL,
>     estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'PUBLICADO', 'FALLIDO')),
>     intentos INTEGER NOT NULL DEFAULT 0,
>     createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
>     publishedAt TIMESTAMPTZ,
>     ultimoError VARCHAR(500)
> );
>
> CREATE INDEX idx_outbox_estado ON tutorias_notificaciones_outbox(estado);
> ```

> Si `db_tutorias` ya existe de una instalación previa (sin la tabla `compensaciones_pendientes`), aplicar
> manualmente en vez de recrear la base:
>
> ```sql
> CREATE TABLE compensaciones_pendientes (
>     idCompensacion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
>     idBloqueo UUID NOT NULL,
>     idTutoria UUID NOT NULL REFERENCES tutorias(idTutoria),
>     idTutor VARCHAR(50) NOT NULL,
>     correlationId VARCHAR(255),
>     motivo VARCHAR(500),
>     estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'RESUELTO', 'FALLIDO')),
>     intentos INTEGER NOT NULL DEFAULT 0,
>     createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
>     resolvedAt TIMESTAMPTZ,
>     ultimoError VARCHAR(500)
> );
>
> CREATE INDEX idx_compensaciones_pendientes_estado ON compensaciones_pendientes(estado);
> ```

## Verificar accesos

| Recurso | URL | Resultado esperado |
| --- | --- | --- |
| Cliente web | <http://localhost:8080> | Formulario para solicitar tutorías. |
| Dashboard de tracking | <http://localhost:9000> | Carriles/listado de eventos listo para recibir trazas. |
| RabbitMQ Management | <http://localhost:15672> | Panel local disponible con usuario/contraseña por defecto `rabbit` / `rabbit`, sobreescribible por entorno. |
| Prometheus | <http://localhost:9091> | Interfaz local de consultas disponible si el contenedor está activo. |
| Grafana | <http://localhost:3005> | Login local disponible; contraseña por defecto `local-dev-admin`, sobreescribible por entorno. |

En RabbitMQ Management, revisar que la cola `notificaciones_email_queue` tenga consumidor activo cuando `ms-notificaciones` esté corriendo.

## Prueba mínima guiada

1. Abrir el cliente web en `http://localhost:8080`.
2. Abrir el dashboard en `http://localhost:9000`.
3. Obtener un token desde el cliente o desde el endpoint de autenticación expuesto por `ms-auth`.
4. Solicitar una tutoría con datos existentes en la base seed, por ejemplo:
   - estudiante: `e12345`;
   - tutor: `t54321`;
   - materia: una materia relacionada con el tutor;
   - fecha: un horario disponible distinto del bloqueo seed `2025-10-22T10:00:00.000Z`.
5. Verificar que el cliente recibe una respuesta con estado `CONFIRMADA`.
6. Revisar el dashboard para seguir los eventos entre servicios.
7. Revisar RabbitMQ Management y confirmar que la cola `notificaciones_email_queue` tenga consumidor activo o actividad asociada al flujo.
8. Revisar logs de los servicios relevantes para identificar la secuencia: autenticación, validación de usuario/tutor, bloqueo de agenda, registro de tutoría y notificación.
9. Opcional: si se usa un cliente HTTP externo, enviar un `X-Correlation-ID` propio para rastrear la solicitud en logs y eventos.
10. Si se usa un cliente HTTP externo (no `client-mobile-sim`), enviar también el header `Idempotency-Key` (cualquier valor único por solicitud); sin este header `ms-tutorias` responde `400`.

## Casos de comprobación local

| Caso | Acción sugerida | Resultado esperado |
| --- | --- | --- |
| Token | Obtener token mediante cliente o `ms-auth`. | Existe un JWT para invocar operaciones protegidas. |
| Happy path | Solicitar tutoría con estudiante y tutor seed en un horario disponible. | Respuesta `CONFIRMADA`, registro en `db_tutorias` y bloqueo nuevo en `db_agenda`. |
| Conflicto `409` | Intentar reservar el horario seed ya bloqueado para `t54321` en `2025-10-22T10:00:00.000Z` o repetir una reserva ya ocupada. | Respuesta de conflicto `409`; no debe duplicarse el bloqueo. |
| RabbitMQ | Observar `notificaciones_email_queue` y logs de `ms-notificaciones`. | Consumidor activo y evidencia de procesamiento de notificación/evento. |
| Métricas | Abrir Prometheus o consultar endpoints de métricas cuando estén disponibles. | Señales operativas visibles para sustentar observabilidad local. |

Estos casos no son un solucionario de PC03. Sirven para llegar al examen con evidencias concretas y evitar respuestas genéricas desconectadas del sistema.

## Pruebas de resiliencia

Para pruebas de conflicto `409`, DLQ, Circuit Breaker y Saga compensation, no improvisar fallas manuales. La evidencia académica se consolida en [`docs/pc03.md`](./pc03.md). Los detalles operativos se distribuyen en documentos especializados:

- [`docs/event-contracts.md`](./event-contracts.md) para colas, eventos y DLQ.
- [`docs/observability-runbook.md`](./observability-runbook.md) para diagnóstico, logs, métricas y fallas inducidas.
- [`docs/audit-compliance-matrix.md`](./audit-compliance-matrix.md) para criterios de evidencia, cierre y brechas.

La prueba de Saga compensation requiere activar explícitamente `ENABLE_DEMO_FAULT_INJECTION=true` y enviar el header `X-Demo-Fail-After-Bloqueo: true`. Sin ambas condiciones, el flujo normal no debe alterarse.

## Problemas frecuentes

| Problema | Señal típica | Qué revisar o corregir |
| --- | --- | --- |
| Docker no está ejecutándose | `docker compose` no conecta con el daemon. | Abrir Docker Desktop y esperar a que indique estado listo. |
| Puertos ocupados | Algún contenedor no arranca o aparece error de bind. | Liberar los puertos usados por esta guía o ajustar temporalmente el mapeo local. |
| Base de datos vacía o no inicializada | Estudiantes/tutores no existen o la tutoría falla por datos ausentes. | Ejecutar los scripts SQL de `db_usuarios`, `db_agenda` y `db_tutorias` en la base correcta. |
| RabbitMQ aún no está listo | Servicios reportan errores de conexión AMQP al inicio. | Esperar unos segundos, revisar logs y confirmar RabbitMQ Management en `http://localhost:15672`. |
| Token faltante o expirado | La API responde error de autenticación/autorización. | Obtener un token nuevo desde el cliente o `ms-auth` y reenviar la solicitud. |
| Toxiproxy o fault injection quedó activo | Fallas inesperadas al consultar usuarios o completar la saga. | Revisar configuración de Toxiproxy y desactivar headers/variables de inyección de fallas usados en pruebas. |
| Volúmenes con datos obsoletos | Los datos no coinciden con los scripts o persisten conflictos anteriores. | Usar `docker compose down -v` solo de forma intencional, sabiendo que elimina datos persistidos. Luego reinicializar las bases. |

## Limpieza básica

Para detener contenedores sin eliminar volúmenes:

```bash
docker compose down
```

Para eliminar también datos persistidos de PostgreSQL y RabbitMQ:

```bash
docker compose down -v
```

Usar `down -v` solo cuando se quiera reiniciar completamente el entorno local.

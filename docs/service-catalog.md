# Catálogo de Servicios — Tutorías Universitarias

Este catálogo consolida los servicios del caso transversal para cerrar la evidencia mínima de los bloques previos y servir como base de trabajo para el bloque de implementación, operación, resiliencia, observabilidad y gobierno de servicios.

## Ruta rápida

1. Use la tabla de servicios para explicar responsabilidad, límites y ownership.
2. Use el mapa de integración para justificar comunicación síncrona, asíncrona y orquestación.
3. Use la sección de evidencia académica para sustentar bloques previos y preparar el bloque de implementación y operación.

## Inventario de servicios

| Servicio / componente | Responsabilidad principal | Capacidad de negocio | Endpoints / entrypoints | Datos propios | Dependencias | Comunicación | NFR / resiliencia | Evidencia |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ms-auth` | Autenticar usuarios y emitir JWT. | Acceso seguro al sistema. | `POST /auth/token` | Usuarios demo en memoria. | Ninguna dependencia funcional crítica. | HTTP síncrono. | JWT para autenticación; secreto por variable de entorno. | `ms-auth/src/app.js`, `ms-auth/src/api/routes/auth.routes.js`, `ms-auth/src/infrastructure/repositories/user.repository.js` |
| `ms-usuarios` | Consultar estudiantes y tutores. | Gestión de identidad académica consultable. | `GET /usuarios/estudiantes/:id`, `GET /usuarios/tutores/:id` | `db_usuarios`: `estudiantes`, `tutores`. | PostgreSQL, RabbitMQ para tracking. | HTTP síncrono; eventos de trazabilidad. | Mensajes explícitos si falta inicialización de BD; métricas HTTP. | `ms-usuarios/src/app.js`, `ms-usuarios/src/api/routes/usuarios.routes.js`, `ms-usuarios/src/infrastructure/repositories/usuarios.repository.js`, `ms-usuarios/docs/swagger.yaml` |
| `ms-agenda` | Verificar disponibilidad y bloquear/liberar horarios. | Gestión de disponibilidad de tutores. | `GET /agenda/tutores/:id_tutor/disponibilidad`, `POST /agenda/tutores/:id_tutor/bloquear`, `DELETE /agenda/bloqueos/:idBloqueo` | `db_agenda`: `bloqueos`. | PostgreSQL, RabbitMQ para tracking. | HTTP síncrono; eventos de trazabilidad. | `UNIQUE(idTutor, fechaInicio)` evita doble reserva; `23505` se traduce a `409 Conflict`; endpoint de compensación. | `ms-agenda/src/api/routes/agenda.routes.js`, `ms-agenda/src/api/controllers/agenda.controller.js`, `ms-agenda/src/infrastructure/repositories/agenda.repository.js`, `ms-agenda/docs/swagger.yaml` |
| `ms-tutorias` | Orquestar la solicitud de tutoría. | Solicitud y confirmación de tutorías. | `POST /v1/tutorias` | `db_tutorias`: `tutorias`. | `ms-auth`, `ms-usuarios`, `ms-agenda`, RabbitMQ, PostgreSQL. | HTTP síncrono hacia usuarios/agenda; publicación asíncrona a cola de notificaciones; eventos de tracking. | Saga orquestada, compensación de agenda, Circuit Breaker hacia `ms-usuarios` y hacia `ms-agenda` (verificar/bloquear; `cancelarBloqueo` fuera del breaker, retry propio), timeout de 1.5s, propagación de `409`. | `ms-tutorias/src/domain/services/tutoria.service.js`, `ms-tutorias/src/infrastructure/clients/*.js`, `ms-tutorias/src/infrastructure/messaging/message.producer.js`, `ms-tutorias/docs/swagger.yaml` |
| `ms-notificaciones` | Consumir solicitudes de notificación y simular envío. | Comunicación con el estudiante. | Worker RabbitMQ; API base `/notificaciones` para extensiones. | No persiste datos de negocio; genera logs de envío simulado. | RabbitMQ. | Consumo asíncrono desde `notificaciones_email_queue`. | DLQ con `notificaciones_dlx` y `notificaciones_dlq`; `ack` en éxito, `nack(false, false)` en fallo. | `ms-notificaciones/src/app.js`, `ms-notificaciones/src/domain/services/notificacion.service.js`, `ms-notificaciones/docs/swagger.yaml` |
| `tracking-dashboard` | Mostrar trazabilidad de la Saga en vivo. | Observabilidad operativa para diagnóstico. | UI web en `:9000`; Socket.IO. | No posee datos transaccionales. | RabbitMQ exchange `tracking_events_exchange`. | Suscripción asíncrona a eventos de tracking. | Visualización por servicio y correlation id. | `tracking-dashboard/src/server.js`, `tracking-dashboard/public/index.html` |
| `client-mobile-sim` | Simular el cliente móvil/web. | Punto de entrada del usuario final. | UI en `:8080`. | No posee datos propios. | `ms-auth`, `ms-tutorias`. | HTTP síncrono. | Muestra resultado de solicitud y errores devueltos por backend. | `client-mobile-sim/src/api_client/backend.client.js`, `client-mobile-sim/public/index.html` |
| `toxiproxy` | Inyectar fallas de red controladas. | Pruebas de resiliencia. | Admin API `:8474`, proxy `:8001`. | No aplica. | `ms-usuarios`. | Proxy TCP/HTTP para `ms-tutorias -> ms-usuarios`. | Permite simular latencia y validar Circuit Breaker. | `docker-compose.yml`, `toxiproxy.json` |
| Prometheus / Grafana | Recolectar y visualizar métricas. | Operación y monitoreo. | Prometheus `:9091`, Grafana `:3005`. | Métricas operativas. | Endpoints `/metrics` de servicios. | Scraping HTTP. | Métricas HTTP y health básico. | `prometheus.yml`, `docker-compose.yml` |

## Mapa de integración

### Flujo principal síncrono

```txt
client-mobile-sim
  -> ms-auth /auth/token
  -> ms-tutorias /v1/tutorias
      -> ms-usuarios /usuarios/estudiantes/:id
      -> ms-usuarios /usuarios/tutores/:id
      -> ms-agenda /agenda/tutores/:id_tutor/disponibilidad
      -> ms-agenda /agenda/tutores/:id_tutor/bloquear
```

### Flujo asíncrono

```txt
ms-tutorias
  -> notificaciones_email_queue
  -> ms-notificaciones
```

Si el mensaje falla, RabbitMQ aplica:

```txt
notificaciones_email_queue
  -> notificaciones_dlx
  -> notificaciones_dlq
```

### Trazabilidad operativa

```txt
ms-auth / ms-usuarios / ms-agenda / ms-tutorias / ms-notificaciones
  -> tracking_events_exchange
  -> tracking-dashboard
```

El `X-Correlation-ID` permite seguir una solicitud completa entre servicios.

## Decisiones de ownership y gobierno

| Área | Estado actual | Pendiente de gobierno |
| --- | --- | --- |
| Ownership de servicios | Parcial. Los servicios están separados por responsabilidad técnica. | Asignar equipo/responsable por servicio para evidencias académicas. |
| Contratos HTTP | Cubierto mínimo para servicios públicos; `ms-notificaciones` conserva solo contrato HTTP legacy/deprecated no operativo como API pública y el flujo vigente es RabbitMQ. | Ampliar ejemplos, versionado y validación formal de contratos si se requiere para entrega final. |
| Versionado | Pendiente. No hay `/v1` ni política explícita de compatibilidad. | Definir estrategia mínima de versionado. |
| Eventos y colas | Parcial. Existen colas/exchanges claros y contratos documentados en `docs/event-contracts.md`. | Reforzar validación formal, versionado y compatibilidad de payloads si se requiere para entrega final. |
| Operación | Parcial/avanzado. Hay Docker Compose, métricas, dashboard y logs. | Consolidar evidencia académica en `docs/pc03.md` y mantener detalles operativos en setup, observabilidad y auditoría. |
| Auditoría | Parcial. Hay trazabilidad operativa y matriz inicial en `docs/audit-compliance-matrix.md`. | Completar evidencia, retención y criterios auditables si se requiere para entrega final. |

## Qué demuestra para el uso académico

| Bloque | Evidencia cubierta | Estado |
| --- | --- | --- |
| 3 — Concepto de servicio | Servicios con responsabilidad diferenciada. | Cubierto |
| 4 — Síncrono vs asíncrono | HTTP entre servicios + RabbitMQ para notificaciones/tracking. | Cubierto |
| 11 — Límites arquitectónicos | Separación por dominio: auth, usuarios, agenda, tutorías, notificaciones. | Cubierto |
| 12 — Inventario y catálogo | Este documento consolida responsabilidades, dependencias y datos. | Cubierto inicial |
| 15 — Integración síncrona | `ms-tutorias` compone usuarios y agenda. | Cubierto |
| 16 — Integración asíncrona | RabbitMQ para notificaciones y trazabilidad. | Cubierto |
| 17 — Orquestación vs coreografía | Saga orquestada en `ms-tutorias`. | Cubierto |
| 20 — Validación previa | Base para sustentar inventario, integración y decisiones. | Parcial; requiere contratos actualizados |
| Bloque de implementación, operación y gobierno | Implementación, operación, resiliencia y observabilidad. | Base técnica disponible; falta ordenar evidencias |

## Cobertura actual de contratos

| Servicio | Contrato HTTP mínimo | Nota |
| --- | --- | --- |
| `ms-auth` | `ms-auth/docs/swagger.yaml` | Documenta `POST /auth/token` y emisión de JWT. |
| `ms-usuarios` | `ms-usuarios/docs/swagger.yaml` | Documenta consultas de estudiantes y tutores. |
| `ms-agenda` | `ms-agenda/docs/swagger.yaml` | Documenta disponibilidad, bloqueo, compensación y conflicto `409`. |
| `ms-tutorias` | `ms-tutorias/docs/swagger.yaml` | Documenta `POST /v1/tutorias`, JWT Bearer, Saga y errores principales. |
| `ms-notificaciones` | `ms-notificaciones/docs/swagger.yaml` | Documenta con cautela el endpoint HTTP legacy/deprecated no operativo como API pública; el flujo principal actual es worker RabbitMQ. |

Los contratos de eventos RabbitMQ (`notificaciones_email_queue`, DLQ y eventos de tracking) están documentados en [`docs/event-contracts.md`](./event-contracts.md) con alcance prudente según el código actual.

## Próximo paso

Reforzar la política mínima de versionado/compatibilidad de APIs y, si aplica, agregar validación formal de payloads de eventos.

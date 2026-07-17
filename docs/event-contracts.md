# Contratos de eventos RabbitMQ

Este documento resume los contratos RabbitMQ identificados en el código y la configuración actuales. Su objetivo es facilitar revisión técnica sin asumir contratos que todavía no están formalizados.

## Ruta rápida de revisión

1. Validar que `docker-compose.yml` expone RabbitMQ y configura `RABBITMQ_URL` en los servicios que publican o consumen eventos.
2. Revisar que los productores declaren el exchange o la cola antes de publicar.
3. Revisar que `ms-notificaciones` consuma `notificaciones_email_queue` con `ack` en éxito y `nack(false, false)` en error.
4. Revisar que el dashboard consuma `tracking_events_exchange` y emita los eventos por Socket.IO.

## Resumen de cobertura

| Área | Estado | Evidencia principal | Observación |
| --- | --- | --- | --- |
| Broker RabbitMQ en entorno local | Implementado | `docker-compose.yml` | Servicio `rabbitmq` con AMQP `5672`, Management `15672` y credenciales locales. |
| Cola de notificaciones | Implementado | `ms-tutorias/src/infrastructure/messaging/message.producer.js`, `ms-notificaciones/src/app.js` | Publicación a cola durable `notificaciones_email_queue` vía el poller del patrón outbox (ver `outbox.publisher.js`), no directo desde la Saga. |
| DLX/DLQ de notificaciones | Implementado | `ms-notificaciones/src/app.js`, `ms-tutorias/src/infrastructure/messaging/message.producer.js` | DLX `notificaciones_dlx` y DLQ `notificaciones_dlq` configuradas para mensajes rechazados. |
| Eventos de tracking | Parcial | Productores de `ms-usuarios`, `ms-agenda`, `ms-tutorias`, `ms-notificaciones`; `tracking-dashboard/src/server.js` | Existe payload común por convención de código, pero sin schema formal ni versionado. |
| Validación formal de payloads | Parcial | `ms-notificaciones/src/domain/services/notificacion.service.js` | Se validan campos requeridos en runtime para email; no hay JSON Schema/OpenAPI/AsyncAPI. |
| Versionado de contratos | Pendiente | No se observan campos `version` ni namespaces versionados | Riesgo de cambios incompatibles silenciosos. |

## Exchanges conocidos

| Exchange | Tipo | Durable | Productores | Consumidores | Estado | Evidencia |
| --- | --- | --- | --- | --- | --- | --- |
| `tracking_events_exchange` | `fanout` | Sí | `ms-usuarios`, `ms-agenda`, `ms-tutorias`, `ms-notificaciones` | `tracking-dashboard` mediante cola anónima exclusiva | Implementado/parcial | `assertExchange(EXCHANGE_NAME, 'fanout', { durable: true })` en productores y dashboard. |
| `notificaciones_dlx` | `direct` | Sí | RabbitMQ al rechazar mensajes de la cola principal | `notificaciones_dlq` | Implementado | `ms-notificaciones/src/app.js` declara exchange, DLQ y binding. |

No se observó un exchange de negocio para notificaciones. El flujo vigente publica directamente a la cola `notificaciones_email_queue`.

## Colas conocidas

| Cola | Tipo/propiedad | Productor | Consumidor | Estado | Evidencia |
| --- | --- | --- | --- | --- | --- |
| `notificaciones_email_queue` | Durable, mensajes persistentes desde `ms-tutorias` | `ms-tutorias` (poller de outbox) | `ms-notificaciones` | Implementado | `outbox.publisher.js` llama `publishToQueue('notificaciones_email_queue', row.payload)` para cada fila `PENDIENTE` de `tutorias_notificaciones_outbox`; `channel.consume(queueName, ...)` en `ms-notificaciones` sin cambios. |
| `notificaciones_dlq` | Durable, vinculada a `notificaciones_dlx` con routing key `notificaciones_dlq` | RabbitMQ por dead-letter | Revisión manual/operativa; no hay consumidor automático en código | Implementado/parcial | `assertQueue(dlqName, { durable: true })` y `bindQueue(dlqName, dlxName, dlqName)`. |
| Cola anónima exclusiva del dashboard | Exclusiva, nombre generado por RabbitMQ | `tracking_events_exchange` | `tracking-dashboard` | Implementado | `assertQueue('', { exclusive: true })` y `bindQueue(queue, EXCHANGE_NAME, '')`. |

`agenda_compensacion_pendiente_queue` **fue reemplazada** (D6) por la tabla `compensaciones_pendientes` en
`db_tutorias` + un worker con reintentos (`compensacion.worker.js`) — ver la sección "Compensación de agenda
pendiente" más abajo. La cola nunca tuvo consumidor automático; el mecanismo actual sí reintenta activamente.

## DLQ y DLX

El contrato de dead-letter aplica a la cola principal de notificaciones:

```txt
notificaciones_email_queue
  -- nack(false, false) / reject sin requeue --> notificaciones_dlx
  -- routing key: notificaciones_dlq --> notificaciones_dlq
```

Configuración esperada:

| Elemento | Valor |
| --- | --- |
| Cola principal | `notificaciones_email_queue` |
| Dead-letter exchange | `notificaciones_dlx` |
| Dead-letter routing key | `notificaciones_dlq` |
| Cola dead-letter | `notificaciones_dlq` |
| Requeue en error | `false` |
| Confirmación en éxito | `ack(msg)` |
| Confirmación en error | `nack(msg, false, false)` |

Estado: **implementado** para aislamiento de mensajes inválidos o fallidos. **Parcial** para operación, porque no hay consumidor, retry controlado ni política documentada de inspección/vaciado de DLQ.

## Productores y consumidores

| Componente | Rol | Canal RabbitMQ | Estado | Evidencia |
| --- | --- | --- | --- | --- |
| `ms-tutorias` | Productor de notificaciones | `notificaciones_email_queue` | Implementado | `tutoria.service.js` construye `payloadNotificacion` y lo encola en `tutorias_notificaciones_outbox` (misma transacción que el `UPDATE` a `CONFIRMADA`); `outbox.publisher.js` (poller) publica con `sendToQueue` vía `message.producer.js`. |
| `ms-tutorias` | Productor de tracking | `tracking_events_exchange` | Implementado/parcial | Publica eventos de avance, errores, compensaciones y Circuit Breaker. |
| `ms-usuarios` | Productor de tracking | `tracking_events_exchange` | Implementado/parcial | Controlador publica búsquedas, éxitos y errores. |
| `ms-agenda` | Productor de tracking | `tracking_events_exchange` | Implementado/parcial | Controlador publica disponibilidad, bloqueo, conflictos y compensación. |
| `ms-notificaciones` | Consumidor de notificaciones | `notificaciones_email_queue` | Implementado | `startConsumer()` parsea JSON, procesa email simulado y confirma o rechaza. |
| `ms-notificaciones` | Productor de tracking | `tracking_events_exchange` | Implementado/parcial | Servicio publica procesamiento, envío simulado y errores. |
| `tracking-dashboard` | Consumidor de tracking | `tracking_events_exchange` | Implementado/parcial | Crea cola exclusiva, consume con `noAck: true` y emite `tracking_event` por Socket.IO. |

## Payloads conocidos

### Notificación por email

Canal: `notificaciones_email_queue`.

Estado: **implementado/parcial**. El payload se construye en `ms-tutorias` y se valida de forma imperativa en `ms-notificaciones`, pero no existe schema formal.

Payload mínimo esperado:

```json
{
  "destinatario": "usuario@example.com",
  "asunto": "Texto del asunto",
  "cuerpo": "Contenido del mensaje",
  "correlationId": "uuid-o-identificador-correlacionado"
}
```

| Campo | Tipo esperado | Requerido | Uso actual | Evidencia |
| --- | --- | --- | --- | --- |
| `destinatario` | string | Sí | Dirección destino del email simulado. | `notificacion.service.js` valida que exista. |
| `asunto` | string | Sí | Asunto del email simulado. | `notificacion.service.js` valida que exista. |
| `cuerpo` | string | Sí | Cuerpo del email simulado. | `notificacion.service.js` valida que exista. |
| `correlationId` | string | Recomendado | Correlación con la solicitud original y eventos de tracking. | `tutoria.service.js` lo envía; `notificacion.service.js` genera uno si falta. |

Comportamiento esperado:

- Si el payload es válido, `ms-notificaciones` ejecuta el envío simulado y confirma con `ack`.
- Si falta `destinatario`, `asunto` o `cuerpo`, el procesamiento falla y el consumidor rechaza el mensaje sin reencolarlo.
- El mensaje rechazado debe terminar en `notificaciones_dlq` por la configuración de dead-letter.

### Evento de tracking

Canal: `tracking_events_exchange`.

Estado: **parcial**. Existe estructura común en los productores y consumo en dashboard, pero no hay schema formal, versionado ni validación.

Payload mínimo observado:

```json
{
  "service": "MS_Tutorias",
  "message": "Descripción del evento",
  "cid": "uuid-o-identificador-correlacionado",
  "timestamp": "2026-06-24T00:00:00.000Z",
  "status": "INFO",
  "idempotencyKey": "string-o-null"
}
```

| Campo | Tipo esperado | Requerido de facto | Uso actual | Evidencia |
| --- | --- | --- | --- | --- |
| `service` | string | Sí | Selecciona el carril visual del dashboard. | `tracking-dashboard/public/index.html` usa `lanes[evento.service]`. |
| `message` | string | Sí | Texto mostrado en la burbuja del evento. | Dashboard renderiza `evento.message`. |
| `cid` | string | Sí | Agrupa eventos por transacción y color. | Dashboard ejecuta `evento.cid.substring(...)`. |
| `timestamp` | date/string serializado | Parcial | Se publica, pero el dashboard actual no lo muestra. | Productores envían `new Date()`. |
| `status` | string (`INFO`/`ERROR` observado) | Parcial | Marca visualmente errores si vale `ERROR`. | Dashboard agrega clase `error` cuando `evento.status === 'ERROR'`. |
| `idempotencyKey` | string o `null` | Parcial, solo `ms-tutorias` | Permite filtrar en el dashboard todos los eventos de una misma solicitud (incluyendo reintentos/short-circuits idempotentes). | `tutoria.service.js` la incluye en cada `track(...)`; `ms-usuarios`, `ms-agenda` y `ms-notificaciones` no la conocen y no la publican. Dashboard la muestra en la burbuja y permite filtrar con el input `#idempotency-filter`. |

Servicios observados en eventos de tracking:

| Valor `service` | Productor | Estado |
| --- | --- | --- |
| `MS_Usuarios` | `ms-usuarios` | Implementado |
| `MS_Agenda` | `ms-agenda` | Implementado |
| `MS_Tutorias` | `ms-tutorias` | Implementado |
| `MS_Notificaciones` | `ms-notificaciones` | Implementado |

### Compensación de agenda pendiente (tabla, no cola)

Tabla: `compensaciones_pendientes` en `db_tutorias` (reemplaza a la antigua `agenda_compensacion_pendiente_queue`,
que nunca tuvo consumidor; ver D6).

Estado: **implementado**. Cuando el loop de reintentos síncronos de `tutoria.service.js` agota
`COMPENSACION_AGENDA_MAX_INTENTOS` intentando `agendaClient.cancelarBloqueo`, se inserta una fila `PENDIENTE`
en esta tabla dentro de la **misma transacción** que el `UPDATE` a `FALLIDA` (mismo mecanismo que el outbox de
notificaciones, ver `tutoria.repository.js#save()` + `compensacion.repository.js`) -- si el `UPDATE` no afecta
ninguna fila, tampoco se inserta el registro de compensación pendiente. Un worker en el mismo proceso
(`ms-tutorias/src/infrastructure/workers/compensacion.worker.js`, `setInterval` cada
`COMPENSACION_PENDIENTE_POLL_INTERVAL_MS`, default 5000ms) reclama filas `PENDIENTE` con
`SELECT ... FOR UPDATE SKIP LOCKED` y reintenta `agendaClient.cancelarBloqueo`; en éxito marca `RESUELTO`, en
fallo incrementa `intentos` y, tras `COMPENSACION_PENDIENTE_MAX_INTENTOS` (default 3), pasa a `FALLIDO`
(revisión manual) e incrementa la métrica `compensacion_fallida_total{etapa="worker"}`.

Columnas:

| Campo | Tipo | Uso |
| --- | --- | --- |
| `idCompensacion` | UUID | Identificador de la fila. |
| `idBloqueo` | UUID | Bloqueo de agenda que quedó sin cancelar. |
| `idTutoria` | UUID | Referencia a la tutoría marcada `FALLIDA` que originó la compensación. |
| `idTutor` | string | Tutor afectado por el bloqueo huérfano. |
| `correlationId` | string | Correlación con logs y eventos de tracking de la solicitud original. |
| `motivo` | string | Mensaje del último error síncrono de `agendaClient.cancelarBloqueo`. |
| `estado` | `PENDIENTE`/`RESUELTO`/`FALLIDO` | Ciclo de vida de la fila. |
| `intentos` | integer | Cantidad de reintentos del worker realizados. |
| `ultimoError` | string | Último error de reintento registrado por el worker. |
| `resolvedAt` | timestamp | Momento en que el worker resolvió la compensación. |

`SKIP LOCKED` evita que dos ticks del worker (uno solapado con el anterior, o dos instancias del servicio en
el futuro) procesen la misma fila dos veces; el guard `isRunning` en memoria evita además que el mismo proceso
solape ticks entre sí. Ver también `compensacion_fallida_total` en el runbook de observabilidad para la
métrica/alerta asociada.

### Outbox de notificaciones (patrón outbox)

Tabla: `tutorias_notificaciones_outbox` en `db_tutorias` (no es un canal RabbitMQ, es la fuente de verdad
intermedia entre la Saga y `notificaciones_email_queue`).

Estado: **implementado**. `tutoria.service.js` ya no publica directo a `notificaciones_email_queue`; en su lugar,
`tutoria.repository.js#save()` inserta una fila `PENDIENTE` en esta tabla dentro de la misma transacción que el
`UPDATE` a `CONFIRMADA` (ver `ms-tutorias/src/config/db.js#withTransaction`) -- si el `UPDATE` no afecta ninguna
fila (transición inválida), la fila de outbox tampoco se inserta. Un poller en el mismo proceso
(`ms-tutorias/src/infrastructure/messaging/outbox.publisher.js`, `setInterval` cada `OUTBOX_POLL_INTERVAL_MS`,
default 3000ms) reclama filas `PENDIENTE` con `SELECT ... FOR UPDATE SKIP LOCKED` y llama a `publishToQueue`; en
éxito marca `PUBLICADO`, en fallo incrementa `intentos` y, tras `OUTBOX_MAX_INTENTOS` (default 5), pasa a
`FALLIDO` (revisión manual, mismo espíritu que `notificaciones_dlq` y `compensaciones_pendientes`).

Columnas:

| Campo | Tipo | Uso |
| --- | --- | --- |
| `idOutbox` | UUID | Identificador de la fila. |
| `idTutoria` | UUID | Referencia a la tutoría confirmada que originó la notificación. |
| `payload` | JSONB | El mismo `payloadNotificacion` que antes se publicaba directo (`destinatario`, `asunto`, `cuerpo`, `correlationId`). |
| `estado` | `PENDIENTE`/`PUBLICADO`/`FALLIDO` | Ciclo de vida de la fila. |
| `intentos` | integer | Cantidad de intentos de publicación fallidos. |
| `ultimoError` | string | Último error de publicación registrado. |
| `publishedAt` | timestamp | Momento en que se publicó exitosamente. |

`SKIP LOCKED` evita que dos ticks del poller (uno solapado con el anterior, o dos instancias del servicio en el
futuro) procesen la misma fila dos veces; el guard `isRunning` en memoria evita además que el mismo proceso
solape ticks entre sí.

## Evidencia esperada de cableado

| Revisión | Evidencia esperada | Estado |
| --- | --- | --- |
| RabbitMQ disponible en local | `docker-compose.yml` define servicio `rabbitmq`, puertos `5672` y `15672`, usuario `rabbit`. | Implementado |
| Servicios con URL del broker | `RABBITMQ_URL=amqp://rabbit:rabbit@rabbitmq:5672` en servicios productores/consumidores. | Implementado |
| Exchange de tracking declarado | Productores y dashboard ejecutan `assertExchange('tracking_events_exchange', 'fanout', { durable: true })`. | Implementado |
| Cola de notificaciones declarada por productor | `ms-tutorias` ejecuta `assertQueue('notificaciones_email_queue', ...)` antes de publicar. | Implementado |
| Cola de notificaciones declarada por consumidor | `ms-notificaciones` ejecuta `assertQueue(queueName, { durable, deadLetterExchange, deadLetterRoutingKey })`. | Implementado |
| DLQ configurada | `notificaciones_dlx`, `notificaciones_dlq` y binding declarados en `ms-notificaciones`. | Implementado |
| Mensajes inválidos aislados | En error, consumidor ejecuta `nack(msg, false, false)`. | Implementado |
| Eventos visibles en dashboard | `tracking-dashboard` consume el exchange y emite `tracking_event`. | Implementado/parcial |

## Riesgos y pendientes

- **Pendiente:** no hay contratos AsyncAPI, JSON Schema ni validación formal de payloads RabbitMQ.
- **Pendiente:** no hay campo `version` en los eventos ni política explícita de compatibilidad.
- **Riesgo:** el dashboard asume que `cid` existe; un evento sin `cid` puede fallar al renderizar por `substring`.
- **Riesgo:** los productores de tracking (`publishTrackingEvent`) no esperan confirmación de publicación ni
  usan publisher confirms -- alcance no crítico, es solo el canal de observabilidad, no de negocio.
- **Resuelto:** `publishToQueue` (usada para `notificaciones_email_queue`, la cola de negocio) ahora corre sobre
  un confirm channel (`connection.createConfirmChannel()`) y solo retorna `true` tras el ack real del broker en
  `sendToQueue`, no apenas se escribe en el socket TCP. Además, ya no es el único punto de fallo para la
  notificación de una tutoría confirmada: el patrón outbox (ver arriba) garantiza que la intención de notificar
  quedó persistida de forma atómica con el `UPDATE` a `CONFIRMADA`, y el poller reintenta hasta
  `OUTBOX_MAX_INTENTOS`.
- **Resuelto:** `notificaciones_dlq` ya tiene un camino de replay controlado:
  `ms-notificaciones/scripts/reencolar-dlq.js` (`npm run reencolar-dlq`) toma los mensajes que haya en la DLQ en
  el momento en que corre y los republica en `notificaciones_email_queue`, confirmando (`ack`) su salida de la
  DLQ solo después de republicarlos exitosamente.
- **Resuelto:** los bloqueos de agenda no compensados ya no dependen de una cola sin consumidor
  (`agenda_compensacion_pendiente_queue`, reemplazada); la tabla `compensaciones_pendientes` + el worker
  reintentan activamente y exponen la métrica `compensacion_fallida_total`. Las filas que terminan en `FALLIDO`
  tras agotar los reintentos del worker ahora tienen un camino de replay manual:
  `ms-tutorias/scripts/reintentar-fallidos.js --compensaciones` (`npm run reintentar-fallidos -- --compensaciones`)
  las reabre a `PENDIENTE` para que el worker las vuelva a tomar.
- **Resuelto:** el poller del outbox de notificaciones (`outbox.publisher.js`) tenía las filas que llegan a
  `FALLIDO` tras agotar `OUTBOX_MAX_INTENTOS` varadas para revisión manual directa en la base. Ahora
  `ms-tutorias/scripts/reintentar-fallidos.js --outbox` (`npm run reintentar-fallidos -- --outbox`) las reabre a
  `PENDIENTE` para que el poller normal las vuelva a intentar.
- **Parcial:** `timestamp` se publica en tracking, pero no se usa como criterio de orden ni se muestra en el dashboard.
- **Pendiente:** no hay pruebas automatizadas específicas para contrato de cola, DLQ o estructura de eventos de tracking.

## Próximo paso recomendado

Formalizar estos contratos en un artefacto verificable, preferiblemente AsyncAPI o JSON Schema mínimo, y agregar una prueba de integración o contrato que cubra:

- publicación de `payloadNotificacion` válido;
- rechazo de payload incompleto hacia `notificaciones_dlq`;
- evento de tracking con `service`, `message`, `cid`, `timestamp` y `status`.

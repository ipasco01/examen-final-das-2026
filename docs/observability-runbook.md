# Runbook de observabilidad

Este runbook define qué observar durante el flujo de solicitud de tutoría, cómo correlacionar evidencia entre servicios y qué brechas siguen abiertas. La guía está pensada para validación técnica y diagnóstico básico; no reemplaza una plataforma formal de monitoreo, alertas ni trazas distribuidas.

## Ruta rápida de revisión

1. Ejecutar cada caso con un `X-Correlation-ID` único y fácil de reconocer.
2. Capturar respuesta HTTP, logs de servicios, eventos del dashboard y, si aplica, estado de colas o base de datos.
3. Confirmar que el mismo identificador aparece en `ms-tutorias`, servicios dependientes y eventos de tracking.
4. Revisar métricas en Prometheus/Grafana solo si el entorno está levantado y los endpoints `/metrics` responden.
5. Registrar brechas observadas sin asumir garantías no validadas en runtime.

## Objetivo

Observar el flujo completo de solicitud de tutoría para responder tres preguntas operativas:

| Pregunta | Evidencia esperada | Por qué importa |
| --- | --- | --- |
| ¿La solicitud avanzó por el flujo correcto? | Eventos de tracking por servicio, logs y respuesta HTTP. | Permite confirmar el estado funcional sin reconstruir la ejecución desde el código. |
| ¿Dónde falló una solicitud? | `X-Correlation-ID`, código HTTP, evento `ERROR`, logs del servicio que falló. | Reduce el tiempo de diagnóstico entre `ms-tutorias`, `ms-usuarios`, `ms-agenda`, RabbitMQ y `ms-notificaciones`. |
| ¿El sistema quedó consistente después de la falla? | Estado de tutoría, bloqueos de agenda, colas RabbitMQ y eventos de compensación. | Evita bloqueos huérfanos, reintentos infinitos o mensajes perdidos sin visibilidad. |

## Alcance y límites

Incluye observabilidad básica para:

- `POST /v1/tutorias` como flujo orquestado principal;
- propagación de `X-Correlation-ID` entre servicios HTTP;
- eventos RabbitMQ del dashboard de tracking;
- cola de notificaciones y DLQ;
- métricas HTTP expuestas por `express-prom-bundle`, Prometheus y Grafana cuando el entorno está disponible;
- casos de conflicto, Circuit Breaker con Toxiproxy y compensación controlada.

No incluye trazas distribuidas OpenTelemetry, alertas productivas, SLOs, retención centralizada de logs, replay formal de DLQ ni procedimientos de guardia fuera del entorno de validación.

## Evidencia runtime capturada

La validación runtime reciente se ejecutó en entorno local controlado y dejó cleanup explícito de datos y fallas inducidas. Usar esta sección como resumen operativo; si una entrega exige auditoría formal, adjuntar también capturas, comandos y logs originales.

| Caso | Evidencia capturada | Nota operativa |
| --- | --- | --- |
| Inicialización DBs | `db_usuarios` quedó con `estudiantes` y `tutores` más 2 registros por tipo; `db_agenda` con `bloqueos`, índice y seed; `db_tutorias` con tabla, índices y trigger. | La inicialización se hizo después de confirmar DBs vacías; estado final: `bloqueos=1` solo seed y `tutorias=0`. |
| Salud mínima | Usuarios respondió `200` para estudiante `e12345` y tutor `t54321`; agenda respondió `disponible:false` para slot seed ocupado y `disponible:true` para slot libre. | Evidencia de conectividad funcional mínima, no de cobertura completa de contratos. |
| Happy path | `POST /v1/tutorias` respondió `201` con tutoría `CONFIRMADA`. | Cleanup exacto de tutoría y bloqueo creados. |
| Conflicto `409` | Repetir tutor/fecha respondió `409 Horario no disponible`; la base confirmó un solo bloqueo. | Cleanup exacto; evidencia válida para no duplicación del slot probado. |
| Circuit Breaker/Toxiproxy | Toxic de latencia de 3000 ms; logs con `ABIERTO`, `HALF-OPEN` y `CERRADO`; Toxiproxy quedó con `toxics=[]`. | Puede aparecer un primer timeout crudo como `500 Timed out after 1500ms` antes de que el Circuit Breaker abra y responda fast-fail `503`. |
| Saga compensation | Contenedor temporal con `ENABLE_DEMO_FAULT_INJECTION=true` más header `X-Demo-Fail-After-Bloqueo:true`; respuesta `500` controlada; tutoría `FALLIDA`; agenda quedó con 0 bloqueos para el slot. | El modo de fault injection fue temporal. Luego se restauró `ms-tutorias` normal sin env; con el header pero sin env, una solicitud válida volvió a `201 CONFIRMADA`. |
| RabbitMQ/DLQ | Estado final limpio: `notificaciones_email_queue=0` y `notificaciones_dlq=0`. | La limpieza final no reemplaza una política formal de replay, descarte, ownership y retención de DLQ. |

## Correlation ID y trazabilidad

El identificador principal de trazabilidad es `X-Correlation-ID`.

| Punto | Comportamiento observado | Evidencia |
| --- | --- | --- |
| Entrada HTTP | Si el cliente envía `X-Correlation-ID`, el middleware lo conserva; si no, genera un UUID. | `correlationId.middleware.js` en servicios HTTP. |
| Respuesta HTTP | El servicio devuelve `X-Correlation-ID` en la respuesta. | Header de respuesta. |
| Llamadas internas | `ms-tutorias` propaga el header hacia `ms-usuarios` y `ms-agenda`. | `usuarios.client.js`, `agenda.client.js`. |
| Eventos de tracking | Los eventos usan el campo `cid`. | Productores de `tracking_events_exchange`. |
| Notificaciones | El payload de notificación incluye `correlationId`; `ms-notificaciones` genera uno si falta. | `payloadNotificacion`, `notificacion.service.js`. |

Uso recomendado:

```txt
X-Correlation-ID: obs-happy-001
X-Correlation-ID: obs-conflict-409-001
X-Correlation-ID: obs-dlq-001
X-Correlation-ID: obs-cb-toxiproxy-001
X-Correlation-ID: obs-saga-comp-001
```

La trazabilidad actual es **parcial**: permite seguir una transacción por logs y dashboard, pero no ofrece spans, árbol de llamadas, sampling, baggage ni visualización temporal propia de trazas distribuidas.

## Logs por caso

La evidencia de logs debe capturarse filtrando por `CID` o por el texto del evento. Cuando un servicio no registra el CID directamente en cada línea, usar el evento de tracking asociado como puente de correlación.

| Caso | Servicios a revisar | Señales esperadas |
| --- | --- | --- |
| Happy path | `ms-tutorias`, `ms-usuarios`, `ms-agenda`, `ms-notificaciones` | Validación de usuarios, disponibilidad, bloqueo, publicación de notificación, confirmación, procesamiento `ack`. |
| Conflicto `409` | `ms-tutorias`, `ms-agenda` | Horario no disponible o conflicto controlado, respuesta `409`, evento `ERROR`. |
| DLQ | `ms-notificaciones`, RabbitMQ | Error al procesar mensaje, `nack(msg, false, false)`, mensaje en `notificaciones_dlq`. |
| Circuit Breaker/Toxiproxy | `ms-tutorias`, Toxiproxy, `ms-usuarios` | Timeout/red, Circuit Breaker abierto, respuesta `503`, remoción de toxic al finalizar. |
| Saga compensation/fault injection | `ms-tutorias`, `ms-agenda` | Bloqueo creado, falla controlada posterior al bloqueo, eliminación de bloqueo, tutoría marcada como `FALLIDA`. |

## Dashboard de tracking

El dashboard consume `tracking_events_exchange` y retransmite eventos por Socket.IO. Es útil para seguimiento visual por servicio, pero su contrato todavía es parcial porque no hay schema formal, versionado ni garantías de entrega.

Payload mínimo esperado:

```json
{
  "service": "MS_Tutorias",
  "message": "Validando usuarios...",
  "cid": "obs-happy-001",
  "timestamp": "2026-06-24T00:00:00.000Z",
  "status": "INFO"
}
```

Eventos esperados por caso:

| Caso | Eventos esperados | Resultado aceptable |
| --- | --- | --- |
| Happy path | `Validando usuarios`, `Agenda verificada`, `Bloqueo de agenda exitoso`, `Confirmando tutoría y encolando notificación (outbox)`, `Actualización a CONFIRMADA exitosa`, email procesado. | Todos los eventos relevantes comparten el mismo `cid` y no aparecen eventos `ERROR`; la publicación real a `notificaciones_email_queue` la hace el poller del outbox en segundo plano, en segundos, no como parte síncrona del request. |
| `409` | Verificación de disponibilidad o intento de bloqueo, evento de error controlado. | La solicitud falla sin crear doble bloqueo. |
| DLQ | Error de procesamiento de email en `MS_Notificaciones`. | El mensaje inválido no queda reintentándose en la cola principal. |
| Circuit Breaker/Toxiproxy | `Circuit Breaker ABIERTO para ms-usuarios`, proceso fallido en `MS_Tutorias`. | Se observa falla rápida y respuesta `503`. |
| Saga compensation | Falla demo posterior al bloqueo, `COMPENSACIÓN: Desbloqueando agenda`, compensación exitosa, tutoría `FALLIDA`. | No queda bloqueo huérfano para el horario probado. |

## Métricas, Prometheus y Grafana

Estado documental: **implementado/parcial**.

| Elemento | Estado | Evidencia | Observación |
| --- | --- | --- | --- |
| Métricas HTTP por servicio | Implementado en código | `express-prom-bundle` en `ms-auth`, `ms-usuarios`, `ms-agenda`, `ms-notificaciones`, `ms-tutorias`. | Se esperan métricas por método, ruta, código de estado y duración. No se validó runtime en esta revisión. |
| Endpoint `/metrics` | Parcial | Middleware de métricas registrado en cada app Express. | Confirmar disponibilidad con el servicio levantado antes de usarlo como evidencia. |
| Prometheus | Parcial | `prometheus.yml`, `docker-compose.yml`. | Configura scrape de servicios cada 5s. No se validó conectividad runtime ni targets `UP`. |
| Grafana | Parcial | `docker-compose.yml`. | Servicio declarado en puerto local `3005`; no se observan dashboards versionados en el repositorio. |

Evidencia mínima si el entorno está disponible:

- Prometheus muestra targets de servicios en estado `UP`.
- `/metrics` responde en cada servicio esperado.
- Existen series HTTP con etiquetas de método, ruta, status code y servicio.
- Grafana está accesible y conectado a Prometheus, si fue configurado manualmente.

No afirmar cobertura de latencia, disponibilidad o errores como SLO hasta definir objetivos, ventanas y alertas.

## Casos observables

### 1. Happy path

Objetivo: confirmar que una solicitud válida termina confirmada y deja evidencia en todos los puntos relevantes.

Evidencia esperada:

- Respuesta `201 Created` de `POST /v1/tutorias`.
- Header de respuesta `X-Correlation-ID` igual al enviado o generado.
- Eventos de tracking de validación, agenda, bloqueo, notificación y confirmación.
- Log de `ms-notificaciones` con mensaje procesado y confirmado con `ack`.
- Si Prometheus está disponible, incremento de métricas HTTP con status `201` en `ms-tutorias` y llamadas exitosas a dependencias.

### 2. Conflicto `409`

Objetivo: demostrar que no se duplica un bloqueo para el mismo tutor y horario.

Evidencia esperada:

- Primera solicitud válida con estado confirmado.
- Segunda solicitud equivalente con respuesta `409 Conflict`.
- Evento `ERROR` o mensaje de conflicto en `ms-agenda`/`ms-tutorias` con el `cid` del caso.
- Consulta operativa que confirme que no hay doble bloqueo para el mismo tutor y horario.

### 3. DLQ de notificaciones

Objetivo: verificar que un mensaje inválido de notificación se aísla y no se reintenta infinitamente.

Evidencia esperada:

- Payload inválido publicado en `notificaciones_email_queue`.
- Log de `ms-notificaciones` con error de procesamiento.
- Ejecución de `nack(msg, false, false)`.
- Mensaje visible en `notificaciones_dlq`.
- Cola principal sin reintentos repetidos del mismo mensaje.

### 4. Circuit Breaker con Toxiproxy

Objetivo: demostrar que `ms-tutorias` falla rápido cuando `ms-usuarios` no responde o excede timeout.

Evidencia esperada:

- Estado inicial de Toxiproxy sin toxics activas para el proxy de `ms-usuarios`.
- Toxic creada de forma controlada para inducir latencia o indisponibilidad.
- Respuestas `503 Service Unavailable` cuando el Circuit Breaker abre.
- Un primer timeout crudo puede responder `500 Timed out after 1500ms` antes de que el Circuit Breaker quede abierto; el resultado esperado del breaker abierto es el fast-fail `503`.
- Log `CircuitBreaker` y evento `Circuit Breaker ABIERTO para ms-usuarios`.
- Toxic removida y estado final restaurado.

### 5. Saga compensation con fault injection

Objetivo: confirmar que una falla posterior al bloqueo de agenda ejecuta compensación.

Precondición: el modo de falla controlada solo debe activarse con `ENABLE_DEMO_FAULT_INJECTION=true` y header `X-Demo-Fail-After-Bloqueo: true`.

Este modo debe tratarse como una herramienta temporal de validación: levantar un contenedor o proceso específico para el caso, capturar evidencia, limpiar los datos creados y restaurar `ms-tutorias` sin la variable de entorno. No convertir `ENABLE_DEMO_FAULT_INJECTION=true` en configuración permanente.

Evidencia esperada:

- Solicitud con `X-Correlation-ID` y header de fault injection.
- Evento de bloqueo de agenda exitoso antes de la falla.
- Evento de falla controlada posterior al bloqueo.
- Evento de compensación y eliminación de bloqueo en `ms-agenda`.
- Tutoría marcada como `FALLIDA`.
- Consulta que confirme ausencia de bloqueo huérfano.
- Fault injection desactivado al finalizar la validación.

## Checklist de evidencia

Completar una fila por cada caso ejecutado.

| Evidencia | Happy path | `409` | DLQ | Circuit Breaker | Saga compensation |
| --- | --- | --- | --- | --- | --- |
| `X-Correlation-ID` definido y registrado | [ ] | [ ] | [ ] | [ ] | [ ] |
| Request y response HTTP capturados | [ ] | [ ] | [ ] | [ ] | [ ] |
| Logs relevantes capturados | [ ] | [ ] | [ ] | [ ] | [ ] |
| Eventos del dashboard capturados | [ ] | [ ] | [ ] | [ ] | [ ] |
| Estado de persistencia o cola validado | [ ] | [ ] | [ ] | [ ] | [ ] |
| Cleanup/restauración realizado | [ ] | [ ] | [ ] | [ ] | [ ] |
| Métricas revisadas si estaban disponibles | [ ] | [ ] | [ ] | [ ] | [ ] |

## Troubleshooting básico

| Síntoma | Revisión inicial | Acción segura |
| --- | --- | --- |
| No aparece el evento en el dashboard | Confirmar RabbitMQ, `tracking_events_exchange`, conexión del dashboard y payload con `cid`. | Revisar logs de productores y dashboard; no asumir pérdida definitiva sin revisar RabbitMQ. |
| El `cid` cambia entre servicios | Verificar que el cliente envía `X-Correlation-ID` y que las llamadas internas lo propagan. | Repetir el caso con un identificador explícito. |
| Prometheus no muestra targets | Confirmar que el entorno está levantado y que los servicios exponen `/metrics`. | Marcar evidencia de métricas como no validada si no hay runtime disponible. |
| Grafana no tiene paneles | Revisar si existe datasource configurado hacia Prometheus. | Capturar Prometheus como evidencia mínima; documentar ausencia de dashboard versionado. |
| Mensaje inválido no llega a DLQ | Revisar declaración de `notificaciones_email_queue`, DLX y binding. | Confirmar que el consumidor hace `nack(false, false)` y que el mensaje entró por la cola correcta. |
| Circuit Breaker sigue fallando después del caso | Revisar toxics activas y esperar `resetTimeout`. | Remover toxic, confirmar proxy limpio y repetir una solicitud de recuperación. |
| Queda bloqueo después de falla controlada | Buscar eventos de compensación y errores en `ms-agenda`. | Registrar bloqueo huérfano como incidente de validación; no eliminar evidencia antes de capturar logs y consultas. |

## Riesgos y brechas

- **Trazas distribuidas:** no se observa OpenTelemetry, Jaeger, Tempo ni Zipkin; `X-Correlation-ID` no reemplaza trazas con spans.
- **Alertas:** existe una regla de alerta evaluada por Prometheus (`alert_rules.yml`, `CompensacionAgendaFallida`, dispara si `compensacion_fallida_total` incrementa en los últimos 5 minutos) visible en `/alerts` de Prometheus. **No hay Alertmanager** en este entorno, así que la alerta no se enruta a ningún canal de notificación (email/Slack/etc.) — solo queda visible en la UI de Prometheus.
- **SLOs:** no hay objetivos formales de disponibilidad, latencia, tasa de error ni ventanas de medición.
- **Retención:** no se documenta retención de logs, métricas, eventos ni mensajes de DLQ.
- **Logs centralizados:** los logs dependen de salida de servicios; no se observa agregación centralizada ni búsqueda histórica.
- **Dashboards versionados:** Grafana está declarado, pero no se observan dashboards provisionados en el repositorio.
- **Contratos de eventos:** tracking y notificaciones no tienen schema formal ni versionado.
- **Garantías de publicación:** los productores RabbitMQ no documentan publisher confirms; un canal no disponible puede dejar eventos sin publicar.
- **Operación de DLQ:** existe aislamiento, pero no hay procedimiento formal de replay, descarte, ownership ni auditoría.
- **Resuelto (parcial):** si falla la compensación de agenda, la tabla `compensaciones_pendientes` + el worker `compensacion.worker.js` reintentan en segundo plano, y la métrica `compensacion_fallida_total` + la regla `CompensacionAgendaFallida` dan alerta automática (visible en Prometheus, sin Alertmanager que la enrute a un canal).
- **Seguridad observacional:** el `cid` no autentica ni autoriza; solo correlaciona evidencia.

## Próximo paso recomendado

Convertir este runbook en evidencia repetible: agregar una matriz de ejecución por ambiente, versionar dashboards mínimos de Grafana si se usan, definir alertas básicas y formalizar trazas distribuidas o, como mínimo, una política de logs correlacionados por `X-Correlation-ID`.

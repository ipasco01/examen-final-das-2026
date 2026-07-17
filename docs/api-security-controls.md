# Controles mínimos de seguridad para APIs

Este documento resume los controles de seguridad observados en el código, la configuración y los contratos OpenAPI actuales. Su objetivo es facilitar una revisión técnica sin asumir garantías que todavía no están implementadas o formalizadas.

## Ruta rápida de revisión

1. Obtener un JWT desde `POST /auth/token` con credenciales demo válidas.
2. Invocar `POST /v1/tutorias` con `Authorization: Bearer <token>` y un `X-Correlation-ID` identificable.
3. Confirmar que una solicitud sin token, con token inválido o con rol no autorizado recibe `401` o `403` según corresponda.
4. Revisar que el identificador efectivo del estudiante se toma del claim `sub` del JWT y no del cuerpo de la petición.
5. Si se valida la compensación demo, activar el fault injection solo con `ENABLE_DEMO_FAULT_INJECTION=true` y `X-Demo-Fail-After-Bloqueo: true`.

## Resumen de cobertura

| Área | Estado | Evidencia principal | Observación |
| --- | --- | --- | --- |
| Emisión de JWT | Implementado/parcial | `ms-auth/src/domain/services/auth.service.js`, `ms-auth/docs/swagger.yaml` | `ms-auth` emite tokens firmados con `sub`, `name`, `role` e `iss`; usa secreto compartido y expiración configurable. |
| Ruta protegida de tutorías | Implementado | `ms-tutorias/src/api/routes/tutorias.routes.js`, `ms-tutorias/src/api/middlewares/jwt.middleware.js` | `POST /v1/tutorias` exige `Authorization: Bearer <token>`. |
| Autorización por rol | Implementado/parcial | `ms-tutorias/src/api/controllers/tutorias.controller.js` | Solo `role: student` puede solicitar tutorías. No se observa un modelo general de permisos por recurso o política centralizada. |
| Integridad de identidad | Implementado | `ms-tutorias/src/api/controllers/tutorias.controller.js` | El `idEstudiante` se sobreescribe con `req.user.sub`; no se confía en el cuerpo para esa identidad. |
| Validaciones de entrada | Parcial | Controladores y servicios de `ms-auth`, `ms-tutorias`, `ms-agenda`; OpenAPI | Existen validaciones imperativas y contrato OpenAPI, pero no validación formal automática contra schema. |
| Errores de seguridad | Implementado/parcial | `jwt.middleware.js`, `errorHandler.js` | Hay respuestas `401`, `403`, `400`, `409` y formato JSON de error; algunos handlers registran detalles completos en logs. |
| Secretos y entorno | Parcial | `docker-compose.yml`, `.env.example`, `kubernetes-manifests/*.yaml` | Hay variables de entorno, pero también valores demo/hardcodeados en manifiestos y compose. |
| Kong/API Gateway | Parcial | `kubernetes-manifests/kong-security.yaml`, `kubernetes-manifests/main-ingress.yaml`, `kong-values.yaml` | Ingress único consolidado; el plugin JWT está anotado sobre el Service `ms-tutorias-service` (no sobre el Ingress), así que `/auth` queda público por diseño y `/tutorias` protegido. Sigue usando secreto demo. |
| Observabilidad de seguridad | Parcial | `X-Correlation-ID`, tracking RabbitMQ, logs | Permite correlación básica; no reemplaza auditoría, SIEM ni trazas distribuidas formales. |

## Autenticación y JWT

`ms-auth` expone `POST /auth/token`. El controlador exige `username` y `password`; el servicio busca el usuario demo, compara la contraseña con `bcrypt.compare` y emite un JWT firmado con `JWT_SECRET`.

Claims observados en el token:

| Claim | Uso actual | Evidencia |
| --- | --- | --- |
| `sub` | Identificador del sujeto autenticado. En tutorías se usa como `idEstudiante` confiable. | `auth.service.js`, `tutorias.controller.js` |
| `name` | Nombre descriptivo del usuario autenticado. | `auth.service.js` |
| `role` | Rol usado para autorización básica en `POST /v1/tutorias`. | `auth.service.js`, `tutorias.controller.js` |
| `iss` | Emisor configurado como `mobile-app-consumer`. | `auth.service.js` |

El token se firma con el secreto definido en `JWT_SECRET` y usa `JWT_EXPIRES_IN`, con valor por defecto de `1h` en `ms-auth` si no se define la expiración.

### Rutas protegidas observadas

| API | Ruta | Protección | Estado | Evidencia |
| --- | --- | --- | --- | --- |
| `ms-auth` | `POST /auth/token` | No requiere JWT; emite token tras credenciales válidas. | Implementado | `ms-auth/src/api/routes/auth.routes.js` |
| `ms-tutorias` | `POST /v1/tutorias` | Requiere `Authorization: Bearer <token>` validado localmente; `ms-tutorias` reenvía el mismo token a `ms-usuarios`/`ms-agenda` en las llamadas internas de la Saga. | Implementado | `ms-tutorias/src/api/routes/tutorias.routes.js`, `ms-tutorias/src/api/middlewares/jwt.middleware.js` |
| `ms-usuarios` | `GET /usuarios/estudiantes/:id`, `GET /usuarios/tutores/:id` | Requiere `Authorization: Bearer <token>` validado localmente (antes sin protección). | Implementado | `ms-usuarios/src/api/routes/usuarios.routes.js`, `ms-usuarios/src/api/middlewares/jwt.middleware.js` |
| `ms-agenda` | `GET /agenda/tutores/:id/disponibilidad`, `POST /agenda/tutores/:id/bloquear`, `DELETE /agenda/bloqueos/:id` | Requiere `Authorization: Bearer <token>` validado localmente (antes sin protección, incluidas las rutas que mutan estado). El worker de compensación en background de `ms-tutorias` usa un JWT de servicio de corta duración (`role: service`) para `DELETE`, ya que no hay token de usuario disponible fuera de una request. | Implementado | `ms-agenda/src/api/routes/agenda.routes.js`, `ms-agenda/src/api/middlewares/jwt.middleware.js` |
| Gateway Kong | `/auth` público, `/tutorias` protegido | Ingress único; plugin JWT anotado sobre el Service `ms-tutorias-service`, no sobre el Ingress. | Implementado | `kubernetes-manifests/main-ingress.yaml`, `kubernetes-manifests/ms-tutorias.yaml` |

Resuelto: existían tres manifiestos de Ingress redundantes e inconsistentes entre sí (`public-ingress.yaml` exponía `/tutorias` sin ninguna protección; `protected-ingress.yaml` sí la aplicaba; `kong-ingress.yaml` aplicaba el plugin a nivel de Ingress completo, cubriendo también `/auth` por error). Se consolidaron en un único `main-ingress.yaml` con las dos rutas, y el plugin JWT se anotó sobre el `Service` `ms-tutorias-service` en vez del `Ingress` -- ese es el nivel de scoping correcto en Kong Ingress Controller para proteger un backend específico sin afectar a los demás que comparten el mismo Ingress. `/auth` queda público por diseño explícito (no lleva la anotación), no por descuido.

## Autorización y roles

La autorización explícita observada está en `POST /v1/tutorias`:

- el middleware JWT carga el payload en `req.user`;
- el controlador rechaza cualquier token cuyo `role` no sea `student` con `403`;
- el identificador del estudiante se toma de `req.user.sub`, reemplazando cualquier `idEstudiante` enviado en el cuerpo.

Estado: **implementado/parcial**. Hay un control concreto de rol para el flujo principal, pero queda pendiente formalizar una matriz de permisos por servicio, endpoint y recurso. No se observa un mecanismo centralizado de autorización ni validación de ownership más allá del uso de `sub` para la solicitud de tutoría.

## Validaciones de entrada principales

| Componente | Validación observada | Respuesta esperada | Estado |
| --- | --- | --- | --- |
| `ms-auth` | `username` y `password` requeridos. | `400` si faltan; `401` si las credenciales son inválidas. | Implementado |
| `ms-tutorias` | JWT requerido, formato `Bearer`, firma y expiración válidas. | `401` ante ausencia, formato inválido, token inválido o expirado. | Implementado |
| `ms-tutorias` | Rol `student` requerido para crear solicitud. | `403` si el rol no está autorizado. | Implementado |
| `ms-tutorias` | Estudiante y tutor deben existir en `ms-usuarios`; horario debe estar disponible. | `404` o `409` según el caso. | Implementado/parcial |
| `ms-agenda` | `fechaHora` requerido para disponibilidad. | `400` si falta el query param. | Implementado |
| `ms-agenda` | `fechaInicio`, `duracionMinutos` e `idEstudiante` requeridos para bloqueo. | `400` si faltan datos. | Implementado |
| `ms-agenda` | Revalidación de disponibilidad antes de crear bloqueo. | `409` si el horario ya no está disponible. | Implementado/parcial |
| OpenAPI | `SolicitudTutoriaRequest` define campos requeridos y tipos básicos. | Documental; no se observa middleware de validación automática. | Parcial |

Pendiente: las validaciones son principalmente imperativas. No se observa validación formal automática contra OpenAPI/JSON Schema ni normalización estricta de `additionalProperties` en `SolicitudTutoriaRequest`.

## Manejo de errores de seguridad

Los errores de autenticación y autorización se devuelven en JSON con estructura `error.message` y, según el handler, `error.statusCode`.

| Caso | Código | Comportamiento observado |
| --- | --- | --- |
| Falta `Authorization` | `401` | `Acceso denegado. Token no proporcionado.` |
| Formato distinto de `Bearer <token>` | `401` | `Formato de token inválido. Debe ser "Bearer <token>".` |
| Firma inválida o token expirado | `401` | `Token inválido o expirado.` |
| Rol no autorizado | `403` | `Acción no permitida. Solo los estudiantes pueden solicitar tutorías.` |
| Credenciales inválidas | `401` | `Credenciales inválidas`. |
| Error interno no controlado | `500` | Mensaje genérico en `ms-auth`; en `ms-tutorias` puede exponerse `err.message`. |

Riesgo controlado parcialmente: `ms-auth` oculta el detalle de errores internos en la respuesta, pero `ms-tutorias` usa `err.message` si existe. Para endurecimiento, conviene separar mensajes internos de mensajes públicos y mantener el detalle solo en logs controlados.

## Secretos y variables de entorno

Variables relevantes observadas:

| Variable | Uso | Evidencia | Estado |
| --- | --- | --- | --- |
| `JWT_SECRET` | Firma y validación de JWT entre `ms-auth`, `ms-usuarios`, `ms-agenda`, `ms-tutorias` y Kong. | `*/src/config/index.js`, manifiestos y `docker-compose.yml`. | Implementado/parcial |
| `JWT_EXPIRES_IN` | Expiración del token emitido por `ms-auth`. | `ms-auth/src/config/index.js`, `docker-compose.yml`. | Implementado/parcial |
| `RABBITMQ_URL` | Conexión a RabbitMQ para tracking y notificaciones. | `docker-compose.yml`, configs de servicios. | Implementado/parcial |
| `DB_PASSWORD` | Acceso a las 4 bases PostgreSQL (`db_auth`, `db_usuarios`, `db_agenda`, `db_tutorias`). | `docker-compose.yml`, configs de servicios. | Implementado |
| `ENABLE_DEMO_FAULT_INJECTION` | Habilita falla demo posterior al bloqueo. | `ms-tutorias/src/domain/services/tutoria.service.js`. | Implementado para demo |

El código de `ms-auth` falla al arrancar si `JWT_SECRET` no está definido. En `ms-usuarios`/`ms-agenda`/`ms-tutorias`, el secreto se lee desde entorno para el middleware JWT, pero no se observa una validación equivalente de arranque (fallarían recién en la primera request, no al iniciar el proceso).

Resuelto: `docker-compose.yml` ya no trae ningún fallback hardcodeado para `JWT_SECRET`, las 4 contraseñas de BD, credenciales de RabbitMQ ni la contraseña de Grafana -- todas son obligatorias (`${VAR:?mensaje}`) y se proveen vía un `.env` en la raíz del repo (gitignorado). Los manifiestos de Kubernetes (`kong-security.yaml`) siguen usando un secreto placeholder (`CHANGE_ME_WITH_APP_JWT_SECRET`) que debe reemplazarse y gestionarse externamente antes de cualquier despliegue no local.

## Kong/API Gateway

La configuración disponible declara:

- `KongPlugin` `jwt-validation-plugin` con plugin `jwt` y `key_claim_name: "sub"`;
- `KongConsumer` `mobile-app-consumer`;
- credencial JWT asociada al consumidor mediante `Secret` de Kubernetes;
- `Ingress` único (`main-ingress.yaml`) con rutas `/auth` y `/tutorias`; el plugin JWT está anotado sobre el `Service` `ms-tutorias-service`, no sobre el Ingress;
- `kong-values.yaml` con Admin API habilitada como `ClusterIP` y proxy tipo `LoadBalancer`.

Estado: **parcial**. La segregación fina entre `/auth` (público) y `/tutorias` (protegido) ya está resuelta vía Ingress único + plugin anotado a nivel de Service. Pendiente: usan secreto demo (`kong-security.yaml`), no documentan rate limiting, TLS ni mTLS a nivel de gateway, y el `KongConsumer`/credencial JWT siguen fijados a un solo usuario demo (ver limitación conocida más abajo). Además, la Admin API está habilitada por HTTP dentro del clúster; esto puede ser aceptable para demo/local, pero requiere hardening antes de un entorno sensible.

### Limitación conocida: credencial JWT de Kong fijada a un solo usuario demo

`kong-security.yaml` define **una sola** credencial JWT para el consumer `mobile-app-consumer`, con `key: "e12345"` -- ese valor debe coincidir exactamente con el claim `sub` del token para que el plugin `jwt` de Kong lo acepte (`key_claim_name: "sub"`). Esto ata la validación de Kong al `sub` de una única usuaria demo (Ana Torres). Un JWT válido emitido por `ms-auth` para cualquier otro usuario demo (ej. Elena Solano, `t09876`) sería rechazado por Kong en la capa de gateway, aunque `ms-auth`/`ms-tutorias` lo acepten correctamente a nivel de aplicación.

Esto es una **limitación conocida del alcance académico/demo**, no una decisión de diseño final: Kong requiere una credencial (`key`/`secret`) provisionada por adelantado por cada `sub` que deba pasar el gateway. Una solución real necesitaría que `ms-auth` (o un proceso de aprovisionamiento) llame a la Kong Admin API para crear/actualizar dinámicamente la credencial JWT del consumer correspondiente a cada usuario real, en vez de un `Secret` estático versionado con un solo `sub` hardcodeado. Ese trabajo queda fuera del alcance actual y debe abordarse explícitamente antes de considerar este gateway apto para más de un usuario o para un entorno no demo.

El secreto compartido `app-jwt-secret` (`kong-security.yaml`) ya es un placeholder (`CHANGE_ME_WITH_APP_JWT_SECRET`) y debe salir del repositorio y gestionarse externamente antes de cualquier despliegue no local, con el mismo criterio aplicado a los secretos de `docker-compose.yml` (ver hallazgo A3).

## Headers relevantes

| Header | Dirección | Uso | Estado |
| --- | --- | --- | --- |
| `Authorization: Bearer <token>` | Cliente → API | Autenticación de `POST /v1/tutorias`; JWT emitido por `ms-auth`. | Implementado |
| `X-Correlation-ID` | Cliente → API y API → cliente | Correlación de logs, llamadas internas y eventos de tracking. Si falta, algunos servicios generan uno. | Implementado/parcial |
| `Idempotency-Key` | Cliente → `ms-tutorias` | Obligatorio en `POST /v1/tutorias`; deduplica reintentos del cliente devolviendo la tutoría ya creada en vez de reejecutar la Saga. Sin este header, la API responde `400`. | Implementado |
| `X-Demo-Fail-After-Bloqueo: true` | Cliente → `ms-tutorias` | Activa una falla demo posterior al bloqueo solo si también existe `ENABLE_DEMO_FAULT_INJECTION=true`. | Implementado para validación controlada |

El header de fault injection no debe usarse en flujos normales. Su gating actual requiere dos condiciones simultáneas: variable de entorno habilitada y header explícito. Esto reduce activaciones accidentales, pero sigue siendo una capacidad de demo que debe permanecer deshabilitada fuera de validaciones controladas.

## Evidencia mínima para validar controles

| Control | Evidencia esperada | Resultado aceptable |
| --- | --- | --- |
| Emisión de token | Respuesta de `POST /auth/token` con `access_token`. | El token contiene claims esperados y expira según configuración. |
| Token requerido | `POST /v1/tutorias` sin `Authorization`. | Respuesta `401` sin crear tutoría ni bloqueo. |
| Formato Bearer | `POST /v1/tutorias` con header mal formado. | Respuesta `401`. |
| Token inválido/expirado | `POST /v1/tutorias` con JWT inválido o vencido. | Respuesta `401`. |
| Token requerido (`ms-usuarios`) | `GET /usuarios/estudiantes/:id` sin `Authorization`. | Respuesta `401`. |
| Token requerido (`ms-agenda`) | `POST /agenda/tutores/:id/bloquear` o `DELETE /agenda/bloqueos/:id` sin `Authorization`. | Respuesta `401` en ambas rutas (incluida la que muta estado). |
| Rol no autorizado | Token válido con rol distinto de `student`. | Respuesta `403`. |
| Integridad de identidad | Enviar `idEstudiante` distinto en el body. | La solicitud usa el `sub` del JWT como identidad efectiva. |
| Correlación | Enviar `X-Correlation-ID` propio. | La respuesta y eventos/logs conservan el identificador. |
| Fault injection seguro | Probar header sin `ENABLE_DEMO_FAULT_INJECTION=true`. | No se induce falla demo. |
| Compensación demo | Activar variable y header en una prueba controlada. | Se induce falla posterior al bloqueo y se ejecuta compensación de agenda. |
| Kong JWT | Aplicar manifiestos en entorno de prueba. | El gateway rechaza requests sin credencial válida en rutas protegidas; revisar explícitamente el comportamiento de `/auth`. |

## Riesgos y pendientes

- **Pendiente:** formalizar una matriz de autorización por endpoint, rol y recurso.
- **Resuelto (aplicación):** rate limiting agregado con `express-rate-limit` en los 5 microservicios (100 req/15min por IP), incluido `POST /auth/token`. **Pendiente:** rate limiting también a nivel de gateway Kong.
- **Pendiente:** definir rotación de `JWT_SECRET`, separación por entorno y almacenamiento en un gestor de secretos real.
- **Pendiente:** validar formalmente requests contra OpenAPI/JSON Schema o middleware equivalente.
- **Pendiente:** definir TLS para tráfico externo y, si aplica, comunicación segura entre servicios.
- **Resuelto:** políticas por ruta y tratamiento especial de `/auth` (Ingress único consolidado, plugin JWT anotado a nivel de Service en vez de a nivel de Ingress).
- **Pendiente:** restricción de Admin API, CORS si se expone a navegador y plugins de seguridad adicionales en Kong.
- **Pendiente:** el `KongConsumer`/credencial JWT de Kong siguen fijados a un solo usuario demo (`sub: e12345`), no se provisionan dinámicamente por usuario/token real emitido por `ms-auth`.
- **Riesgo:** secretos demo y credenciales locales aparecen en configuración versionada; no deben reutilizarse fuera de desarrollo o demostración.
- **Riesgo:** `ms-tutorias` no muestra una validación de arranque para `JWT_SECRET`; una mala configuración puede fallar en runtime.
- **Riesgo:** logs y errores pueden contener detalles internos; conviene separar mensajes públicos, logs técnicos y auditoría.
- **Parcial:** `X-Correlation-ID` aporta trazabilidad operativa, pero no es un control de autenticidad ni auditoría completa.
- **Parcial:** no se observan pruebas automatizadas completas para todos los casos de seguridad; existen pruebas específicas relacionadas con fault injection.

## Próximo paso recomendado

Convertir esta revisión en una lista de aceptación verificable: pruebas automatizadas para autenticación/autorización, validación formal de payloads, política de secretos por entorno y configuración explícita de gateway para separar `/auth` de rutas protegidas.

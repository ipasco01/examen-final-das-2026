# Controles mínimos de seguridad para APIs

Este documento resume los controles de seguridad observados en el código, la configuración y los contratos OpenAPI actuales. Su objetivo es facilitar una revisión técnica sin asumir garantías que todavía no están implementadas o formalizadas.

## Ruta rápida de revisión

1. Obtener un JWT desde `POST /auth/token` con credenciales demo válidas.
2. Invocar `POST /tutorias` con `Authorization: Bearer <token>` y un `X-Correlation-ID` identificable.
3. Confirmar que una solicitud sin token, con token inválido o con rol no autorizado recibe `401` o `403` según corresponda.
4. Revisar que el identificador efectivo del estudiante se toma del claim `sub` del JWT y no del cuerpo de la petición.
5. Si se valida la compensación demo, activar el fault injection solo con `ENABLE_DEMO_FAULT_INJECTION=true` y `X-Demo-Fail-After-Bloqueo: true`.

## Resumen de cobertura

| Área | Estado | Evidencia principal | Observación |
| --- | --- | --- | --- |
| Emisión de JWT | Implementado/parcial | `ms-auth/src/domain/services/auth.service.js`, `ms-auth/docs/swagger.yaml` | `ms-auth` emite tokens firmados con `sub`, `name`, `role` e `iss`; usa secreto compartido y expiración configurable. |
| Ruta protegida de tutorías | Implementado | `ms-tutorias/src/api/routes/tutorias.routes.js`, `ms-tutorias/src/api/middlewares/jwt.middleware.js` | `POST /tutorias` exige `Authorization: Bearer <token>`. |
| Autorización por rol | Implementado/parcial | `ms-tutorias/src/api/controllers/tutorias.controller.js` | Solo `role: student` puede solicitar tutorías. No se observa un modelo general de permisos por recurso o política centralizada. |
| Integridad de identidad | Implementado | `ms-tutorias/src/api/controllers/tutorias.controller.js` | El `idEstudiante` se sobreescribe con `req.user.sub`; no se confía en el cuerpo para esa identidad. |
| Validaciones de entrada | Parcial | Controladores y servicios de `ms-auth`, `ms-tutorias`, `ms-agenda`; OpenAPI | Existen validaciones imperativas y contrato OpenAPI, pero no validación formal automática contra schema. |
| Errores de seguridad | Implementado/parcial | `jwt.middleware.js`, `errorHandler.js` | Hay respuestas `401`, `403`, `400`, `409` y formato JSON de error; algunos handlers registran detalles completos en logs. |
| Secretos y entorno | Parcial | `docker-compose.yml`, `.env.example`, `kubernetes-manifests/*.yaml` | Hay variables de entorno, pero también valores demo/hardcodeados en manifiestos y compose. |
| Kong/API Gateway | Parcial | `kubernetes-manifests/kong-security.yaml`, `kubernetes-manifests/kong-ingress.yaml`, `kong-values.yaml` | Existe configuración JWT para Kong e ingress, pero con secreto demo y aplicación global del plugin en el ingress actual. |
| Observabilidad de seguridad | Parcial | `X-Correlation-ID`, tracking RabbitMQ, logs | Permite correlación básica; no reemplaza auditoría, SIEM ni trazas distribuidas formales. |

## Autenticación y JWT

`ms-auth` expone `POST /auth/token`. El controlador exige `username` y `password`; el servicio busca el usuario demo, compara la contraseña con `bcrypt.compare` y emite un JWT firmado con `JWT_SECRET`.

Claims observados en el token:

| Claim | Uso actual | Evidencia |
| --- | --- | --- |
| `sub` | Identificador del sujeto autenticado. En tutorías se usa como `idEstudiante` confiable. | `auth.service.js`, `tutorias.controller.js` |
| `name` | Nombre descriptivo del usuario autenticado. | `auth.service.js` |
| `role` | Rol usado para autorización básica en `POST /tutorias`. | `auth.service.js`, `tutorias.controller.js` |
| `iss` | Emisor configurado como `mobile-app-consumer`. | `auth.service.js` |

El token se firma con el secreto definido en `JWT_SECRET` y usa `JWT_EXPIRES_IN`, con valor por defecto de `1h` en `ms-auth` si no se define la expiración.

### Rutas protegidas observadas

| API | Ruta | Protección | Estado | Evidencia |
| --- | --- | --- | --- | --- |
| `ms-auth` | `POST /auth/token` | No requiere JWT; emite token tras credenciales válidas. | Implementado | `ms-auth/src/api/routes/auth.routes.js` |
| `ms-tutorias` | `POST /tutorias` | Requiere `Authorization: Bearer <token>` validado localmente. | Implementado | `ms-tutorias/src/api/routes/tutorias.routes.js` |
| Gateway Kong | `/auth`, `/tutorias` | Ingress anotado con plugin JWT. | Parcial | `kubernetes-manifests/kong-ingress.yaml` |

Observación importante: a nivel de aplicación, la ruta de emisión de token no usa JWT porque es el punto de autenticación. En los manifiestos de Kong, el plugin JWT está anotado sobre el ingress completo; esto debe revisarse antes de usarlo como política productiva porque puede afectar también a `/auth`.

## Autorización y roles

La autorización explícita observada está en `POST /tutorias`:

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
| `JWT_SECRET` | Firma y validación de JWT entre `ms-auth`, `ms-tutorias` y Kong. | `ms-auth/src/config/index.js`, `ms-tutorias/src/config/index.js`, manifiestos y compose. | Parcial |
| `JWT_EXPIRES_IN` | Expiración del token emitido por `ms-auth`. | `ms-auth/src/config/index.js`, `docker-compose.yml`. | Implementado/parcial |
| `RABBITMQ_URL` | Conexión a RabbitMQ para tracking y notificaciones. | `docker-compose.yml`, configs de servicios. | Implementado/parcial |
| `DB_PASSWORD` | Acceso a bases PostgreSQL locales. | `docker-compose.yml`, configs de servicios. | Parcial |
| `ENABLE_DEMO_FAULT_INJECTION` | Habilita falla demo posterior al bloqueo. | `ms-tutorias/src/domain/services/tutoria.service.js`. | Implementado para demo |

El código de `ms-auth` falla al arrancar si `JWT_SECRET` no está definido. En `ms-tutorias`, el secreto se lee desde entorno, pero no se observa una validación equivalente de arranque.

Riesgo pendiente: los valores actuales son de desarrollo/demo y aparecen en `docker-compose.yml`, `.env.example`, algunos `.env` locales y manifiestos de Kubernetes. No deben tratarse como secretos productivos.

## Kong/API Gateway

La configuración disponible declara:

- `KongPlugin` `jwt-validation-plugin` con plugin `jwt` y `key_claim_name: "sub"`;
- `KongConsumer` `mobile-app-consumer`;
- credencial JWT asociada al consumidor mediante `Secret` de Kubernetes;
- `Ingress` con anotación `konghq.com/plugins: jwt-validation-plugin` y rutas `/auth` y `/tutorias`;
- `kong-values.yaml` con Admin API habilitada como `ClusterIP` y proxy tipo `LoadBalancer`.

Estado: **parcial**. Hay manifiestos de gateway, pero usan secreto demo y no documentan rate limiting, TLS, mTLS, CORS, políticas por ruta ni segregación fina entre endpoint público de autenticación y endpoints protegidos. Además, la Admin API está habilitada por HTTP dentro del clúster; esto puede ser aceptable para demo/local, pero requiere hardening antes de un entorno sensible.

## Headers relevantes

| Header | Dirección | Uso | Estado |
| --- | --- | --- | --- |
| `Authorization: Bearer <token>` | Cliente → API | Autenticación de `POST /tutorias`; JWT emitido por `ms-auth`. | Implementado |
| `X-Correlation-ID` | Cliente → API y API → cliente | Correlación de logs, llamadas internas y eventos de tracking. Si falta, algunos servicios generan uno. | Implementado/parcial |
| `Idempotency-Key` | Cliente → `ms-tutorias` | Obligatorio en `POST /tutorias`; deduplica reintentos del cliente devolviendo la tutoría ya creada en vez de reejecutar la Saga. Sin este header, la API responde `400`. | Implementado |
| `X-Demo-Fail-After-Bloqueo: true` | Cliente → `ms-tutorias` | Activa una falla demo posterior al bloqueo solo si también existe `ENABLE_DEMO_FAULT_INJECTION=true`. | Implementado para validación controlada |

El header de fault injection no debe usarse en flujos normales. Su gating actual requiere dos condiciones simultáneas: variable de entorno habilitada y header explícito. Esto reduce activaciones accidentales, pero sigue siendo una capacidad de demo que debe permanecer deshabilitada fuera de validaciones controladas.

## Evidencia mínima para validar controles

| Control | Evidencia esperada | Resultado aceptable |
| --- | --- | --- |
| Emisión de token | Respuesta de `POST /auth/token` con `access_token`. | El token contiene claims esperados y expira según configuración. |
| Token requerido | `POST /tutorias` sin `Authorization`. | Respuesta `401` sin crear tutoría ni bloqueo. |
| Formato Bearer | `POST /tutorias` con header mal formado. | Respuesta `401`. |
| Token inválido/expirado | `POST /tutorias` con JWT inválido o vencido. | Respuesta `401`. |
| Rol no autorizado | Token válido con rol distinto de `student`. | Respuesta `403`. |
| Integridad de identidad | Enviar `idEstudiante` distinto en el body. | La solicitud usa el `sub` del JWT como identidad efectiva. |
| Correlación | Enviar `X-Correlation-ID` propio. | La respuesta y eventos/logs conservan el identificador. |
| Fault injection seguro | Probar header sin `ENABLE_DEMO_FAULT_INJECTION=true`. | No se induce falla demo. |
| Compensación demo | Activar variable y header en una prueba controlada. | Se induce falla posterior al bloqueo y se ejecuta compensación de agenda. |
| Kong JWT | Aplicar manifiestos en entorno de prueba. | El gateway rechaza requests sin credencial válida en rutas protegidas; revisar explícitamente el comportamiento de `/auth`. |

## Riesgos y pendientes

- **Pendiente:** formalizar una matriz de autorización por endpoint, rol y recurso.
- **Pendiente:** agregar rate limiting en gateway o aplicación para `POST /auth/token` y endpoints protegidos.
- **Pendiente:** definir rotación de `JWT_SECRET`, separación por entorno y almacenamiento en un gestor de secretos real.
- **Pendiente:** validar formalmente requests contra OpenAPI/JSON Schema o middleware equivalente.
- **Pendiente:** definir TLS para tráfico externo y, si aplica, comunicación segura entre servicios.
- **Pendiente:** endurecer Kong: políticas por ruta, tratamiento especial de `/auth`, restricción de Admin API, CORS si se expone a navegador y plugins de seguridad adicionales.
- **Riesgo:** secretos demo y credenciales locales aparecen en configuración versionada; no deben reutilizarse fuera de desarrollo o demostración.
- **Riesgo:** `ms-tutorias` no muestra una validación de arranque para `JWT_SECRET`; una mala configuración puede fallar en runtime.
- **Riesgo:** logs y errores pueden contener detalles internos; conviene separar mensajes públicos, logs técnicos y auditoría.
- **Parcial:** `X-Correlation-ID` aporta trazabilidad operativa, pero no es un control de autenticidad ni auditoría completa.
- **Parcial:** no se observan pruebas automatizadas completas para todos los casos de seguridad; existen pruebas específicas relacionadas con fault injection.

## Próximo paso recomendado

Convertir esta revisión en una lista de aceptación verificable: pruebas automatizadas para autenticación/autorización, validación formal de payloads, política de secretos por entorno y configuración explícita de gateway para separar `/auth` de rutas protegidas.

# Remediación de seguridad — Frente A (autenticación/identidad) y Frente B (Kong/Ingress)

Este documento detalla el trabajo realizado sobre los hallazgos de la revisión de seguridad, en la rama `grupo-3-Seguridad`. Complementa a [`docs/api-security-controls.md`](./api-security-controls.md), que se actualizó en el mismo trabajo para reflejar estos cambios.

## Resumen ejecutivo

| Hallazgo | Severidad original | Estado |
| --- | --- | --- |
| A1 — Sin verificación JWT en `ms-usuarios`/`ms-agenda` | 🔴 Crítico | Cerrado |
| A2 — Credenciales en comentarios + `usersDB` en memoria | 🔴 Crítico | Cerrado |
| A3 — Fallbacks/secretos hardcodeados en `docker-compose.yml` | 🔴 Crítico | Cerrado |
| A4 — Sin `helmet`/`cors`/`express-rate-limit` | 🟡 No crítico | Cerrado |
| A5 — Fuga de información interna en errores de `ms-tutorias` | 🔴 Crítico | Ya estaba resuelto (más limpieza menor) |
| B1 — `/tutorias` sin protección en `public-ingress.yaml` | 🔴 Crítico | Cerrado |
| B2 — Secreto de Kong y `KongConsumer` fijo a un usuario | 🔴 Crítico | Documentado como limitación conocida (decisión del usuario) |
| B3 — Prueba de no-bypass | Validación | Lista para ejecutar; no se pudo correr en este entorno (sin cluster K8s) |

Todos los cambios de código se probaron con tests automatizados (`node --test` por servicio) y con un smoke test end-to-end real contra Docker (`login` → `POST /v1/tutorias` → `CONFIRMADA`) después de cada hallazgo.

---

## A1 — JWT middleware en `ms-usuarios` y `ms-agenda`

### Problema

Ninguna ruta de `ms-usuarios` ni `ms-agenda` verificaba token. Las rutas que **mutan estado** quedaban completamente abiertas:

- `ms-usuarios`: `GET /usuarios/estudiantes/:id`, `GET /usuarios/tutores/:id`.
- `ms-agenda`: `GET /agenda/tutores/:id_tutor/disponibilidad`, `POST /agenda/tutores/:id_tutor/bloquear`, `DELETE /agenda/bloqueos/:idBloqueo`.

Además, `ms-tutorias` llamaba a ambos servicios sin reenviar ningún token (comunicación server-to-server sin autenticación), así que activar el middleware ahí habría roto la Saga completa si no se resolvía primero cómo autenticar esas llamadas internas.

### Decisión de diseño

Se reenvía el **mismo JWT del usuario final** desde `ms-tutorias` hacia `ms-usuarios`/`ms-agenda` en las llamadas síncronas (ya fue verificado una vez en la entrada de `POST /v1/tutorias`, así que es válido reutilizarlo para el resto de la Saga).

Para el **worker de compensación en background** (`compensacion.worker.js`, que reintenta `agendaClient.cancelarBloqueo` con un `setInterval` propio, sin ninguna request de usuario activa), no hay token de usuario que reenviar. Se optó por que `ms-tutorias` firme un **JWT de servicio de corta duración** (`{ sub: 'ms-tutorias', role: 'service' }`, 1 minuto de expiración) con el mismo `JWT_SECRET` compartido, exclusivamente para esa llamada.

### Cambios

- **Nuevo middleware** `jwt.middleware.js` en `ms-usuarios/src/api/middlewares/` y `ms-agenda/src/api/middlewares/` (mismo patrón que ya existía en `ms-tutorias`: lee `Authorization: Bearer <token>`, valida con `jwt.verify` contra `config.jwtSecret`, adjunta `req.user`).
- Middleware conectado a **todas** las rutas de `ms-usuarios/src/api/routes/usuarios.routes.js` y `ms-agenda/src/api/routes/agenda.routes.js`.
- `ms-agenda/package.json`: se agregó `jsonwebtoken` (no lo tenía). `ms-usuarios/package.json` ya lo tenía pero no se usaba.
- `ms-agenda/src/config/index.js` y `ms-usuarios/src/config/index.js`: se agregó `jwtSecret: process.env.JWT_SECRET`.
- **Reenvío de token en `ms-tutorias`**:
  - `ms-tutorias/src/api/controllers/tutorias.controller.js`: extrae `req.header('Authorization')` y lo pasa como `options.authHeader` a `tutoriaService.solicitarTutoria`.
  - `ms-tutorias/src/domain/services/tutoria.service.js`: recibe `authHeader` y lo reenvía en cada llamada a `usuariosClient.getUsuario` y `agendaClient.*` (incluida la compensación síncrona dentro del mismo `catch`).
  - `ms-tutorias/src/infrastructure/clients/usuarios.client.js` y `agenda.client.js`: cada función (`getUsuario`, `verificarDisponibilidad`, `bloquearAgenda`, `cancelarBloqueo`) acepta ahora un parámetro `authHeader` y lo agrega como header `Authorization` en la llamada `axios`.
  - `ms-tutorias/src/infrastructure/workers/compensacion.worker.js`: firma un JWT de servicio (`jwt.sign({ sub: 'ms-tutorias', role: 'service' }, config.jwtSecret, { expiresIn: '1m' })`) antes de cada llamada a `cancelarBloqueo`.
- **Gap preexistente detectado y corregido**: `ms-tutorias/.env` y `.env.example` nunca definían `JWT_SECRET` (a pesar de que el propio middleware de `ms-tutorias` ya dependía de esa variable). Se agregó a ambos archivos.
- `docker-compose.yml`: se agregó `JWT_SECRET` a los servicios `ms-usuarios` y `ms-agenda` (ya lo tenían `ms-auth` y `ms-tutorias`).
- `.env.example` de `ms-usuarios` y `ms-agenda`: se agregó `JWT_SECRET`.
- `ms-agenda/test/agenda-routes.test.js`: el test de rutas no enviaba ningún token; se actualizó para firmar un JWT de prueba (`process.env.JWT_SECRET` fijado antes de requerir la app) y enviarlo en `Authorization`.

### Verificación

- Tests: `ms-tutorias` 42/42, `ms-agenda` 2/2.
- Manual: `GET /usuarios/estudiantes/:id`, `POST /agenda/tutores/:id/bloquear` y `DELETE /agenda/bloqueos/:id` sin token → `401` (antes: `200`/`201` sin restricción).
- End-to-end: `POST /v1/tutorias` con JWT real → `201 CONFIRMADA`, orquestando llamadas autenticadas a ambos servicios.

### Nota aparte (no bloqueante)

El `.env` local de cada servicio queda copiado dentro de la imagen Docker (`dotenv injecting env (N) from .env` en los logs del contenedor). No rompe nada porque `docker-compose.yml` inyecta las variables reales como env vars del proceso, con prioridad sobre cualquier `.env` embebido en la imagen — pero vale la pena agregar `.env` al `.dockerignore` de cada servicio antes de un despliegue real.

---

## A2 — Credenciales en `ms-auth/user.repository.js`

### Problema

- El archivo real es `ms-auth/src/infrastructure/repositories/user.repository.js` (no en `ms-usuarios`, que no tiene tabla de usuarios propia).
- Las contraseñas ya estaban hasheadas con bcrypt en `passwordHash`, pero el texto plano quedaba expuesto en comentarios (`// Contraseña: "password_ana"`, `// Contraseña: "password_elena"`, y un hash de ejemplo con `"password123"` en la cabecera del archivo).
- `usersDB` seguía siendo un array en memoria, no almacenamiento real.

### Cambios

**Quick fix:** eliminados todos los comentarios con contraseñas en texto plano.

**Migración a Postgres:**

- Nueva base `db_auth` (tabla `users`: `id`, `username`, `passwordHash`, `name`, `role`), seedeada con los mismos dos usuarios demo, reutilizando los mismos hashes bcrypt ya existentes.
- `ms-auth/src/infrastructure/repositories/user.repository.js`: reescrito para consultar Postgres, mismo patrón de manejo de "tabla no inicializada" que `ms-usuarios/usuarios.repository.js`.
- Nuevo `ms-auth/src/config/db.js` (pool `pg`).
- `ms-auth/src/domain/services/auth.service.js`: ajustado de `user.passwordHash` a `user.passwordhash` (Postgres pliega identificadores sin comillas a minúsculas).
- `ms-auth/package.json`: agregado `pg`.
- `docker-compose.yml`: nuevo servicio `db-auth` (puerto host `5435`, volumen `postgres_data_auth`), variables de BD agregadas a `ms-auth`.
- `docs/setup-and-usage.md`: nueva sección de inicialización para `db_auth`.
- `docs/service-catalog.md`: actualizada la fila de `ms-auth`.

### Verificación

- Test existente de `ms-auth` sigue pasando.
- Manual: login correcto → `200` + JWT; incorrecto → `401`. Contra Postgres real.
- End-to-end: token desde la BD real → `POST /v1/tutorias` → `201 CONFIRMADA`.

---

## A3 — Fallbacks y secretos hardcodeados en `docker-compose.yml`

### Cambios

- Todos los `${VAR:-default}` reemplazados por `${VAR:?mensaje}` (variable obligatoria; falla explícita si falta).
- 4 contraseñas de BD parametrizadas (`AUTH_DB_PASSWORD`, `USUARIOS_DB_PASSWORD`, `AGENDA_DB_PASSWORD`, `TUTORIAS_DB_PASSWORD`), coordinadas entre cada servicio y su Postgres.
- Nuevo `.env.example` raíz documentando las 8 variables obligatorias; nuevo `.env` raíz (gitignorado) con los valores de desarrollo previos para no romper el entorno local.
- `docs/setup-and-usage.md`: agregado el paso `cp .env.example .env` en la raíz.

### Verificación

- `docker compose config --quiet` valida correctamente con `.env` presente.
- Sin `.env`, falla explícitamente (`required variable ... is missing a value`).
- Stack completo funcionando sin recrear contenedores; end-to-end sigue funcionando.

---

## A4 — Hardening HTTP (`helmet`, `cors`, `express-rate-limit`)

### Cambios

- `helmet`, `cors`, `express-rate-limit` agregados a `package.json` y `app.js` de los 5 servicios (`ms-auth`, `ms-usuarios`, `ms-agenda`, `ms-tutorias`, `ms-notificaciones`), aplicados globalmente antes de cualquier ruta:

  ```js
  app.use(helmet());
  app.use(cors());
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
  ```

- No se tocó `client-mobile-sim` ni `tracking-dashboard` (fuera del alcance del hallazgo).

### Verificación

- 51 tests pasando en los 5 servicios.
- Headers confirmados con `curl -D -`: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Access-Control-Allow-Origin`, `RateLimit-*`.
- End-to-end sigue funcionando con el hardening activo.

---

## A5 — Fuga de información interna en errores de `ms-tutorias`

### Hallazgo tal como se reportó

`ms-tutorias/src/api/middlewares/errorHandler.js` usaría `err.message || 'genérico'` (mostrando siempre el mensaje si existe), a diferencia de los otros 4 servicios que solo exponen `err.message` si el error trae `statusCode` explícito. Combinado con el catch-all de `tutoria.service.js`, un error interno crudo (timeout, `ECONNREFUSED`, excepción de Postgres) podría llegar tal cual al cliente de `POST /tutorias`.

### Estado real verificado

**Ya estaba resuelto.** Al revisar el archivo actual, tanto `errorHandler.js` (comentario `E3`, línea 10: `err.statusCode ? err.message : 'genérico'`) como el saneo en `tutoria.service.js` (comentario `E4`, líneas 121-127: `tieneMensajeParaCliente` solo es `true` si el error viene de una respuesta HTTP real o de un throw deliberado con `statusCode`) ya tenían la lógica correcta. Confirmado con `git log -- ms-tutorias/src/api/middlewares/errorHandler.js`: el fix llegó en el commit `2997b37` ("harden saga resilience, error handling and API versioning"), que ya estaba en `main` y se trajo a esta rama con un merge antes de iniciar la revisión de seguridad. El hallazgo estaba basado en una versión anterior del código.

Nota técnica sobre por qué sigue siendo un fix real y necesario en general (no solo un falso positivo): antes de este fix, la llamada `tutoriaRepository.findByIdempotencyKey(...)` en `tutoria.service.js` ocurre **antes** del `try/catch` de la Saga — un error crudo ahí (ej. tabla no inicializada) no pasa por el saneo E4 y llega directo al controller → `errorHandler.js`. Con el `errorHandler.js` ya corregido, ese camino también queda cubierto.

### Nota menor (limpieza, no hallazgo de seguridad)

Se revisó **todo el repositorio** buscando `throw` de objetos planos (`throw { statusCode, message }`) vs. instancias reales de `Error` (`throw Object.assign(new Error(...), { statusCode })`). Se encontró **una sola** ocurrencia de objeto plano (no la mezcla amplia entre servicios que describía la nota original): `ms-agenda/src/api/controllers/agenda.controller.js:13`. Se corrigió a una instancia real de `Error`, consistente con el resto del código (que ya usaba `Object.assign(new Error(...), ...)` en `ms-tutorias` y `ms-auth`).

### Verificación

- Tests de `ms-agenda` siguen pasando (2/2) tras el cambio.

---

# Frente B — Exposición de la ruta de solicitud de tutorías (Kong/Ingress)

## B1 — Consolidación de Ingress

### Problema

- `kubernetes-manifests/public-ingress.yaml` exponía `/tutorias` **sin ninguna protección** (comentario propio del archivo: "AÑADIMOS LA RUTA DE TUTORÍAS AQUÍ" — bypass total).
- `kubernetes-manifests/protected-ingress.yaml` sí protegía `/tutorias` con el plugin JWT.
- `kubernetes-manifests/kong-ingress.yaml` aplicaba el plugin JWT a **nivel de Ingress completo**, cubriendo también `/auth` por error (el propio endpoint de emisión de tokens quedaría exigiendo un JWT para poder pedir uno).
- Tres manifiestos redundantes e inconsistentes entre sí para las mismas rutas.

### Cambios

- Eliminados `public-ingress.yaml`, `protected-ingress.yaml` y `kong-ingress.yaml` (se verificó antes que solo `docs/api-security-controls.md` los referenciaba).
- Nuevo `kubernetes-manifests/main-ingress.yaml`: un único `Ingress` (`main-api-ingress`) con `/auth` → `ms-auth-service` y `/tutorias` → `ms-tutorias-service`, **sin** anotación de plugin a nivel de Ingress.
- El plugin `jwt-validation-plugin` se anotó en su lugar sobre el **Service** `ms-tutorias-service` (`kubernetes-manifests/ms-tutorias.yaml`) — ese es el nivel de scoping correcto en Kong Ingress Controller para proteger un backend específico sin afectar a otros que comparten el mismo Ingress. `ms-auth-service` no lleva esa anotación: `/auth` queda público por diseño explícito, no por omisión.
- `docs/api-security-controls.md` actualizado (tabla de cobertura, sección Kong, rutas protegidas, riesgos/pendientes) para reflejar la consolidación.

### Verificación

- Sintaxis YAML revisada manualmente (indentación, estructura de documentos).
- No se pudo correr `kubectl apply --dry-run` real: este entorno no tiene un cluster Kubernetes conectado (el proyecto usa Docker Compose para desarrollo local). Ver B3.

## B2 — Secreto de Kong y `KongConsumer`

### Corrección al hallazgo original

El `KongConsumer` en `kong-security.yaml` se llama `mobile-app-consumer` (no está fijado a "e12345"). Lo que sí está fijo a `e12345` es la **credencial JWT** (`stringData.key`), que ata la validación de Kong al `sub` de una sola usuaria demo (Ana Torres).

### Decisión (confirmada con el usuario)

Se documenta como **limitación conocida del alcance académico/demo**, no como algo a implementar ahora. Implementar aprovisionamiento dinámico real (`ms-auth` u otro proceso llamando a la Kong Admin API para crear/actualizar la credencial JWT por usuario) es un cambio de arquitectura mayor, fuera de alcance.

### Cambios

- `kubernetes-manifests/kong-security.yaml`: agregado un comentario explícito junto a la credencial explicando la limitación (un JWT válido de `ms-auth` para cualquier otro usuario, ej. Elena Solano `t09876`, sería rechazado por Kong al no tener credencial propia) y qué se necesitaría para resolverlo de verdad.
- `docs/api-security-controls.md`: nueva sección "Limitación conocida" bajo Kong/API Gateway, explicando el mecanismo, el riesgo y el camino de solución real.
- Se reafirmó que `app-jwt-secret` (placeholder `CHANGE_ME_WITH_APP_JWT_SECRET`) debe salir del repo y gestionarse externamente antes de cualquier despliegue no local, mismo criterio que A3.

## B3 — Prueba de no-bypass

Con B1 resuelto, la prueba queda **lista para ejecutarse**: `POST /tutorias` sin `Authorization` contra el dominio público debería responder `401` (aplicado ahora vía el plugin anotado en el Service). **No se pudo ejecutar en este entorno** porque no hay un cluster Kubernetes/Kong conectado (este proyecto corre en Docker Compose para desarrollo local, no en K8s activo). Pendiente de ejecutar cuando exista un cluster de prueba disponible.

---

## Pendientes / seguimiento sugerido

- Ejecutar B3 (prueba de no-bypass) en un cluster real con Kong desplegado.
- Evaluar si el curso requiere resolver B2 con aprovisionamiento dinámico real, o si la documentación de la limitación es suficiente para efectos académicos.
- Agregar `.env` al `.dockerignore` de cada servicio para no hornear el `.env` local dentro de la imagen Docker (ver nota en A1).
- Considerar si vale la pena una matriz de roles más formal ahora que hay más servicios verificando JWT (hoy solo `ms-tutorias` valida `role: student`; `ms-usuarios`/`ms-agenda` verifican firma pero no rol).

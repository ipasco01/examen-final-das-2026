# Checklist de despliegue — Zona Deployment (Equipo 5)

Qué debe existir y verificarse **antes** de dar por desplegado el sistema. Cada punto es
verificable con un comando: si no se puede comprobar, no está hecho.

Rama: `equipo5-deployment` · Ultima verificacion completa: 20/07, **22 servicios en compose
(21 con healthcheck)** y 13 workloads en Kubernetes (7 StatefulSets + 6 Deployments + ingress),
con el pipeline de trazas portado y verificado.

La tag de imagen NO se fija en este documento a proposito: es `git rev-parse --short HEAD` del
commit desplegado, y queda obsoleta en cuanto alguien commitea. Ver seccion 2.

---

## 0. Origen de cada secreto (quién lo define)

Confusión frecuente: **ningún secreto se "pide" a otro equipo salvo el JWT**. RabbitMQ y
PostgreSQL corren en contenedores propios: sus variables no consultan credenciales
existentes, las **crean** en el primer arranque.

| Variable | Quién la define | Debe coincidir con |
|---|---|---|
| `AUTH_DB_PASSWORD` | Equipo 5 | — |
| `USUARIOS_DB_PASSWORD` | Equipo 5 | — |
| `AGENDA_DB_PASSWORD` | Equipo 5 | — |
| `TUTORIAS_DB_PASSWORD` | Equipo 5 | — |
| `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` | Equipo 5 | usuario y password dentro de `RABBITMQ_URL` |
| `GRAFANA_ADMIN_PASSWORD` | Equipo 5 | — |
| `JWT_SECRET` | **Equipo 3 (Seguridad)** | el mismo string en `.env`, en el Secret `app-jwt-secret` y en la credencial JWT del consumer de Kong |

⚠️ **Cuidado con el volumen de RabbitMQ.** Si se cambia `RABBITMQ_DEFAULT_PASS` después del
primer arranque, el volumen persistente conserva el usuario viejo y el nuevo valor se ignora.
Para rotarla hay que borrar el volumen (`docker compose down -v`) o crear el usuario a mano.

---

## 1. Configuración

- [ ] Existe `.env` en la raíz, copiado de `.env.example`, sin ningún valor `cambia-esta-password`.
- [ ] Las 5 bases tienen su script en `docker/init/<base>/01-schema.sql`. Postgres los ejecuta
      solo en la PRIMERA inicializacion del volumen: si la base ya existe, el script NO corre.
      Para aplicarlo sobre una base existente:
      `docker exec -i db_tutorias_postgres psql -U user_tutorias -d db_tutorias < docker/init/tutorias/01-schema.sql`
- [ ] `.env` **no** está trackeado por git: `git check-ignore .env` devuelve `.env`.
- [ ] Existe `kubernetes-manifests/app-runtime-secrets.yaml` (copiado de `examples/app-runtime-secrets.example.yaml`), con los
      **mismos valores** que el `.env`, y sin ningún `COMPLETAR`.
- [ ] El placeholder `CHANGE_ME_WITH_APP_JWT_SECRET` de `kong-security.yaml` fue reemplazado por
      el `JWT_SECRET` real, **en los dos lugares** donde aparece (Secret `app-jwt-secret` y
      credencial del consumer). Deuda conocida del Equipo 3, documentada en
      `docs/api-security-controls.md`.

```bash
grep -r "COMPLETAR\|CHANGE_ME\|cambia-esta" .env kubernetes-manifests/*.yaml   # no debe devolver nada
```

---

## 2. Imágenes

Regla: **una imagen se construye una vez, se etiqueta con el SHA del commit, se verifica antes
de publicarse.** Nunca `latest` en un manifiesto.

- [ ] `IMAGE_TAG` = SHA corto del commit desplegado (`git rev-parse --short HEAD`).
- [ ] Las 5 imágenes están construidas y etiquetadas como `ghcr.io/elcbas/ms-*:$IMAGE_TAG`.
- [ ] `docker-compose.yml` y los manifiestos de K8s referencian **la misma tag**.
- [ ] Cada imagen responde `/metrics` con HTTP 200 antes del push.
- [ ] Las imágenes están publicadas en GHCR (`docker push`).

```powershell
$env:IMAGE_TAG = git rev-parse --short HEAD
docker compose up -d --build
docker compose ps                                  # 22 servicios arriba
foreach ($p in 4000,3001,3002,3003,3000) { curl.exe -m 5 -f "http://localhost:$p/metrics" > $null; "$p -> $LASTEXITCODE" }
```

Los cinco deben imprimir `-> 0`. Puertos: ms-auth 4000, ms-usuarios 3001, ms-agenda 3002,
ms-notificaciones 3003, ms-tutorias 3000.

---

## 3. Docker Compose

- [ ] Los 22 servicios levantan con un solo `docker compose up -d`.
- [ ] **21 de los 22** servicios llegan a `healthy` (no solo `Up`). El unico restante es
      `otel-collector`, y la razon esta comprobada y tiene dueño.

**Hallazgo del 19/07 (noche): `ms-notificaciones` sin base de datos.** El merge del Equipo 2
incorporo `src/config/db.js` y `logNotificacion.repository.js`, que hacen INSERT/SELECT sobre
`logs_notificacion` en cada notificacion para deduplicar por `correlation_id`. Pero no existia
ninguna base para ese servicio: ni el servicio en compose, ni el volumen, ni las variables `DB_*`,
ni manifiesto en K8s. Ya existia `docker/init/notificaciones/` -- sin ninguna base que lo montara.

`new Pool({host: undefined})` cae al default `localhost`, que dentro del contenedor no tiene
Postgres. **Es el mismo patron del primer hallazgo** (`ms-auth` sin variables de BD), repetido tres
dias despues con otro servicio y otro equipo.

Corregido: servicio `db-notificaciones` (puerto 5436, healthcheck, volumen, init montado),
variables en `ms-notificaciones` con `depends_on: service_healthy`, StatefulSet + Service + PVC en
`kubernetes-manifests/db-notificaciones.yaml`, y la clave en el Secret y en `.env.example`.
Ademas se renombro `01-shema.sql` a `01-schema.sql`.

**Hallazgo del 20/07: `ms-notificaciones` sin `JWT_SECRET` en compose.** Mismo servicio, misma
revision, otra variable. El Equipo 2 agrego `jwt.middleware.js` y lo monto en
`POST /notificaciones/:canal`; el middleware hace `jwt.verify(token, config.jwtSecret)`. La
variable estaba definida en el Deployment de Kubernetes pero **no** en compose, porque los otros
cuatro microservicios ya la tenian de antes y este quedo fuera al incorporarse el middleware
despues. Con el secreto en `undefined`, `jwt.verify` lanza, el `catch` responde 401 y **todo token
valido se rechaza**: el mismo token funcionaba en el cluster y fallaba en compose.

Corregido con la misma guarda que el resto: `JWT_SECRET=${JWT_SECRET:?...}`. Vale la pena notar
la direccion del error -- las nueve veces anteriores el manifiesto de K8s iba atras del compose;
esta vez fue al reves. La leccion no es "revisar K8s", es que **cualquier entorno que no se
ejecute se desincroniza**, sin importar cual.

**Hallazgo del 20/07: dos servicios corrian con `:latest` y mi propio lint no lo veia.**
`client-sim` y `tracking-dashboard` declaraban `build:` pero no `image:`. Docker les genera el
nombre a partir del proyecto y le agrega `:latest` -- la deuda que este PR supuestamente habia
cerrado. Se descubrio leyendo la salida de un `docker compose build`
(`naming to ...-client-sim:latest`), no por el chequeo que existe para detectar justamente eso.

**Por que el lint fallaba.** Hacia `docker compose config | grep "image:.*:latest"`. Un servicio
sin clave `image:` no produce ninguna linea `image:` en esa salida -- comprobado. El grep no
encontraba nada y el job pasaba en verde. **Un grep solo puede fallar sobre lo que esta escrito, y
aca el caso peligroso era la AUSENCIA de una clave.**

Lo revelador es que el chequeo de `restart`, tres lineas mas abajo en el mismo workflow, nunca
tuvo este problema: parsea el YAML y pregunta `if 'restart' not in s`. Pregunta por la ausencia.
La tecnica correcta ya estaba en el archivo; el error fue elegir un grep para el chequeo de al
lado. Corregido: ahora ambos parsean el YAML.

**Hallazgo del 20/07: el CI no verificaba healthchecks -- justo la regla fundacional de esta zona.**
El merge `b4d0a8a` del Equipo 4 incorporo `alertmanager` y `mailpit`. Los dos con `restart` y con
imagen fijada por version: **incorporaron las dos reglas que este PR venia peleando**, lo cual es
una buena noticia sobre el proceso. Pero los dos sin `healthcheck`, y **ningun job dijo nada**.

El pipeline validaba `restart`, `:latest` y secretos. D1 -- "un proceso vivo pero sin responder
figura como `Up` y compose lo da por bueno" -- era la unica regla de la politica sin chequeo
automatico. La misma forma que el hueco del lint de `:latest`, dos horas antes: **un control que
parece cubrir la politica y deja pasar lo que mas importa.**

La diferencia, y por eso vale registrarlo aparte: este se encontro **revisando trabajo entrante
antes de integrarlo**, no despues de que rompiera algo. Es el primero de los catorce hallazgos
detectado de forma preventiva.

Corregido en el mismo merge: healthcheck en ambos (`/-/healthy` en 9093, `/readyz` en 8025), el
`depends_on: - mailpit` cambiado a `condition: service_healthy` -- Alertmanager arrancaba antes de
que el SMTP escuchara, y una alerta disparada en esa ventana se perdia sin ruido -- y un chequeo
nuevo en el workflow con una lista explicita de exenciones, hoy solo `otel-collector`.

Verificado en las dos direcciones: el chequeo pasa con el compose corregido y **falla contra el
estado exacto en que llego del Equipo 4**.

**Limite honesto de nuestro propio CI:** el job `arranque-real` NO habria detectado esto. El
servicio arranca bien y responde `/metrics`; el fallo aparece recien en la primera notificacion que
intenta deduplicar. Para atraparlo hace falta un test de integracion que ejercite el flujo, no solo
un chequeo de arranque. **Cerrado el 20/07** con `scripts/integracion-flujo-completo.sh`.

**El test de integracion (deuda #11, cerrada).** Seis pasos: login, catalogo de tutores, solicitar,
y despues dos EFECTOS que solo existen si la cadena completa funciono -- mas el rechazo de una
materia incoherente, para que nadie borre esa validacion sin que salte.

```bash
bash scripts/integracion-flujo-completo.sh     # tambien corre en el job arranque-real
```

| Paso | Que verifica | Que hallazgo habria atrapado |
|---|---|---|
| 4 | fila en `logs_notificacion`, esperando con reintentos | **#10** -- la BD que no existia |
| 5 | el endpoint protegido acepta el token | **#11** -- el `JWT_SECRET` faltante |
| 6 | materia incoherente devuelve 400 | que alguien borre la validacion del paso 1b |

Tres decisiones que valen mas que el script:

1. **La materia se lee del sistema, no se hardcodea.** Sale de `GET /usuarios/tutores`. Si cambia
   el seed, el test sigue andando -- el error opuesto al del formulario del simulador, que tenia la
   fecha escrita a mano y caduco sola.
2. **Sin `python3` ni `jq`: solo bash, curl, date, openssl y sed.** Corre igual en `ubuntu-latest`
   y en Git Bash sobre Windows. Un chequeo que solo corre en el CI nadie lo ejecuta antes de
   pushear, y entonces tiene el mismo problema que viene a resolver. La concesion es que parsear
   JSON con `grep`/`sed` es fragil ante cambios de formato; queda dicho en el encabezado.
3. **Horario aleatorio dentro del proximo año.** La v1 pedia siempre `hoy + 7 dias` y devolvia 409
   en la segunda corrida, porque ms-agenda rechaza correctamente la reserva superpuesta. **Un test
   que escribe datos reales no es repetible si el horario es fijo** -- y habria pasado
   desapercibido, porque en CI el stack nace vacio en cada corrida: verde siempre, inservible en
   local. Es la forma exacta de los hallazgos #10 y #11: sano en un entorno, roto en el otro.

El punto 3 aparecio ejecutando el script, no escribiendolo. Sigue valiendo la regla.

**Correccion del 19/07 — dos rondas, las dos las provoco la revision cruzada.**

Este documento afirmaba primero que 4 servicios "no podian tener healthcheck porque usan imagenes
distroless sin shell". Nunca se ejecuto un comando para verificarlo. Al hacerlo, la afirmacion
resulto falsa para 3 de los 4:

| Servicio | Que se comprobo | Solucion aplicada |
|---|---|---|
| `tempo` | Tiene shell y `/usr/bin/wget` | `wget /ready` |
| `promtail` | Sin `wget`/`curl`/`nc`, pero con `bash` + `/dev/tcp` | socket TCP al 9080 |
| `toxiproxy` | Sin shell, pero **con su propio cliente** `/toxiproxy-cli` | `CMD` (no `CMD-SHELL`) sobre `toxiproxy-cli list` |
| `otel-collector` | Sin shell; trae `/otelcol-contrib` pero sus 4 subcomandos son offline (`validate`, `components`, `help`, `completion`) -- ninguno consulta al collector corriendo | Imposible en compose sin cambiar la imagen base, ver abajo |

**La segunda correccion fue la mas instructiva.** Tras arreglar `tempo` y `promtail`, este
documento seguia diciendo que `toxiproxy` no podia tener healthcheck "por falta de shell". Eso era
verdad a medias: la conclusion correcta era **"no puede con `CMD-SHELL`"**. Docker ofrece tambien
`CMD`, que ejecuta un binario directo sin shell -- y la imagen trae `/toxiproxy-cli`. La opcion
estuvo siempre disponible; el error fue generalizar una limitacion real (`wget` no existe) a una
conclusion mas amplia de lo que los datos permitian.

Este chequeo ademas es **mejor** que el de un socket TCP: `toxiproxy-cli list` no solo confirma que
el puerto 8474 escucha, sino que la API de administracion responde y devuelve la configuracion de
proxies.

**El unico pendiente real: `otel-collector`, y la razon NO es la que este documento decia.**

Durante dias aqui figuro que "la solucion existe pero no esta en mi zona: hay que activar la
extension `health_check` en `otel-collector-config.yaml` (puerto 13133)". **Eso era incorrecto para
compose**, y el error es sutil: mezcla dos mecanismos que se ejecutan en lugares distintos.

| | Quien ejecuta la verificacion | Necesita un binario dentro del contenedor |
|---|---|---|
| Probe `httpGet` de Kubernetes | el **kubelet**, desde fuera del contenedor | **No** |
| `healthcheck` de Docker Compose | el propio contenedor | **Si** |

Activar `health_check` abre un puerto HTTP. En Kubernetes eso alcanza, porque el kubelet hace la
peticion desde afuera. En compose no alcanza: Docker corre el comando *adentro*, y hay que tener con
que llamar a ese puerto.

**Comprobado el 20/07, en este orden y no al reves:**

```bash
docker exec otel-collector /bin/sh -c "echo hola"   # -> stat /bin/sh: no such file or directory
docker exec otel-collector ls /                     # -> "ls": executable file not found in $PATH
docker exec otel-collector /otelcol-contrib --help  # -> completion | components | help | validate
```

El tercer comando es el que importa, y es la leccion de `toxiproxy` aplicada: antes de decir "no se
puede", buscar si la imagen trae su propio cliente. Aca lo trae, pero sus cuatro subcomandos son
**offline**: `validate` revisa el archivo de configuracion sin arrancar nada y `components` lista lo
compilado. Ninguno consulta a un collector en ejecucion.

**Conclusion, ahora si respaldada:** en Docker Compose este servicio no puede tener healthcheck sin
cambiar la imagen base (por ejemplo, una imagen propia que agregue un binario estatico). No es un
pendiente del Equipo 4: activar la extension no resuelve compose. Lo que si corresponde pedirles es
activarla **de cara al port a Kubernetes**, donde una probe `httpGet` al 13133 funciona sin nada
adentro del contenedor:

```yaml
extensions:
  health_check:
    endpoint: 0.0.0.0:13133
service:
  extensions: [health_check]
```

**Por que vale la pena registrar este error.** Es el tercero del mismo tipo -- despues de la
afirmacion sin verificar sobre los 4 distroless y del "no se puede" sobre `toxiproxy`. Los tres
comparten la forma: **una limitacion real generalizada mas alla de lo que los datos permitian.**
Aqui era cierto que falta la extension; lo falso era que activarla resolviera el healthcheck de
compose. Una recomendacion correcta para un entorno, presentada como valida para los dos.

**Metodo, en orden, antes de declarar que algo "no se puede":**

```bash
docker run --rm --entrypoint sh   <imagen> -c "command -v wget curl nc"   # 1. herramientas HTTP
docker run --rm --entrypoint bash <imagen> -c "exec 3<>/dev/tcp/1.1.1.1/80"  # 2. socket nativo
docker run --rm --entrypoint <cliente-propio> <imagen> <subcomando>       # 3. binarios de la imagen
```

El paso 3 es el que se salteo dos veces. Casi toda imagen de servidor trae su propio cliente.
- [ ] Ningún servicio arranca antes que su dependencia (`condition: service_healthy`).
- [ ] Un contenedor matado se recupera solo (`restart: unless-stopped`).
- [ ] Ninguna imagen usa `latest`.

```bash
docker compose ps                        # 4 db + rabbitmq en (healthy)
docker kill db_usuarios_postgres         # debe reaparecer Up en segundos
docker compose config | grep -E "image:.*latest"   # sin resultados
```

---

## 4. Kubernetes

**El orden importa, y no es el intuitivo.** Verificado en el despliegue del 18/07:

Son DOS Secrets. `app-runtime-secrets` (nuestro) y `app-jwt-secret` (de `kong-security.yaml`,
Equipo 3). Y los valores reales de los secretos se inyectan **DESPUES** del apply masivo, no
antes: `kubectl apply -f kubernetes-manifests/` vuelve a aplicar `kong-security.yaml`, que trae
el placeholder `CHANGE_ME_WITH_APP_JWT_SECRET` y pisa cualquier valor real cargado antes. Es la
misma clase de error que motivo mover la plantilla a `examples/`.

```powershell
# 1. Manifiestos (crea Secrets con placeholders, StatefulSets, Deployments, Services)
kubectl apply -f kubernetes-manifests/

# 2. Secret de datos, con valores reales
kubectl apply -f kubernetes-manifests/app-runtime-secrets.yaml

# 3. JWT real, DESPUES del apply masivo. Sin JSON inline: PowerShell no escapa bien las comillas
#    y kubectl recibe los \" literales.
$jwt = "<el JWT_SECRET del .env raiz>"
kubectl create secret generic app-jwt-secret --from-literal=JWT_SECRET=$jwt --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic mobile-app-consumer-jwt-credential --from-literal=key=e12345 --from-literal=secret=$jwt --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate secret mobile-app-consumer-jwt-credential konghq.com/consumer=mobile-app-consumer konghq.com/credential-type=jwt --overwrite

# 4. Reiniciar: las env desde Secret se leen al arrancar el pod, no se recargan solas
kubectl rollout restart deployment ms-auth-deployment ms-usuarios-deployment ms-agenda-deployment ms-tutorias-deployment ms-notificaciones-deployment

kubectl get pods
kubectl get pvc
```

Errores esperados que NO son fallas: `no matches for kind "KongPlugin"` y `"KongConsumer"`.
Son CRDs de Kong, que no esta instalado en el cluster local. Los Secrets si se crean.

- [ ] Los 6 StatefulSets (5 bases + RabbitMQ) llegan a `Ready` con su PVC en `Bound`.
- [ ] Los 5 Deployments llegan a `1/1 Running`, no `CrashLoopBackOff`.
- [ ] Ningun pod arranca con el placeholder: si se salteo el paso 3, los microservicios corren
      con `CHANGE_ME_WITH_APP_JWT_SECRET` como secreto de firma y ningun token real valida.

```powershell
kubectl get pvc                                    # todos Bound
kubectl get pods -o wide                           # ninguno en CrashLoopBackOff
kubectl exec deploy/ms-auth-deployment -- printenv JWT_SECRET   # NO debe decir CHANGE_ME
```

Rollback de un servicio: `kubectl rollout undo deployment/<nombre>`.

---

## 5. Antes de subir réplicas

No tocar `replicas` hasta que **todo** lo anterior esté verde. Escalar un servicio cuya imagen
o cuya probe falla no arregla nada: multiplica los pods que fallan y hace el diagnóstico más
confuso.

- [ ] Los 5 servicios estuvieron `Ready` con imagen propia durante al menos un ciclo de probes.
- [ ] Existe PodDisruptionBudget antes de declarar alta disponibilidad.
- [ ] Las bases no se escalan horizontalmente sin resolver primero la replicación de datos.

---

## La deuda vuelve sola: evidencia del 18/07

Al mergear `main` en la rama, el merge trajo dos servicios nuevos del Equipo 4 — `tempo` y
`otel-collector` — **sin `restart` y con `:latest`**. Son exactamente las dos deudas que este PR
habia cerrado (issues 2 y 6), reintroducidas por otro equipo en un solo merge.

No es un reproche al Equipo 4: cada equipo agrega servicios pensando en su zona, no en la
operacion. Es la demostracion medida de que **sin un check automatico la deuda de deployment
reaparece en cada merge**. Convierte el backlog #2 (CI de validacion) de recomendacion teorica en
hecho observado.

Chequeo minimo que lo habria detectado antes del merge:

```bash
docker compose config | grep -E "image:.*:latest"          # debe devolver vacio
python -c "import yaml;d=yaml.safe_load(open('docker-compose.yml'));print([n for n,s in d['services'].items() if 'restart' not in s])"
```

## Deuda abierta (backlog priorizado)

Actualizado 19/07 tras la auditoria cruzada. Lo que estaba abierto el 18/07 y ya se cerro:
imagenes propias por tag de commit, tempo/otel fijados por digest, esquema de BD versionado en
`docker/init/`, healthchecks en 21 de 22 servicios, HPA + PDB, securityContext, USER no-root y
HEALTHCHECK en los Dockerfiles, y el workflow de CI.

| # | Pendiente | Atributo en riesgo | Duenio |
|---|---|---|---|
| 1 | **Paridad compose ↔ K8s**: compose tiene 22 servicios, K8s cubre 11. Faltan `prometheus`, `grafana`, `loki`, `promtail`, `tempo`, `otel-collector`, `toxiproxy`, `client-sim`, `tracking-dashboard`, `alertmanager`, `mailpit`. Portar Prometheus no es copiar el manifiesto: `static_configs` no funciona en K8s, hace falta `kubernetes_sd_configs` + ServiceAccount con RBAC | Observabilidad | Equipo 5 + Equipo 4 |
| 2 | ~~**`/health` propio en los microservicios**~~ **CERRADO 20/07**: registrado antes del `rateLimit` y sin consultar la BD. Cerro con dos causas observadas -- el 429 del limitador (#19) y el 500 de los Gauges (#17) | Disponibilidad | Equipo 5 + Equipo 4 |
| 3 | **Healthcheck en `otel-collector`** (unico pendiente: `toxiproxy`, `tempo` y `promtail` ya lo tienen). **Comprobado: en compose no se puede sin cambiar la imagen base** -- sin shell, y los 4 subcomandos de `/otelcol-contrib` son offline. Activar la extension `health_check` (puerto 13133) NO resuelve compose, solo habilita una probe `httpGet` cuando se porte a K8s, donde la ejecuta el kubelet desde afuera. Ver seccion 3 | Disponibilidad | Equipo 5 (imagen) + Equipo 4 (extension) |
| 4 | **ConfigMap** para la configuracion no secreta, hoy duplicada inline en cada Deployment | Reproducibilidad | Equipo 5 |
| 5 | **NetworkPolicy**: cualquier pod alcanza cualquier base | Seguridad | Equipo 5 + Equipo 3 |
| 6 | **StorageClass explicita** en los `volumeClaimTemplates` (hoy dependen de la default del cluster) | Portabilidad | Equipo 5 |
| 7 | **Topologia de RabbitMQ declarativa** (`definitions.json`). Hoy exchanges, colas y DLQ nacen de los `assertExchange`/`assertQueue` del codigo: la topologia depende de que servicio arranque primero y con que version | Confiabilidad | Equipo 2 |
| 8 | ~~**Instrumentacion OTel en los microservicios**~~ **CERRADO 19/07** por el merge `f48911e` del Equipo 4: los 5 servicios traen el SDK y arrancan con `node -r ./src/config/tracing.js`. Verificado: `grep -h opentelemetry ms-*/package.json` devuelve 6 paquetes | Observabilidad | Equipo 4 |
| 9 | ~~**Provisioning de Grafana y Alertmanager**~~ **CERRADO 20/07** por el merge `b4d0a8a` del Equipo 4: Alertmanager + Mailpit como SMTP local, dashboard provisionado, y el bloque `alerting` en `prometheus.yml` que faltaba para que las reglas evaluadas le llegaran a alguien | Observabilidad | Equipo 4 |
| 10 | **Separar los workers del proceso HTTP en ms-tutorias**. Cada replica agrega otra copia de los tres pollers compitiendo por las mismas filas; por eso su HPA tiene `maxReplicas: 2` mientras el resto tiene 4 | Escalabilidad | Equipo 1 + Equipo 5 |
| 11 | ~~**Test de integracion que ejercite el flujo, no solo el arranque**~~ **CERRADO 20/07**: `scripts/integracion-flujo-completo.sh`, ejecutado por el job `arranque-real`. Verifica dos EFECTOS que solo existen si la cadena completa funciono -- la fila en `logs_notificacion` (habria atrapado el hallazgo #10) y que el endpoint protegido acepte el token (habria atrapado el #11) | Verificabilidad | Equipo 5 |
| 12 | ~~**Variables OTel ausentes en los 5 Deployments de K8s**~~ **CERRADO 20/07**: portado el pipeline de trazas (`tempo.yaml`, `otel-collector.yaml`) mas las variables en los 5 Deployments. Verificado ejecutando: el collector reporta `resource spans: 5` -- los cinco microservicios exportando a la vez | Observabilidad | Equipo 5 + Equipo 4 |
| 13 | **`enviarEmail` en `ms-tutorias/src/infrastructure/clients/notificaciones.client.js` es codigo muerto y ademas incorrecto.** No lo invoca nadie (la Saga notifica por RabbitMQ), pero hace `axios.post(url, payload)` **sin cabecera `Authorization`**. Si alguien lo conectara, el `jwt.middleware` que el Equipo 2 monto en `POST /:canal` lo cortaria con 401 en el primer `if (!authHeader)`. O se borra el cliente, o se le propaga el token | Mantenibilidad | Equipo 1 + Equipo 2 |
| 17 | **El pipeline de Promtail depende del runtime, no de la plataforma.** `docker: {}` en Docker Desktop (dockerd), `cri: {}` en kind y clusters reales (containerd). Hoy se prioriza la demo. Salidas: detectar el runtime al arrancar, u overlays por entorno con kustomize | Observabilidad | Equipo 5 |
| 15 | **No hay validacion de manifiestos K8s en el CI.** `k8s-lint` valida estructura (probes, resources, version) pero no que los pods arranquen: el job `arranque-real` levanta compose, no Kubernetes. Es lo que dejo el hallazgo #16 invisible un dia entero. Cerrarlo requiere un cluster efimero en CI (kind o k3s) -- el equivalente de la deuda #11, del lado de K8s | Verificabilidad | Equipo 5 |
| 14 | **`materia` no se valida contra nada y no existe un catalogo de materias en el modelo.** Comprobado en ejecucion: se puede solicitar "Fisica Cuantica" al tutor `t09876`, cuya especialidad sembrada es "Calculo Multivariable", y la Saga responde `CONFIRMADA`. La causa de fondo es el modelo: `especialidad` es un `VARCHAR(255)` libre dentro de `tutores`, sin tabla de materias ni relacion tutor-materia, y un tutor solo puede tener una. Por eso tampoco se puede ofrecer un `<select>` en el cliente: no hay catalogo de donde poblarlo, y `ms-usuarios` solo expone `GET /tutores/:id` (busqueda por ID, no coleccion). **Recomendado:** validar `materia` contra la especialidad del tutor en `ejecutarSagaSolicitudTutoria`, despues de resolver al tutor y **antes** de crear la fila PENDIENTE -- es el ultimo punto sin efectos colaterales, asi el rechazo es un `throw` y no un rollback distribuido. Eso es una curita; la solucion real es un catalogo con relacion N:M | Modelo de dominio | Equipo 2 + Equipo 1 |

---

## 8. Portado del pipeline de trazas a Kubernetes (deuda #12) y lo que destapo

Manifiestos nuevos: `kubernetes-manifests/tempo.yaml` y `kubernetes-manifests/otel-collector.yaml`,
cada uno con su ConfigMap, Service y probes. Mas `OTEL_SERVICE_NAME` y
`OTEL_EXPORTER_OTLP_ENDPOINT` en los 5 Deployments.

**Verificacion (no es "aplique y no dio error"):**

```bash
kubectl logs deployment/otel-collector --tail 20
# -> TracesExporter {"resource spans": 5, "spans": 116}
```

`resource spans: 5` son cinco servicios distintos exportando al mismo tiempo.

**Los Services se llaman `tempo` y `otel-collector`, no `tempo-service`**, rompiendo la convencion
del resto de mis manifiestos a proposito: la config del Equipo 4 apunta a `endpoint: tempo:4317`.
Con otro nombre habria que forkear ese archivo, y **dos copias de la misma configuracion es la
fuente de drift que este documento entero viene combatiendo**. Se adapta el nombre del Service, que
es mio, antes que duplicar un archivo ajeno.

**La probe del collector es `httpGet` al 13133** (nacio como `tcpSocket: 4317`). Se activo la
extension `health_check` en `otel-collector-config.yaml` el mismo dia -- cambio aditivo, no toca
receivers, processors ni exporters. Verificado:

```bash
curl http://localhost:13133
# -> {"status":"Server available","upSince":"...","uptime":"192ms"}
```

**Ojo con el detalle que hace falta para que funcione:** declarar la extension en el bloque
`extensions:` NO la carga. Hay que agregarla ademas a `service.extensions: [health_check]`. Sin esa
segunda linea el bloque queda escrito y jamas se activa -- el mismo patron que este documento
persigue hace tres dias, ahora dentro de un archivo de configuracion.

**Y esto NO habilita un healthcheck en compose.** El puerto 13133 se expuso para poder verificarlo
a mano desde el host, pero el healthcheck de Docker corre DENTRO del contenedor y la imagen sigue
sin cliente HTTP. `otel-collector` continua siendo la unica excepcion documentada en el CI. La
asimetria es el punto: **misma imagen, mismo servicio, y una plataforma puede verificarlo y la otra
no**, porque el kubelet consulta desde afuera y Docker desde adentro.

### Hallazgo #16: el endurecimiento D4 rompia las 6 cosas con estado, un dia entero

Al aplicar los manifiestos, **las 5 bases y RabbitMQ entraron en CrashLoopBackOff**:

```
chmod: /var/lib/postgresql/data/pgdata: Operation not permitted   # postgres
su-exec: setgroups: Operation not permitted                        # rabbitmq
```

`capabilities: drop: ["ALL"]` le quita `CHOWN`, `FOWNER` y `SETGID` al entrypoint, que arranca como
root para preparar el volumen y despues baja de usuario con `su-exec`. Sin ellas no puede.

**Lo grave no es el error, es cuanto duro invisible.** El `securityContext` se commiteo el 19/07 a
las 15:04; los PVC son del 18/07 a las 21:00. Los pods que se veian `Running` eran de ANTES del
cambio, y **nadie volvio a aplicar los manifiestos hasta el 20/07**. Escrito, revisado, mergeado,
documentado como hecho, y en verde en el CI -- porque `k8s-lint` valida que existan probes,
resources y version fijada, no que los pods arranquen.

**Es el hallazgo #7 sobre mi propio trabajo.** Y expone el limite real: no hay forma de validar
manifiestos de Kubernetes sin un cluster. El job `arranque-real` levanta compose, no K8s. Es el
equivalente exacto de la deuda #11 --cerrada esta manana-- pero del lado de Kubernetes. Queda como
deuda #15.

Corregido devolviendo el minimo necesario en vez de aflojar el `drop`:
`add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]`.

**Detalle operativo que cuesta caro si no se sabe:** un `kubectl apply` que responde `configured`
NO significa que el cambio este corriendo. Un StatefulSet con `RollingUpdate` no reemplaza un pod
que nunca llego a `Ready` -- espera a que el actual este sano, y como esta en CrashLoop, nunca
avanza. Hay que borrar el pod a mano. **El propio Kubernetes informo como exito algo que no
aplico.**

### Hallazgo #17: el esquema de BD no existia en Kubernetes

Con las bases arriba, `ms-tutorias` seguia muriendo:

```
relation "tutorias_notificaciones_outbox" does not exist   (42P01)
```

En compose el esquema entra por `./docker/init/<base>/01-schema.sql` montado en
`/docker-entrypoint-initdb.d/`. **En Kubernetes eso no tenia equivalente**: ningun StatefulSet
montaba nada, las bases nacian vacias.

**Es el hallazgo #6 hecho a medias.** Ahi el esquema vivia solo como texto en un `.md` y se hizo
ejecutable... para un entorno. La correccion arreglo compose y dejo K8s roto, que es exactamente lo
que este documento le viene senalando al trabajo de los demas.

Corregido: un ConfigMap por base con el SQL, montado en `/docker-entrypoint-initdb.d` como
solo-lectura. Verificado borrando los PVC y dejando que se inicializaran por el camino nuevo --no
aplicando el SQL a mano, que habria arreglado el sintoma sin probar el arreglo:

```
/usr/local/bin/docker-entrypoint.sh: running /docker-entrypoint-initdb.d/01-schema.sql
database system is ready to accept connections
```

**Y la forma en que se manifesto vuelve concreta la deuda #2.** El stack trace era:

```
at async Gauge.collect (backlog.metrics.js:22)
at async Registry.getMetricsAsString (prom-client)
```

El Gauge del Equipo 4 consulta la base cuando alguien pide `/metrics`; las probes apuntan a
`/metrics`. Entonces: falta una tabla -> falla `/metrics` -> falla la liveness -> **Kubernetes mata
el pod**. Un problema de la capa de datos derriba la de computo. La deuda #2 (`/health` propio,
separado de `/metrics`) dejo de ser un riesgo teorico: esto es verla ocurrir.


### Hallazgo #18: el plano de observabilidad no tenia persistencia (ninguno)

Las bases del negocio tienen volumen desde el issue 3. **La observabilidad completa quedo afuera**,
y nadie lo noto porque un Prometheus vacio se ve exactamente igual de sano que uno lleno.

| Servicio | Volumen agregado | Que se perdia en cada reinicio |
|---|---|---|
| `prometheus` | `/prometheus` | el TSDB entero: toda la historia de metricas |
| `grafana` | `/var/lib/grafana` | usuarios, contrasenas cambiadas, anotaciones, paneles hechos a mano |
| `loki` | `/loki` | todos los logs (chunks e indice) |
| `alertmanager` | `/alertmanager` | silencios activos y **el registro de que alertas ya notifico** |
| `promtail` | `/tmp` | el archivo de posiciones de lectura |

**El de Alertmanager es el mas traicionero.** Sin `/alertmanager` persistente, tras cada reinicio
vuelve a notificar alertas que ya habia mandado y pierde los silencios -- justo lo que el
`repeat_interval: 1h` de su configuracion busca evitar. La config del Equipo 4 esta bien pensada;
le faltaba donde apoyarse.

**El de Promtail tiene la forma mas clara de todo el proyecto.** Su config dice:

```yaml
positions:
  # Recuerda hasta dónde leyó cada archivo de log, para no reenviar todo
  # desde cero si Promtail se reinicia.
  filename: /tmp/positions.yaml
```

El comentario **declara una intencion que el despliegue no cumplia**: `/tmp` dentro del contenedor
es efimero. El mecanismo estaba bien escrito y nadie le dio donde persistir. Es la tesis de esta
zona en una sola linea de YAML.

**Dos servicios NO llevan volumen, a proposito, y esta escrito en el compose para que no se lea
como olvido:**

- `otel-collector`: sin estado por diseno. Los spans entran, pasan por el batch processor y salen a
  Tempo. Si el pod muere se pierde a lo sumo un lote de 5s -- perdida aceptable para telemetria, a
  diferencia de una base donde perder un lote es perder datos del negocio.
- `mailpit`: SMTP falso para la demo. Perder los correos de prueba no es una perdida.

**La ruta de Loki se verifico, no se dedujo.** Usa su configuracion interna (no hay archivo
montado), asi que antes de montar nada:

```bash
docker exec loki cat /etc/loki/local-config.yaml | grep path_prefix
# -> path_prefix: /loki
```

Habria apostado por `/tmp/loki`, que es el default de otras versiones de la imagen. Montar en la
ruta equivocada habria dejado el compose con aspecto de arreglado y a Loki perdiendo los logs
igual: **peor que no tocarlo**, porque cierra la pregunta sin resolver el problema.


### Hallazgo #19: el rate limiter mataba los 5 microservicios cada 10 minutos

Al portar el pipeline de trazas quedo el cluster corriendo un rato largo, y aparecio esto:

```
Liveness probe failed: HTTP probe failed with statuscode: 429
Readiness probe failed: HTTP probe failed with statuscode: 429
```

En los cinco. **Es aritmetica, no mala suerte:**

| | Frecuencia | Peticiones en 15 min |
|---|---|---|
| readinessProbe | cada 10s | 90 |
| livenessProbe | cada 15s | 60 |
| **Total por pod** | | **150** |

`app.use(rateLimit({ windowMs: 15*60*1000, max: 100 }))` esta declarado ANTES del middleware de
metricas, asi que `/metrics` --a donde apuntaban las probes-- queda detras del limitador. A los
~10 minutos el kubelet supera las 100 peticiones, empieza a recibir 429, la probe lo cuenta como
fallo y con `failureThreshold: 3` Kubernetes reinicia el pod. **Los pods llevaban 6 reinicios en
65 minutos: uno cada diez.**

El limitador esta bien puesto: protege de abuso de usuarios. El error fue **poner las probes detras
de un control pensado para trafico de usuarios.** Un kubelet no es un usuario.

### Hallazgo #20: `timeoutSeconds` ausente en las probes de las 5 bases

En los mismos eventos:

```
Liveness probe failed: command timed out: "pg_isready -U user_notificaciones ..." timed out after 1s
```

**Un segundo.** Es el hallazgo #4 --documentado para rabbitmq el 18/07-- que nunca se aplico a las
bases: sus probes `exec` no declaraban `timeoutSeconds`, y el default de Kubernetes es 1. Corregido
a 5s en las cinco. Un defecto que se arregla en un servicio y no en los otros cinco sigue siendo el
mismo defecto.

### Deuda #2 cerrada: `/health` propio, y por que va antes del rateLimit

```js
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));  // <- primero
app.use(rateLimit({ max: 100 }));
app.use(metricsMiddleware);
```

El orden ES el arreglo. Y el endpoint **no consulta la base ni el broker**, deliberadamente.

Esta deuda estaba anotada desde el 19/07 con una sola justificacion teorica (el acoplamiento con la
capa de datos). Termino cerrandose con **dos causas independientes, las dos observadas**:

| Causa | Sintoma | Hallazgo |
|---|---|---|
| Rate limiter | 429 tras ~10 min | #19 |
| Gauges que consultan Postgres | 500 al faltar una tabla | #17 |

**Criterio de diseño:** una liveness probe responde "¿hay que reiniciar este proceso?". Reiniciar un
pod no arregla una base caida -- solo le quita una replica a un sistema ya degradado. Por eso el
/health de liveness es tonto a proposito. Una probe que mire dependencias va en un endpoint aparte
y solo para readiness, nunca para liveness.

**Verificacion (no "aplique y no dio error"):** los 5 pods nuevos llevaron **15 minutos con
`RESTARTS 0`**, pasando el umbral de ~10 min donde antes morian, y sin un solo evento 429 nuevo.

### Lo que NO se arreglo, y por que

RabbitMQ acumulo 18 reinicios con `rabbitmq-diagnostics -q ping timed out after 10s`. **No se
toco.** La maquina estaba corriendo el stack de compose completo (22 contenedores) mas Kubernetes
(13 pods) a la vez: ~35 contenedores compitiendo por CPU. Al bajar compose, RabbitMQ se estabilizo
solo y lleva mas de 15 minutos sano sin ningun cambio en su manifiesto.

**Era un artefacto de carga, no un defecto.** Subirle el timeout habria "arreglado" un sintoma
inexistente y ocultado la causa real. Distinguir las dos cosas importa tanto como arreglar: el 429
es determinista y pasa siempre; este dependia del entorno.


### Hallazgo #22: escribi el comentario que describia el error mientras lo cometia

Al portar Promtail puse `cri: {}` en el pipeline, y en el encabezado del manifiesto escribi esto
para justificarlo:

> "Dejar `docker: {}` no da error visible: Promtail arranca, la probe pasa, y los logs llegan a
> Loki **sin parsear**, como una sola cadena inutil. Es la clase de fallo que se ve solo mirando el
> resultado en Grafana, no el estado del pod."

**Describi con precision el fallo que estaba cometiendo, en el comentario que lo justificaba.**
Tenia razon sobre el modo de falla y me equivoque sobre la direccion: asumi que Kubernetes implica
containerd, y **Docker Desktop usa dockerd**. Sus logs son JSON de Docker, igual que en compose.

Como se vio -- comparando dos pantallas, no leyendo nada:

| | Lo que mostraba Grafana |
|---|---|
| **3005** (compose) | `level=info ts=... caller=flush.go:167 msg="flushing stream"` |
| **3006** (Kubernetes) | `{"log":"...\u0009info\u0009TracesExporter...","stream":"stderr","time":"..."}` |

Mientras tanto: pod `Ready`, probe en verde, `daemonset successfully rolled out`, y el job de kind
habria pasado igual. **Ningun chequeo de este proyecto --ni los healthchecks, ni las probes, ni el
CI, ni el test de integracion-- puede detectar esto.** Solo se ve con el resultado a la vista.

Lo encontro Isabel, pidiendo "verificar lo de grafana". Es el segundo hallazgo que sale de una
observacion suya sin que ella supiera lo que estaba senalando (el otro es el #18, los volumenes).

### Deuda #17: el mismo manifiesto necesita configuraciones distintas por runtime

El arreglo del #22 abre un problema que no se puede cerrar sin elegir:

| Entorno | Runtime | Stage correcto |
|---|---|---|
| Docker Desktop (la demo) | dockerd | `docker: {}` |
| kind (el CI) | containerd | `cri: {}` |
| Clusters reales (GKE, EKS...) | containerd | `cri: {}` |

**El manifiesto correcto para la demo es el incorrecto para el pipeline.** Hoy se prioriza el
entorno de la demo y queda anotado; las salidas reales son dos: detectar el runtime al arrancar, o
mantener overlays por entorno (kustomize). Ninguna se hace hoy.

Vale la pena decir lo que esto significa: **es la tesis de esta zona aplicada al ultimo archivo que
escribi, y en su forma mas incomoda.** Los 21 hallazgos anteriores eran cosas que se podian
arreglar para que funcionaran igual en los dos entornos. Este no: la diferencia esta en el runtime,
por debajo de todo lo que este equipo controla. A veces "que funcione igual en todos lados" no es
una meta alcanzable, y lo unico honesto es documentar cual elegiste y por que.

### Ruido eliminado: el plano de control fuera de Loki

Promtail intentaba leer los pods de `kube-system` (coredns, kube-proxy, storage-provisioner,
vpnkit-controller) y llenaba Loki de `failed to tail file, stat failed`. Se agrego un `drop` por
namespace.

No es solo cosmetico: **los logs del plano de control de Kubernetes no son observabilidad de esta
aplicacion.** Quien busque un error quiere ver los microservicios, no el DNS interno del cluster.

### Estado final verificado

13 pods `1/1 Running`: 5 microservicios, 5 bases, RabbitMQ, otel-collector y Tempo.

---

## 6. Autoescalado y disponibilidad (D3)

`kubernetes-manifests/autoscaling.yaml` define HPA (CPU al 70% de `requests`) y PodDisruptionBudget
para los 5 microservicios.

**Dependencia declarada:** el HPA necesita `metrics-server`, que Docker Desktop no instala. Sin el,
los HPA quedan en `TARGETS <unknown>` y no escalan.

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl top pods     # debe devolver CPU/memoria
kubectl get hpa      # TARGETS con porcentaje, no <unknown>
```

- [ ] `kubectl top pods` responde (metrics-server operativo).
- [ ] `kubectl get hpa` muestra porcentajes reales.
- [ ] `kubectl get pdb` muestra los 5 presupuestos.

⚠️ Con un Deployment en 1 replica, un PDB de `minAvailable: 1` **impide el drenaje voluntario del
nodo**: `kubectl drain` espera indefinidamente porque evacuar el unico pod violaria el presupuesto.
Es correcto en produccion (donde el HPA mantiene >= 2). En el cluster local, para drenar:
`kubectl drain <nodo> --disable-eviction`.

---

## 7. Endurecimiento (D4)

Dos mitades del mismo control, y hacen falta las dos:

- **Dockerfile** (`USER node`, uid 1000): la imagen declara con que usuario corre. Aplica tambien
  a quien la ejecute con `docker run`, sin compose ni cluster.
- **`securityContext` del Pod** (`runAsNonRoot`, `allowPrivilegeEscalation: false`,
  `capabilities: drop ALL`): el cluster lo **impone**. Sin esto, una imagen que por descuido
  vuelva a root corre como root y nadie se entera.

En las bases y el broker el `securityContext` es mas conservador: no se fuerza `runAsUser` porque
las imagenes de Postgres y RabbitMQ gestionan su propio uid y el volumen ya tiene los permisos de
ese uid; forzar otro rompe el arranque. Se quitan escalada de privilegios y capabilities.

```bash
kubectl get pod <pod> -o jsonpath='{.spec.securityContext}'   # runAsNonRoot: true
docker inspect ghcr.io/elcbas/ms-auth:<tag> --format '{{.Config.User}}'   # node
```

---


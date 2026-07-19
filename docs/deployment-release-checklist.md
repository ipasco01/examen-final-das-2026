# Checklist de despliegue — Zona Deployment (Equipo 5)

Qué debe existir y verificarse **antes** de dar por desplegado el sistema. Cada punto es
verificable con un comando: si no se puede comprobar, no está hecho.

Rama: `equipo5-deployment` · PR #8 · Ultima verificacion completa: 19/07, 19 servicios en compose
(15 con healthcheck) y 10 workloads en Kubernetes.

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
- [ ] Las 4 bases tienen su script en `docker/init/<base>/01-schema.sql`. Postgres los ejecuta
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
docker compose ps                                  # 19 servicios arriba
foreach ($p in 4000,3001,3002,3003,3000) { curl.exe -m 5 -f "http://localhost:$p/metrics" > $null; "$p -> $LASTEXITCODE" }
```

Los cinco deben imprimir `-> 0`. Puertos: ms-auth 4000, ms-usuarios 3001, ms-agenda 3002,
ms-notificaciones 3003, ms-tutorias 3000.

---

## 3. Docker Compose

- [ ] Los 19 servicios levantan con un solo `docker compose up -d`.
- [ ] **17 de los 19** servicios llegan a `healthy` (no solo `Up`). Los 2 restantes --
      `toxiproxy` y `otel-collector` -- no tienen shell en su imagen: **comprobado**, no supuesto.

**Correccion del 19/07 (la encontro la auditoria cruzada, no yo).** Este documento afirmaba que 4
servicios no podian tener healthcheck "porque usan imagenes distroless sin shell". Eso se asumio;
nunca se ejecuto un comando para verificarlo. Al comprobarlo, era falso en la mitad de los casos:

| Servicio | Comprobacion | Resultado |
|---|---|---|
| `toxiproxy` | `docker run --entrypoint sh` | `exec: "sh": not found` -> sin shell, justificado |
| `otel-collector` | idem | sin shell, justificado |
| `tempo` | `command -v wget` | **`/usr/bin/wget`** -> healthcheck sobre `/ready` |
| `promtail` | `command -v wget/curl/nc` -> ninguno; `bash` + `/dev/tcp` -> **disponibles** | healthcheck via socket TCP al puerto 9080 |

Es exactamente el error que este documento le seniala a los otros equipos: **dar por cierto lo que
no se ejecuto.** Cometido por mi, en el documento donde acuso a los demas de cometerlo, y detectado
por la revision cruzada al pedir la evidencia. Es la mejor demostracion de para que sirve esa
revision: atrapa lo que el autor no puede ver de si mismo.

**Metodo para el que quiera repetirlo** (antes de declarar que algo "no se puede"):

```bash
docker run --rm --entrypoint sh <imagen> -c "command -v wget curl nc"   # herramientas HTTP
docker run --rm --entrypoint bash <imagen> -c "exec 3<>/dev/tcp/1.1.1.1/80"   # socket nativo
```

Para los 2 que realmente no tienen shell, la deuda #3 propone habilitar el endpoint de salud propio
del servicio: el collector trae la extension `health_check` (puerto 13133), hoy no activada en
`otel-collector-config.yaml`. Eso es zona del Equipo 4.
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

- [ ] Los 5 StatefulSets (4 bases + RabbitMQ) llegan a `Ready` con su PVC en `Bound`.
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
`docker/init/`, healthchecks en 15 de 19 servicios, HPA + PDB, securityContext, USER no-root y
HEALTHCHECK en los Dockerfiles, y el workflow de CI.

| # | Pendiente | Atributo en riesgo | Duenio |
|---|---|---|---|
| 1 | **Paridad compose ↔ K8s**: compose tiene 19 servicios, K8s cubre 10. Faltan `prometheus`, `grafana`, `loki`, `promtail`, `tempo`, `otel-collector`, `toxiproxy`, `client-sim`, `tracking-dashboard`. Portar Prometheus no es copiar el manifiesto: `static_configs` no funciona en K8s, hace falta `kubernetes_sd_configs` + ServiceAccount con RBAC | Observabilidad | Equipo 5 + Equipo 4 |
| 2 | **`/health` propio en los microservicios**, separado de `/metrics`. Hoy las probes apuntan a `/metrics`, y desde que el Equipo 4 agrego Gauges con `collect()` que consultan la BD, un problema en Postgres hace que Kubernetes reinicie los pods de aplicacion: un fallo de la capa de datos se propaga a la de computo | Disponibilidad | Equipo 5 + Equipo 4 |
| 3 | **Healthcheck en `toxiproxy`, `tempo`, `otel-collector`, `promtail`**. Usan imagenes distroless sin shell ni `wget`, asi que un `CMD-SHELL` los marcaria unhealthy sin estarlo. Para el collector hace falta habilitar la extension `health_check` en `otel-collector-config.yaml` (puerto 13133); para Tempo, exponer `/ready` con un binario capaz de consultarlo | Disponibilidad | Equipo 4 |
| 4 | **ConfigMap** para la configuracion no secreta, hoy duplicada inline en cada Deployment | Reproducibilidad | Equipo 5 |
| 5 | **NetworkPolicy**: cualquier pod alcanza cualquier base | Seguridad | Equipo 5 + Equipo 3 |
| 6 | **StorageClass explicita** en los `volumeClaimTemplates` (hoy dependen de la default del cluster) | Portabilidad | Equipo 5 |
| 7 | **Topologia de RabbitMQ declarativa** (`definitions.json`). Hoy exchanges, colas y DLQ nacen de los `assertExchange`/`assertQueue` del codigo: la topologia depende de que servicio arranque primero y con que version | Confiabilidad | Equipo 2 |
| 8 | **Instrumentacion OTel en los microservicios**. Tempo y el collector corren sanos pero ningun servicio exporta trazas: falta el SDK y `OTEL_EXPORTER_OTLP_ENDPOINT`. Verificable: `grep -h opentelemetry ms-*/package.json` no devuelve nada | Observabilidad | Equipo 4 |
| 9 | **Provisioning de Grafana y Alertmanager**. Las reglas de `alert_rules.yml` se evaluan pero no hay destinatario configurado: una alerta que nadie recibe da sensacion de cobertura sin darla | Observabilidad | Equipo 4 |
| 10 | **Separar los workers del proceso HTTP en ms-tutorias**. Cada replica agrega otra copia de los tres pollers compitiendo por las mismas filas; por eso su HPA tiene `maxReplicas: 2` mientras el resto tiene 4 | Escalabilidad | Equipo 1 + Equipo 5 |

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


# Checklist de despliegue — Zona Deployment (Equipo 5)

Qué debe existir y verificarse **antes** de dar por desplegado el sistema. Cada punto es
verificable con un comando: si no se puede comprobar, no está hecho.

Rama: `equipo5-deployment` · PR #8 · Imagen de referencia: commit `0ab70dc`

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
docker compose ps                                  # 15 servicios arriba
foreach ($p in 4000,3001,3002,3003,3000) { curl.exe -m 5 -f "http://localhost:$p/metrics" > $null; "$p -> $LASTEXITCODE" }
```

Los cinco deben imprimir `-> 0`. Puertos: ms-auth 4000, ms-usuarios 3001, ms-agenda 3002,
ms-notificaciones 3003, ms-tutorias 3000.

---

## 3. Docker Compose

- [ ] Los 15 servicios levantan con un solo `docker compose up -d`.
- [ ] Las 4 bases y RabbitMQ llegan a `healthy` (no solo `Up`).
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

| # | Pendiente | Atributo en riesgo |
|---|---|---|
| 0 | **Fijar `tempo` y `otel-collector` por digest** (hoy en `:latest`). Comando: `docker image inspect grafana/tempo:latest --format "{{index .RepoDigests 0}}"`. No se fijo a ciegas: elegir una version sin verificar que la imagen levante seria un cambio sin validacion | Reproducibilidad |
| 1 | Paridad compose ↔ K8s: compose tiene **17** servicios, K8s cubre 10. Faltan `prometheus`, `grafana`, `toxiproxy`, `client-sim`, `tracking-dashboard`, y ahora tambien `tempo` y `otel-collector` | Observabilidad |
| 2 | CI que valide `docker compose config` y `kubectl apply --dry-run` en cada PR | Reproducibilidad |
| 3 | `/health` propio en ms-tutorias, separado de `/metrics` (hoy la probe depende del endpoint de Prometheus, y ese servicio corre 3 workers de fondo) | Disponibilidad |
| 4 | ConfigMap para la configuración no secreta (hoy duplicada en cada Deployment) | Reproducibilidad |
| 5 | NetworkPolicy: hoy cualquier pod alcanza cualquier base | Seguridad |
| 6 | StorageClass explícita en los PVC (hoy dependen de la default del clúster) | Portabilidad |
| 7 | Réplicas > 1 + PodDisruptionBudget | Disponibilidad |

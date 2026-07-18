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
- [ ] Existe `kubernetes-manifests/app-runtime-secrets.yaml` (copia de `.example`), con los
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

**El orden importa: son DOS Secrets, no uno.** Si se aplican los Deployments antes que los
Secrets, los 5 microservicios entran en `CrashLoopBackOff` con
`FATAL ERROR: JWT_SECRET no está definida` — la app hace fail-fast por diseño.

```bash
kubectl apply -f kubernetes-manifests/kong-security.yaml         # 1. app-jwt-secret (Equipo 3)
kubectl apply -f kubernetes-manifests/app-runtime-secrets.yaml   # 2. app-runtime-secrets (Equipo 5)
kubectl apply -f kubernetes-manifests/                           # 3. el resto
kubectl get pods -w
```

- [ ] Los 5 StatefulSets (4 bases + RabbitMQ) llegan a `Ready` con su PVC enlazado.
- [ ] Los 5 Deployments llegan a `1/1 Running`, no `CrashLoopBackOff`.
- [ ] Los `DB_HOST` de los Deployments coinciden con los nombres de los Services.
- [ ] Ningún pod queda sin `resources` ni sin probes.

```bash
kubectl get pvc                                    # todos Bound
kubectl get pods -o wide                           # ninguno en CrashLoopBackOff
kubectl rollout status deployment/ms-auth --timeout=90s
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

## Deuda abierta (backlog priorizado)

| # | Pendiente | Atributo en riesgo |
|---|---|---|
| 1 | Paridad compose ↔ K8s: faltan `prometheus`, `grafana`, `toxiproxy`, `client-sim`, `tracking-dashboard` en manifiestos | Observabilidad |
| 2 | CI que valide `docker compose config` y `kubectl apply --dry-run` en cada PR | Reproducibilidad |
| 3 | `/health` propio en ms-tutorias, separado de `/metrics` (hoy la probe depende del endpoint de Prometheus, y ese servicio corre 3 workers de fondo) | Disponibilidad |
| 4 | ConfigMap para la configuración no secreta (hoy duplicada en cada Deployment) | Reproducibilidad |
| 5 | NetworkPolicy: hoy cualquier pod alcanza cualquier base | Seguridad |
| 6 | StorageClass explícita en los PVC (hoy dependen de la default del clúster) | Portabilidad |
| 7 | Réplicas > 1 + PodDisruptionBudget | Disponibilidad |

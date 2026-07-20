#!/usr/bin/env bash
#
# scripts/integracion-flujo-completo.sh — Equipo 5 (Deployment), deuda #11.
#
# POR QUE EXISTE, y por que un chequeo de arranque no alcanza.
#
# El job `arranque-real` levanta el stack y verifica que los 5 microservicios respondan /metrics.
# Eso atrapa un CrashLoopBackOff (hallazgo #7) pero NO atrapa los hallazgos #10 y #11:
#
#   #10 — ms-notificaciones requeria una base que no existia en ningun lado. El proceso arranca
#         sano y responde /metrics; el fallo aparece recien en la PRIMERA notificacion que intenta
#         deduplicar por correlation_id.
#   #11 — ms-notificaciones no tenia JWT_SECRET en compose. Idem: arranca perfecto, y todo token
#         valido se rechaza con 401 en la primera peticion real al endpoint protegido.
#
# Los dos comparten la forma: **el servicio esta vivo, y roto**. Un chequeo de arranque pregunta
# "¿el proceso responde?"; este pregunta "¿el sistema hace lo que dice hacer?".
#
# DEPENDENCIAS: solo bash, curl, date, openssl y sed. Deliberadamente NO usa python3 ni jq:
# se ejecuta igual en ubuntu-latest (el CI) y en Git Bash sobre Windows (la maquina de quien lo
# escribio). Un chequeo que solo corre en un entorno tiene el mismo problema que este script viene
# a resolver -- se desincroniza de la realidad de quien lo necesita.
#
# La extraccion de JSON con `sed` es fragil ante cambios de formato, y es una concesion consciente:
# a cambio, cualquiera del equipo puede correrlo sin instalar nada.

set -euo pipefail

MS_AUTH=${MS_AUTH:-http://localhost:4000}
MS_USUARIOS=${MS_USUARIOS:-http://localhost:3001}
MS_TUTORIAS=${MS_TUTORIAS:-http://localhost:3000}
MS_NOTIFICACIONES=${MS_NOTIFICACIONES:-http://localhost:3003}

fallos=0
paso()  { echo "  OK   — $1"; }
falla() { echo "::error::$1"; fallos=1; }

# Extrae el valor de la PRIMERA aparicion de una clave string en un JSON plano.
#
# Se usa `grep -o` y no `sed -n s///p`: sed es codicioso con `.*` y, como el array de tutores viene
# entero en una sola linea, devolvia el ULTIMO tutor en vez del primero. Funcionaba por accidente
# --el id y la especialidad salian los dos del ultimo elemento, asi que la pareja era coherente--
# pero con un tutor sin especialidad habria mezclado el id de uno con la materia de otro.
#
# `grep -o` imprime cada coincidencia en su propia linea, asi `head -1` es determinista.
json_valor() {
  grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}

echo "== 1. Autenticacion =="
TOKEN=$(curl -fsS -m 10 -X POST "$MS_AUTH/auth/token" \
  -H 'Content-Type: application/json' \
  -d '{"username":"ana.torres","password":"password_ana"}' | json_valor access_token)

if [ -z "${TOKEN:-}" ]; then
  falla "ms-auth no devolvio access_token"
  exit 1
fi
paso "token obtenido"

echo "== 2. Catalogo de tutores (GET /usuarios/tutores) =="
# De aca sale la materia para el paso 3: el test NO hardcodea "Calculo Multivariable", la lee del
# sistema. Si alguien cambia el seed, esto sigue funcionando -- es exactamente el error que tenia
# el formulario del simulador con su fecha fija, que caduco sola.
TUTORES=$(curl -sS -m 10 "$MS_USUARIOS/usuarios/tutores" -H "Authorization: Bearer $TOKEN")
ID_TUTOR=$(echo "$TUTORES" | json_valor id)
MATERIA=$(echo "$TUTORES" | json_valor especialidad)

if [ -z "${ID_TUTOR:-}" ]; then
  falla "el catalogo de tutores vino vacio o no parseo. Respuesta: $TUTORES"
  exit 1
fi
paso "tutor $ID_TUTOR dicta '$MATERIA'"

echo "== 3. Solicitar tutoria (camino feliz) =="
# HORARIO ALEATORIO A PROPOSITO, y esto es una correccion sobre la primera version de este script.
#
# La v1 pedia siempre `hoy + 7 dias` a la hora actual. Contra un entorno limpio (el CI) andaba;
# contra un entorno con datos --como la maquina de cualquiera del equipo despues de una demo--
# devolvia 409 porque ms-agenda rechaza la reserva superpuesta. Correctamente: el bloque dura 60
# minutos, asi que cualquier pedido dentro de esa hora choca.
#
# El problema de fondo: **un test que escribe datos reales no es repetible si el horario es fijo.**
# Y habria pasado desapercibido, porque en CI el stack nace vacio en cada corrida: verde siempre,
# inservible en local. Es la misma forma de los hallazgos #10 y #11 -- algo que se ve sano en un
# entorno y esta roto en el otro.
#
# Se elige un dia al azar dentro del proximo año, en hora en punto. La colision deja de ser
# sistematica y pasa a ser improbable; si algun dia ocurre, el 409 lo reporta con su motivo.
DIAS=$(( (RANDOM % 300) + 30 ))
HORA=$(( (RANDOM % 12) + 8 ))
FECHA=$(date -u -d "+$DIAS days" +%Y-%m-%d)T$(printf '%02d' "$HORA"):00:00Z
CID=$(openssl rand -hex 16)

# Se captura el codigo HTTP junto al cuerpo en vez de usar `curl -f`: con `-f` mas `set -e`, un
# 409 mataba el script sin decir por que. Un test tiene que explicar su fallo, no solo fallar.
SALIDA=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "$MS_TUTORIAS/v1/tutorias" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $CID" \
  -H 'Content-Type: application/json' \
  -d "{\"idTutor\":\"$ID_TUTOR\",\"fechaSolicitada\":\"$FECHA\",\"duracionMinutos\":60,\"materia\":\"$MATERIA\"}")

CODIGO_SOLICITUD=$(echo "$SALIDA" | tail -1)
RESPUESTA=$(echo "$SALIDA" | sed '$d')
ESTADO=$(echo "$RESPUESTA" | json_valor estado)

if [ "$ESTADO" = "CONFIRMADA" ]; then
  paso "tutoria CONFIRMADA para $FECHA"
elif [ "$CODIGO_SOLICITUD" = "409" ]; then
  falla "409 al reservar $FECHA: el horario ya estaba ocupado. Con horario aleatorio esto deberia ser rarisimo -- si se repite, revisar si el entorno tiene muchas reservas viejas."
else
  falla "la Saga no confirmo la tutoria (HTTP $CODIGO_SOLICITUD). Estado: '$ESTADO'. Respuesta: $RESPUESTA"
fi

echo "== 4. La notificacion llego a la base de notificaciones =="
# ESTE ES EL CHEQUEO QUE HABRIA ATRAPADO EL HALLAZGO #10.
#
# La confirmacion encola la notificacion en el outbox; el poller la publica a RabbitMQ;
# ms-notificaciones la consume y escribe en logs_notificacion para deduplicar. Si esa base no
# existe -- como pasaba el 19/07 -- todo lo anterior sigue dando verde y esta fila nunca aparece.
#
# Se espera con reintentos, no con un sleep fijo: el outbox es asincrono por diseño y el tiempo
# depende de OUTBOX_POLL_INTERVAL_MS. Un sleep corto daria falsos negativos; uno largo haria el
# job lento para todos, siempre.
FILAS=0
for _ in $(seq 1 20); do
  FILAS=$(docker exec db_notificaciones_postgres psql -U user_notificaciones -d db_notificaciones \
    -tAc "SELECT COUNT(*) FROM logs_notificacion;" 2>/dev/null | tr -d ' \r' || echo 0)
  [ "${FILAS:-0}" -gt 0 ] 2>/dev/null && break
  sleep 3
done

if [ "${FILAS:-0}" -gt 0 ] 2>/dev/null; then
  paso "logs_notificacion tiene $FILAS fila(s): el flujo asincrono completo funciono"
else
  falla "no llego ninguna notificacion a logs_notificacion tras 60s. La cadena outbox -> RabbitMQ -> ms-notificaciones -> Postgres esta cortada en algun punto."
fi

echo "== 5. El endpoint protegido de notificaciones acepta un token valido =="
# ESTE ES EL CHEQUEO QUE HABRIA ATRAPADO EL HALLAZGO #11.
#
# Con JWT_SECRET ausente, config.jwtSecret queda undefined, jwt.verify lanza, el catch responde
# 401 y TODO token valido se rechaza. No se afirma sobre el exito del envio (depende del proveedor
# de correo), solo que la autenticacion no rebote: un 401 aca significa secreto mal configurado,
# no credenciales malas -- el token es el mismo que funciono en los pasos 2 y 3.
CODIGO=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$MS_NOTIFICACIONES/notificaciones/email" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"destinatario":"test@integracion.local","asunto":"prueba","cuerpo":"prueba"}')

if [ "$CODIGO" = "401" ]; then
  falla "ms-notificaciones rechazo con 401 un token que ms-usuarios y ms-tutorias aceptaron: JWT_SECRET mal configurado (hallazgo #11)"
else
  paso "el token fue aceptado (HTTP $CODIGO)"
fi

echo "== 6. Rechazo de materia incoherente =="
# La otra cara: que la validacion del paso 1b siga viva. Un test que solo prueba el camino feliz
# no nota si alguien la borra.
CID2=$(openssl rand -hex 16)
CODIGO2=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$MS_TUTORIAS/v1/tutorias" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $CID2" \
  -H 'Content-Type: application/json' \
  -d "{\"idTutor\":\"$ID_TUTOR\",\"fechaSolicitada\":\"$FECHA\",\"duracionMinutos\":60,\"materia\":\"Materia Que No Dicta Nadie\"}")

if [ "$CODIGO2" = "400" ]; then
  paso "materia incoherente rechazada con 400"
else
  falla "se acepto una materia que el tutor no dicta (HTTP $CODIGO2). La validacion del paso 1b no esta activa."
fi

echo
if [ "$fallos" -eq 0 ]; then
  echo "TODOS LOS PASOS OK — el sistema no solo arranca, hace lo que dice hacer."
else
  echo "HAY FALLOS: el stack levanta pero el flujo de negocio esta roto en algun punto."
fi
exit "$fallos"

# Dockerfile

# --- Etapa 1: Builder ---
# Usamos una imagen de Node.js con el tag 'builder'. Esta etapa instalarÃ¡
# las dependencias y copiarÃ¡ el cÃ³digo.
FROM node:20-alpine AS builder

# Establecemos el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copiamos package.json y package-lock.json. Hacemos esto en un paso separado
# para aprovechar el cachÃ© de Docker. Las dependencias no cambian tan a menudo
# como el cÃ³digo, asÃ­ que Docker no necesitarÃ¡ reinstalarlas en cada build.
COPY package*.json ./

# Instalamos las dependencias de producciÃ³n
RUN npm install --omit=dev

# Copiamos el resto del cÃ³digo de la aplicaciÃ³n
COPY . .

# --- Etapa 2: ProducciÃ³n ---
# Empezamos desde una imagen fresca y ligera de Node.js para mantener
# nuestra imagen final pequeÃ±a y segura.
FROM node:20-alpine

WORKDIR /usr/src/app

# Copiamos las dependencias ya instaladas y el cÃ³digo desde la etapa 'builder'.
# Esta es la magia de los 'multi-stage builds'.
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app ./

# Exponemos el puerto 3000 (esto es mÃ¡s para documentaciÃ³n; el puerto real
# se mapea en Docker Compose). Usamos 3000 como un default genÃ©rico.
EXPOSE 3000

# El comando que se ejecutarÃ¡ cuando el contenedor inicie.

# --- Equipo 5 (D4 de la auditoria): endurecimiento del runtime ---
# 1) HEALTHCHECK: hasta ahora la salud solo estaba declarada en docker-compose.yml y en los
#    manifiestos de K8s. Al vivir en la imagen, cualquiera que la corra con 'docker run' -- sin
#    compose y sin cluster -- obtiene el mismo criterio de "esta sano". La definicion de salud
#    viaja con el artefacto, no con el orquestador.
# 2) USER node: 'node' (uid 1000) ya existe en las imagenes oficiales. Sin esta linea el proceso
#    corre como root dentro del contenedor: si alguien logra ejecucion remota, la logra como root.
#    La app solo necesita leer su codigo y abrir un puerto > 1024, asi que no pierde nada.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:${PORT:-3000}/health || exit 1

USER node

CMD ["node", "-r", "./src/config/tracing.js", "src/app.js"]

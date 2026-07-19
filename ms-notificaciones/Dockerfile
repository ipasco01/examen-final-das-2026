# Dockerfile

# --- Etapa 1: Builder ---
# Usamos una imagen de Node.js con el tag 'builder'. Esta etapa instalará
# las dependencias y copiará el código.
FROM node:18-alpine AS builder

# Establecemos el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copiamos package.json y package-lock.json. Hacemos esto en un paso separado
# para aprovechar el caché de Docker. Las dependencias no cambian tan a menudo
# como el código, así que Docker no necesitará reinstalarlas en cada build.
COPY package*.json ./

# Instalamos las dependencias de producción
RUN npm install --omit=dev

# Copiamos el resto del código de la aplicación
COPY . .

# --- Etapa 2: Producción ---
# Empezamos desde una imagen fresca y ligera de Node.js para mantener
# nuestra imagen final pequeña y segura.
FROM node:18-alpine

WORKDIR /usr/src/app

# Copiamos las dependencias ya instaladas y el código desde la etapa 'builder'.
# Esta es la magia de los 'multi-stage builds'.
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app ./

# Exponemos el puerto 3000 (esto es más para documentación; el puerto real
# se mapea en Docker Compose). Usamos 3000 como un default genérico.
EXPOSE 3000

# El comando que se ejecutará cuando el contenedor inicie.

# --- Equipo 5 (D4 de la auditoria): endurecimiento del runtime ---
# 1) HEALTHCHECK: hasta ahora la salud solo estaba declarada en docker-compose.yml y en los
#    manifiestos de K8s. Al vivir en la imagen, cualquiera que la corra con 'docker run' -- sin
#    compose y sin cluster -- obtiene el mismo criterio de "esta sano". La definicion de salud
#    viaja con el artefacto, no con el orquestador.
# 2) USER node: 'node' (uid 1000) ya existe en las imagenes oficiales. Sin esta linea el proceso
#    corre como root dentro del contenedor: si alguien logra ejecucion remota, la logra como root.
#    La app solo necesita leer su codigo y abrir un puerto > 1024, asi que no pierde nada.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:${PORT:-3003}/metrics || exit 1

USER node

CMD ["node", "src/app.js"]
# client-mobile-sim/Dockerfile

# --- Etapa 1: Builder ---
FROM node:18-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

# --- Etapa 2: Producción ---
FROM node:18-alpine
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app ./

ENV PORT=8080
EXPOSE 8080


# --- Equipo 5 (D4 de la auditoria): endurecimiento del runtime ---
# Mismo criterio que los 5 microservicios. Estos dos quedaron fuera en la primera pasada: eran
# node:18-alpine igual que el resto, asi que no habia razon tecnica para excluirlos.
# HEALTHCHECK: la definicion de salud viaja con la imagen, no solo con el orquestador.
# USER node: uid 1000, ya existe en la imagen oficial. Sin esta linea el proceso corre como root.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:${PORT:-8080}/ || exit 1

USER node

CMD ["node", "index.js"]
# tracking-dashboard/Dockerfile
FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=9000
EXPOSE 9000

# --- Equipo 5 (D4 de la auditoria): endurecimiento del runtime ---
# Mismo criterio que los 5 microservicios. Estos dos quedaron fuera en la primera pasada: eran
# node:18-alpine igual que el resto, asi que no habia razon tecnica para excluirlos.
# HEALTHCHECK: la definicion de salud viaja con la imagen, no solo con el orquestador.
# USER node: uid 1000, ya existe en la imagen oficial. Sin esta linea el proceso corre como root.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:${PORT:-9000}/ || exit 1

USER node

CMD ["node", "src/server.js"]
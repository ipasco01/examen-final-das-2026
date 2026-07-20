// ms-usuarios/src/app.js
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config'); // <-- USAR EL NUEVO CONFIG
const usuariosRouter = require('./api/routes/usuarios.routes');
const errorHandler = require('./api/middlewares/errorHandler');
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');

const requestLogger = require('./api/middlewares/requestLogger.js');
const messageProducer = require('./infrastructure/messaging/message.producer'); // <-- IMPORTAR PRODUCTOR
const promBundle = require("express-prom-bundle");

const app = express();

// --- Equipo 5 (20/07), deuda #2: endpoint /health propio ---
//
// VA ANTES DE TODO LO DEMAS, Y ESO ES EL PUNTO. Se registra por encima del rateLimit y del
// middleware de metricas, asi que no lo afecta ninguno de los dos.
//
// POR QUE EXISTE. Hasta hoy las probes de Kubernetes apuntaban a /metrics, y eso fallo por dos
// causas independientes, las dos comprobadas ejecutando:
//
//   1. RATE LIMIT (hallazgo #19). El limitador permite 100 peticiones cada 15 min por IP. Las
//      probes de un solo pod hacen 150: readiness cada 10s (90) + liveness cada 15s (60). A los
//      ~10 minutos el kubelet empieza a recibir 429, la probe lo cuenta como fallo y Kubernetes
//      reinicia el pod. Evidencia:
//        Liveness probe failed: HTTP probe failed with statuscode: 429
//      Los 5 microservicios reiniciaban cada ~10 minutos por esto.
//
//   2. ACOPLAMIENTO CON LA BASE (hallazgo #17). El Equipo 4 agrego Gauges con collect() que
//      consultan Postgres al pedir /metrics. Cuando falto una tabla, /metrics devolvio 500, la
//      liveness fallo y Kubernetes mato pods de aplicacion sanos. Un problema de la capa de datos
//      derribando la de computo.
//
// QUE VERIFICA Y QUE NO -- deliberadamente NO consulta la base ni el broker.
// Una liveness probe responde "¿hay que reiniciar este proceso?". Reiniciar el pod no arregla una
// base caida: solo agrega un pod menos a un sistema ya degradado. Si manana se quiere una probe
// que SI mire dependencias, va en un endpoint aparte (/ready) y solo para readiness, nunca para
// liveness.
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.use(helmet());
app.use(cors());
// Equipo 5 (20/07): `skip` para /metrics y /health. El limitador protege de abuso de USUARIOS;
// las probes del kubelet y el scrapeo de Prometheus no son usuarios. Sin esta exclusion, las
// probes ya provocaron el hallazgo #19 (429 -> pod reiniciado cada ~10 min) y Prometheus queda a
// un cambio de distancia del mismo problema: con scrape_interval de 15s hace 60 peticiones por
// ventana y sobra margen, pero bajarlo a 5s --razonable para que los paneles se muevan en una
// demo-- serian 180 contra un limite de 100, y los graficos empezarian a tener huecos sin que
// nadie sepa por que. Se excluye el sintoma antes de que aparezca, no despues.
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/metrics' || req.path === '/health'
}));

const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    includeStatusCode: true,
    includeUp: true,
    customLabels: { project_name: 'tutorias_app', service_name: process.env.SERVICE_NAME || 'unknown_service' },
    promClient: {
        collectDefaultMetrics: {
        }
    }
});
app.use(metricsMiddleware);

app.use(express.json());
app.use(correlationIdMiddleware);
app.use(requestLogger);
app.use('/usuarios', usuariosRouter);

app.use(errorHandler);

if (require.main === module) {
    app.listen(config.port, () => { // <-- Usar config.port
        console.log(`MS_Usuarios escuchando en el puerto ${config.port}`);
        messageProducer.connect(); // <-- INICIAR CONEXIÓN A RABBITMQ
    });
}

module.exports = app;

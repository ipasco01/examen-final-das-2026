// ms-tutorias/src/app.js

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config'); // Importamos nuestra configuración centralizada
const tutoriasRouter = require('./api/routes/tutorias.routes');
const errorHandler = require('./api/middlewares/errorHandler'); // El manejador de errores reutilizable
const correlationIdMiddleware = require('./api/middlewares/correlationId.middleware.js');
const requestLogger = require('./api/middlewares/requestLogger.js');
const promBundle = require("express-prom-bundle");
const messageProducer = require('./infrastructure/messaging/message.producer');
const outboxPublisher = require('./infrastructure/messaging/outbox.publisher');
const compensacionWorker = require('./infrastructure/workers/compensacion.worker');
const reconciliacionWorker = require('./infrastructure/workers/reconciliacion.worker');
require('./infrastructure/observability/backlog.metrics'); // S7: gauges de backlog, se auto-registran en prom-client al cargar

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
    },
    buckets: [0.1, 0.5, 1, 1.5, 5, 10]
});
app.use(metricsMiddleware);

// Middlewares esenciales
app.use(express.json()); // Permite al servidor entender y procesar bodies en formato JSON
app.use(correlationIdMiddleware); // Añadimos el middleware de correlationIdMiddleware
app.use(requestLogger);

// Enrutamiento principal
// Cualquier petición a "/v1/tutorias" será gestionada por nuestro router.
app.use('/v1/tutorias', tutoriasRouter);

// Middleware de manejo de errores
// Debe ser el ÚLTIMO middleware que se añade.
app.use(errorHandler);

// Iniciar el servidor
if (require.main === module) {
    const server = app.listen(config.port, () => {
        console.log(`MS_Tutorias (Orquestador) escuchando en el puerto ${config.port}`);
        messageProducer.connect(); // Iniciar la conexión al RabbitMQ
        outboxPublisher.start(); // Poller del patrón outbox (D2)
        compensacionWorker.start(); // Worker de reintentos de compensación de agenda (D6)
        reconciliacionWorker.start(); // Worker de reconciliación de tutorías PENDIENTE huérfanas (S2)
    });

    // S3: antes de esto, un SIGTERM (docker compose down, redeploy) mataba el proceso a mitad de
    // un tick de cualquiera de los tres workers -- stop() existía en los tres pero nada en
    // producción lo llamaba. Se detienen los pollers primero (dejan de reclamar trabajo nuevo) y
    // luego se cierra el servidor HTTP (deja de aceptar conexiones nuevas y drena las que ya
    // estaban en curso). No espera a que un tick de worker ya en marcha termine -- solo evita que
    // arranque uno nuevo; el guard `isRunning` de cada worker protege esa carrera.
    const shutdown = (signal) => {
        console.log(`[MS_Tutorias] ${signal} recibido, iniciando apagado ordenado...`);
        outboxPublisher.stop();
        compensacionWorker.stop();
        reconciliacionWorker.stop();
        server.close(() => {
            console.log('[MS_Tutorias] Servidor HTTP cerrado.');
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
// ms-tutorias/src/infrastructure/clients/agenda.client.js
const axios = require('axios');
const CircuitBreaker = require('opossum');
const { agendaServiceUrl } = require('../../config');
const { publishTrackingEvent } = require('../messaging/message.producer');
const { conReintentos } = require('./retry.util');
const { circuitBreakerState } = require('../observability/circuitBreaker.metrics');

// Reintentos con backoff exponencial + jitter ante caídas puntuales de ms-agenda (contenedor
// reiniciando, blip de red) -- ver retry.util.js. Aplican a verificarDisponibilidad y
// bloquearAgenda; nunca a una respuesta HTTP real (ej. 409) ni cuando el circuito ya está abierto.
const RETRY_MAX_INTENTOS = Number(process.env.RETRY_AGENDA_MAX_INTENTOS || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_AGENDA_BASE_DELAY_MS || 150);

const breakerOptions = {
    timeout: 1500, // Si la petición tarda > 1.5s, se cancela (Timeout)
    volumeThreshold: 2, // Con 2 fallos consecutivos ya hay volumen suficiente para abrir
    errorThresholdPercentage: 50, // Si el 50% fallan, se abre el circuito
    resetTimeout: 10000, // Espera 10s antes de intentar cerrar el circuito (Half-Open)
    // Un 409 (horario ya reservado) es un resultado de negocio normal, no una falla de
    // infraestructura -- análogo al 404 de usuarios.client.js. errorFilter lo excluye de las
    // estadísticas del breaker, pero (a diferencia del 404) la promesa sigue rechazando con el
    // error original, porque tutoria.service.js depende de capturar esa excepción.
    errorFilter: (error) => Boolean(error.response) && error.response.status === 409
};

// Función que realiza la petición real (GET/POST hacia ms-agenda)
const _makeRequest = async (method, url, correlationId, data, authHeader) => {
    const response = await axios({
        method,
        url,
        data,
        headers: { 'X-Correlation-ID': correlationId, Authorization: authHeader },
        timeout: 1500 // Timeout a nivel de red también
    });
    return response.data;
};

// Breaker compartido solo para el camino de avance de la Saga (verificar + bloquear).
// cancelarBloqueo queda deliberadamente fuera de este breaker: ya tiene su propio retry con
// backoff en tutoria.service.js (compensación de la Saga); compartir breaker aquí degradaría
// ese retry a fallos sintéticos 503 casi instantáneos si el circuito quedara abierto.
const breaker = new CircuitBreaker(_makeRequest, breakerOptions);

// Arranca en 0 (cerrado) desde el primer instante -- si no se hace este set inicial,
// la métrica ni siquiera existe en /metrics hasta el primer cambio de estado real.
circuitBreakerState.set({ target_service: 'ms-agenda' }, 0);

breaker.on('open', () => {
    console.log('[CircuitBreaker] ABIERTO: ms-agenda no responde.');
    circuitBreakerState.set({ target_service: 'ms-agenda' }, 1);
});
breaker.on('halfOpen', () => {
    console.log('[CircuitBreaker] HALF-OPEN: Probando recuperación (ms-agenda)...');
    circuitBreakerState.set({ target_service: 'ms-agenda' }, 0.5);
});
breaker.on('close', () => {
    console.log('[CircuitBreaker] CERRADO: ms-agenda recuperado.');
    circuitBreakerState.set({ target_service: 'ms-agenda' }, 0);
});

const reportOpenCircuit = async (correlationId) => {
    await publishTrackingEvent({
        service: 'MS_Tutorias',
        message: 'Circuit Breaker ABIERTO para ms-agenda',
        cid: correlationId,
        timestamp: new Date(),
        status: 'ERROR'
    });
};

const isOpenCircuitError = (error) => breaker.opened || error.code === 'EOPENBREAKER';

const fireRequest = async (method, url, correlationId, data, authHeader) => {
    try {
        return await breaker.fire(method, url, correlationId, data, authHeader);
    } catch (error) {
        // Si el breaker está abierto, fallamos rápido con un error 503
        if (isOpenCircuitError(error)) {
            console.error(`[CircuitBreaker] Fallo rápido para ${url}`);
            await reportOpenCircuit(correlationId);
            throw Object.assign(
                new Error('Servicio de agenda no disponible temporalmente por timeout/red o Circuit Breaker abierto.'),
                { statusCode: 503 }
            );
        }

        // Cualquier otro error (incluido el 409 de negocio, ver errorFilter arriba)
        throw error;
    }
};

const verificarDisponibilidad = async (idTutor, fechaHora, correlationId, authHeader) => {
    const url = `${agendaServiceUrl}/tutores/${idTutor}/disponibilidad?fechaHora=${fechaHora}`;

    // Lectura idempotente: vale la pena reintentar (backoff + jitter) un fallo de red/timeout
    // puntual. Nunca se reintenta ante una respuesta HTTP real (incluido el circuito abierto) para
    // no enmascarar errores de negocio -- ver conReintentos/esFalloDeInfraestructura.
    const data = await conReintentos(
        () => fireRequest('get', url, correlationId, undefined, authHeader),
        {
            maxIntentos: RETRY_MAX_INTENTOS,
            baseDelayMs: RETRY_BASE_DELAY_MS,
            isOpenCircuitError,
            onIntentoFallido: (intento, error) => console.error(
                `[Retry] ms-agenda (verificarDisponibilidad ${idTutor}) - CID: ${correlationId} - intento ${intento}/${RETRY_MAX_INTENTOS} falló: ${error.message}`
            )
        }
    );
    return data.disponible;
};

const bloquearAgenda = async (idTutor, payload, correlationId, authHeader) => {
    const url = `${agendaServiceUrl}/tutores/${idTutor}/bloquear`;

    // Igual criterio que verificarDisponibilidad: solo se reintenta un fallo de red/timeout
    // puntual, nunca una respuesta HTTP real. La constraint única de ms-agenda (tutor+horario,
    // ver agenda.controller.js) es la red de seguridad si un reintento llega a duplicar una
    // petición que en realidad ya se había procesado del lado del servidor -- en ese caso el
    // reintento recibe un 409 (no un doble bloqueo) y la Saga lo trata como error de negocio.
    return conReintentos(
        () => fireRequest('post', url, correlationId, payload, authHeader),
        {
            maxIntentos: RETRY_MAX_INTENTOS,
            baseDelayMs: RETRY_BASE_DELAY_MS,
            isOpenCircuitError,
            onIntentoFallido: (intento, error) => console.error(
                `[Retry] ms-agenda (bloquearAgenda ${idTutor}) - CID: ${correlationId} - intento ${intento}/${RETRY_MAX_INTENTOS} falló: ${error.message}`
            )
        }
    );
};

const cancelarBloqueo = async (idBloqueo, correlationId, authHeader) => {
    const url = `${agendaServiceUrl}/bloqueos/${idBloqueo}`;
    console.log(`[AgendaClient] Compensando: Eliminando bloqueo ${idBloqueo}`);

    // Deliberadamente sin Circuit Breaker: el loop de compensación en tutoria.service.js ya
    // implementa su propio retry con backoff (COMPENSACION_AGENDA_MAX_INTENTOS); envolver esta
    // llamada en el breaker compartido nestearía retries y podría convertir esos reintentos en
    // fallos sintéticos 503 casi instantáneos si el circuito quedara abierto por el otro camino.
    await axios.delete(url, {
        headers: { 'X-Correlation-ID': correlationId, Authorization: authHeader },
        timeout: 1500
    });
};

module.exports = { verificarDisponibilidad, bloquearAgenda, cancelarBloqueo };
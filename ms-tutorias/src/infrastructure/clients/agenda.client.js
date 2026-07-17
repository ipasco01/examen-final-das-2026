// ms-tutorias/src/infrastructure/clients/agenda.client.js
const axios = require('axios');
const CircuitBreaker = require('opossum');
const { agendaServiceUrl } = require('../../config');
const { publishTrackingEvent } = require('../messaging/message.producer');

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
const _makeRequest = async (method, url, correlationId, data) => {
    const response = await axios({
        method,
        url,
        data,
        headers: { 'X-Correlation-ID': correlationId },
        timeout: 1500 // Timeout a nivel de red también
    });
    return response.data;
};

// Breaker compartido solo para el camino de avance de la Saga (verificar + bloquear).
// cancelarBloqueo queda deliberadamente fuera de este breaker: ya tiene su propio retry con
// backoff en tutoria.service.js (compensación de la Saga); compartir breaker aquí degradaría
// ese retry a fallos sintéticos 503 casi instantáneos si el circuito quedara abierto.
const breaker = new CircuitBreaker(_makeRequest, breakerOptions);

breaker.on('open', () => console.log('[CircuitBreaker] ABIERTO: ms-agenda no responde.'));
breaker.on('halfOpen', () => console.log('[CircuitBreaker] HALF-OPEN: Probando recuperación (ms-agenda)...'));
breaker.on('close', () => console.log('[CircuitBreaker] CERRADO: ms-agenda recuperado.'));

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

const fireRequest = async (method, url, correlationId, data) => {
    try {
        return await breaker.fire(method, url, correlationId, data);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const verificarDisponibilidad = async (idTutor, fechaHora, correlationId) => {
    const url = `${agendaServiceUrl}/tutores/${idTutor}/disponibilidad?fechaHora=${fechaHora}`;

    try {
        const data = await fireRequest('get', url, correlationId);
        return data.disponible;
    } catch (error) {
        // Retry único y acotado: es la primera llamada de la Saga y una lectura idempotente, así
        // que vale la pena reintentar un fallo de red/timeout puntual. Nunca se reintenta ante una
        // respuesta HTTP real (incluido el circuito abierto) para no enmascarar errores de negocio.
        const esFalloDeRedOTimeout = !error.response && !isOpenCircuitError(error);
        if (!esFalloDeRedOTimeout) throw error;

        await sleep(150);
        const data = await fireRequest('get', url, correlationId);
        return data.disponible;
    }
};

const bloquearAgenda = async (idTutor, payload, correlationId) => {
    const url = `${agendaServiceUrl}/tutores/${idTutor}/bloquear`;
    return fireRequest('post', url, correlationId, payload);
};

const cancelarBloqueo = async (idBloqueo, correlationId) => {
    const url = `${agendaServiceUrl}/bloqueos/${idBloqueo}`;
    console.log(`[AgendaClient] Compensando: Eliminando bloqueo ${idBloqueo}`);

    // Deliberadamente sin Circuit Breaker: el loop de compensación en tutoria.service.js ya
    // implementa su propio retry con backoff (COMPENSACION_AGENDA_MAX_INTENTOS); envolver esta
    // llamada en el breaker compartido nestearía retries y podría convertir esos reintentos en
    // fallos sintéticos 503 casi instantáneos si el circuito quedara abierto por el otro camino.
    await axios.delete(url, {
        headers: { 'X-Correlation-ID': correlationId },
        timeout: 1500
    });
};

module.exports = { verificarDisponibilidad, bloquearAgenda, cancelarBloqueo };

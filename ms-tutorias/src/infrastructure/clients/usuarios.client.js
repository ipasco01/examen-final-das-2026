// ms-tutorias/src/infrastructure/clients/usuarios.client.js
const axios = require('axios');
const CircuitBreaker = require('opossum'); // 1. Importar Opossum
const { usuariosServiceUrl } = require('../../config');
const { publishTrackingEvent } = require('../messaging/message.producer'); // Para reportar al dashboard

// 2. Configuración del Breaker
const breakerOptions = {
    timeout: 1500, // Si la petición tarda > 1.5s, se cancela (Timeout)
    volumeThreshold: 2, // Con 2 fallos consecutivos ya hay volumen suficiente para abrir
    errorThresholdPercentage: 50, // Si el 50% fallan, se abre el circuito
    resetTimeout: 10000 // Espera 10s antes de intentar cerrar el circuito (Half-Open)
};

// Función que realiza la petición real
const _makeRequest = async (url, correlationId, authHeader) => {
    try {
        const response = await axios.get(url, {
            headers: { 'X-Correlation-ID': correlationId, Authorization: authHeader },
            timeout: 1500 // Timeout a nivel de red también
        });
        return response.data;
    } catch (error) {
        // Un usuario inexistente no debe contar como fallo de infraestructura para el breaker.
        if (error.response && error.response.status === 404) return null;
        throw error;
    }
};

// 3. Crear el Circuit Breaker
const breaker = new CircuitBreaker(_makeRequest, breakerOptions);

// Reportar cambios de estado al Dashboard (Opcional pero genial para visibilidad)
breaker.on('open', () => console.log('[CircuitBreaker] ABIERTO: ms-usuarios no responde.'));
breaker.on('halfOpen', () => console.log('[CircuitBreaker] HALF-OPEN: Probando recuperación...'));
breaker.on('close', () => console.log('[CircuitBreaker] CERRADO: ms-usuarios recuperado.'));

const reportOpenCircuit = async (correlationId) => {
    await publishTrackingEvent({
        service: 'MS_Tutorias',
        message: 'Circuit Breaker ABIERTO para ms-usuarios',
        cid: correlationId,
        timestamp: new Date(),
        status: 'ERROR'
    });
};

const isOpenCircuitError = (error) => breaker.opened || error.code === 'EOPENBREAKER';

const getUsuario = async (tipo, id, correlationId, authHeader) => {
    const url = `${usuariosServiceUrl}/${tipo}/${id}`;

    try {
        // 4. Ejecutar a través del Breaker
        const data = await breaker.fire(url, correlationId, authHeader);
        return data;
    } catch (error) {
        // Si el breaker está abierto, fallamos rápido con un error 503
        if (isOpenCircuitError(error)) {
            console.error(`[CircuitBreaker] Fallo rápido para ${url}`);
            // Reportar evento crítico al dashboard
            await reportOpenCircuit(correlationId);
            throw Object.assign(
                new Error('Servicio de usuarios no disponible temporalmente por timeout/red o Circuit Breaker abierto. Revisa la columna MS_Usuarios del dashboard para confirmar si la causa raíz es BD no inicializada, error interno o latencia.'),
                { statusCode: 503 }
            );
        }

        // Cualquier otro error
        throw error;
    }
};

module.exports = { getUsuario };

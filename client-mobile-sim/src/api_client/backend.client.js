// client-mobile-sim/src/api_client/backend.client.js
const axios = require('axios');
const { apiBaseUrl, authServiceUrl, usuariosServiceUrl } = require('../config'); // <-- Importar la nueva URL

// --- NUEVA FUNCIÓN DE LOGIN ---
const login = async (username, password) => {
    const url = `${authServiceUrl}/token`;
    console.log(`[CLIENT] ---> Autenticando usuario "${username}" en ${url}`);
    try {
        const response = await axios.post(url, { username, password });
        return response.data.access_token;
    } catch (error) {
        console.error(`[CLIENT] <--- Fallo en la autenticación: ${error.response?.data?.error?.message || error.message}`);
        throw new Error('No se pudo obtener el token de acceso.');
    }
};

// --- FUNCIÓN MODIFICADA ---
// Ahora acepta el token y el correlationId para los headers
const solicitarTutoria = async (payload, token, correlationId) => {
    const url = `${apiBaseUrl}/v1/tutorias`;
    console.log(`[CLIENT] ---> POST ${url} | Correlation-ID: ${correlationId}`);
    
    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${token}`, // <-- Header de seguridad
            'X-Correlation-ID': correlationId,
            'Idempotency-Key': correlationId // El endpoint exige esta clave; reutilizamos el CID único por solicitud.
        }
    });
    return response.data;
};

// Listado de "mis tutorías" del estudiante autenticado (GET /v1/tutorias).
const listarTutorias = async (token, correlationId) => {
    const url = `${apiBaseUrl}/v1/tutorias`;
    console.log(`[CLIENT] ---> GET ${url} | Correlation-ID: ${correlationId}`);

    const response = await axios.get(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Correlation-ID': correlationId
        }
    });
    return response.data;
};

// Cancela una tutoría CONFIRMADA (DELETE /v1/tutorias/:id).
const cancelarTutoria = async (idTutoria, token, correlationId) => {
    const url = `${apiBaseUrl}/v1/tutorias/${idTutoria}`;
    console.log(`[CLIENT] ---> DELETE ${url} | Correlation-ID: ${correlationId}`);

    const response = await axios.delete(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Correlation-ID': correlationId
        }
    });
    return response.data;
};

const reprogramarTutoria = async (idTutoria, nuevaFecha, duracionMinutos, token, correlationId) => {
    const url = `${apiBaseUrl}/v1/tutorias/${idTutoria}/reprogramar`;
    console.log(`[CLIENT] ---> PATCH ${url} | Correlation-ID: ${correlationId}`);

    const response = await axios.patch(url, { nuevaFecha, duracionMinutos }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Correlation-ID': correlationId
        }
    });
    return response.data;
};

// Catalogo de tutores para el desplegable. Va directo a ms-usuarios, no por el orquestador.
const listarTutores = async (token, correlationId) => {
    const url = `${usuariosServiceUrl}/tutores`;
    console.log(`[CLIENT] ---> GET ${url} | Correlation-ID: ${correlationId}`);

    const response = await axios.get(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Correlation-ID': correlationId
        }
    });
    return response.data;
};

module.exports = { login, solicitarTutoria, listarTutorias, cancelarTutoria, reprogramarTutoria, listarTutores };
// client-mobile-sim/src/scenarios/cancelarTutoria.js
const { v4: uuidv4 } = require('uuid');
const backendClient = require('../api_client/backend.client');

/**
 * Ejecuta el escenario de cancelar una tutoría CONFIRMADA del estudiante autenticado.
 * @param {object} data
 * @param {string} data.username
 * @param {string} data.password
 * @param {string} data.idTutoria
 * @returns {object} La tutoría cancelada.
 * @throws {Error} Si la autenticación o la cancelación fallan.
 */
const cancelar = async (data) => {
    const correlationId = uuidv4();
    const { username, password, idTutoria } = data;

    console.log(`[ESCENARIO] Autenticando a ${username} para cancelar ${idTutoria}...`);
    const accessToken = await backendClient.login(username, password);

    console.log(`[ESCENARIO] Cancelando tutoría ${idTutoria}...`);
    const resultado = await backendClient.cancelarTutoria(idTutoria, accessToken, correlationId);

    return resultado;
};

module.exports = { cancelar };

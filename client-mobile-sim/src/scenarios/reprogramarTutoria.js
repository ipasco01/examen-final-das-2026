// client-mobile-sim/src/scenarios/reprogramarTutoria.js
const { v4: uuidv4 } = require('uuid');
const backendClient = require('../api_client/backend.client');

/**
 * Ejecuta el escenario de reprogramar una tutoría CONFIRMADA del estudiante autenticado.
 * @param {object} data
 * @param {string} data.username
 * @param {string} data.password
 * @param {string} data.idTutoria
 * @param {string} data.nuevaFecha - ISO 8601
 * @param {number} [data.duracionMinutos]
 * @returns {object} La tutoría con su nueva fecha.
 * @throws {Error} Si la autenticación o la reprogramación fallan.
 */
const reprogramar = async (data) => {
    const correlationId = uuidv4();
    const { username, password, idTutoria, nuevaFecha, duracionMinutos } = data;

    console.log(`[ESCENARIO] Autenticando a ${username} para reprogramar ${idTutoria}...`);
    const accessToken = await backendClient.login(username, password);

    console.log(`[ESCENARIO] Reprogramando tutoría ${idTutoria} hacia ${nuevaFecha}...`);
    const resultado = await backendClient.reprogramarTutoria(
        idTutoria,
        nuevaFecha,
        duracionMinutos || 60,
        accessToken,
        correlationId
    );

    return resultado;
};

module.exports = { reprogramar };

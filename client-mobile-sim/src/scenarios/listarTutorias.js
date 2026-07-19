// client-mobile-sim/src/scenarios/listarTutorias.js
const { v4: uuidv4 } = require('uuid');
const backendClient = require('../api_client/backend.client');

/**
 * Ejecuta el escenario de listar las tutorías del estudiante autenticado.
 * @param {object} data
 * @param {string} data.username
 * @param {string} data.password
 * @returns {object[]} Listado de tutorías del estudiante.
 * @throws {Error} Si la autenticación o la consulta fallan.
 */
const listar = async (data) => {
    const correlationId = uuidv4();
    const { username, password } = data;

    console.log(`[ESCENARIO] Autenticando a ${username} para listar sus tutorías...`);
    const accessToken = await backendClient.login(username, password);

    console.log(`[ESCENARIO] Listando tutorías...`);
    const tutorias = await backendClient.listarTutorias(accessToken, correlationId);

    return tutorias;
};

module.exports = { listar };

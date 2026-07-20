// client-mobile-sim/index.js
require('dotenv').config(); // Cargar .env
const express = require('express');
const path = require('path');
const { solicitar } = require('./src/scenarios/solicitarTutoria');
const { listar } = require('./src/scenarios/listarTutorias');
const { cancelar } = require('./src/scenarios/cancelarTutoria');
const { reprogramar } = require('./src/scenarios/reprogramarTutoria');

const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares para parsear JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint de API para recibir la solicitud del formulario
app.post('/api/solicitar', async (req, res) => {
    console.log(`[API] Recibida solicitud POST en /api/solicitar`);
    try {
        // req.body contiene los datos del formulario (username, password, idTutor, etc.)
        const resultado = await solicitar(req.body);
        // Éxito
        res.status(201).json(resultado);
    } catch (error) {
        // Manejar errores
        console.error(`[API] Error en /api/solicitar: ${error.message}`);
        // Si el error viene de Axios (falla del backend), tendrá un 'response'
        if (error.response) {
            res.status(error.response.status).json({ error: error.response.data.error || 'Error del backend' });
        } else {
            // Error interno del cliente (ej. fallo de login)
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

// Endpoint de API para listar las tutorías del estudiante autenticado ("ver mis tutorías")
app.post('/api/tutorias/listar', async (req, res) => {
    console.log(`[API] Recibida solicitud POST en /api/tutorias/listar`);
    try {
        const tutorias = await listar(req.body);
        res.status(200).json(tutorias);
    } catch (error) {
        console.error(`[API] Error en /api/tutorias/listar: ${error.message}`);
        if (error.response) {
            res.status(error.response.status).json({ error: error.response.data.error || 'Error del backend' });
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

// Endpoint de API para cancelar una tutoría CONFIRMADA
app.post('/api/tutorias/:id/cancelar', async (req, res) => {
    console.log(`[API] Recibida solicitud POST en /api/tutorias/${req.params.id}/cancelar`);
    try {
        const resultado = await cancelar({ ...req.body, idTutoria: req.params.id });
        res.status(200).json(resultado);
    } catch (error) {
        console.error(`[API] Error en /api/tutorias/${req.params.id}/cancelar: ${error.message}`);
        if (error.response) {
            res.status(error.response.status).json({ error: error.response.data.error || 'Error del backend' });
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

// Endpoint de API para reprogramar una tutoría CONFIRMADA
app.post('/api/tutorias/:id/reprogramar', async (req, res) => {
    console.log(`[API] Recibida solicitud POST en /api/tutorias/${req.params.id}/reprogramar`);
    try {
        const resultado = await reprogramar({ ...req.body, idTutoria: req.params.id });
        res.status(200).json(resultado);
    } catch (error) {
        console.error(`[API] Error en /api/tutorias/${req.params.id}/reprogramar: ${error.message}`);
        if (error.response) {
            res.status(error.response.status).json({ error: error.response.data.error || 'Error del backend' });
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Cliente Simulador Interactivo corriendo en http://localhost:${PORT}`);
});
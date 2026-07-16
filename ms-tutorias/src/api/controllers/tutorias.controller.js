const tutoriaService = require('../../domain/services/tutoria.service');

const postSolicitud = async (req, res, next) => {
    try {
        // ================== INICIO DE CAMBIOS ==================

        // 0. IDEMPOTENCY-KEY (OBLIGATORIO)
        // Sin esta clave no podemos deduplicar reintentos del cliente, así que se exige antes de cualquier
        // otra validación.
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) {
            throw { statusCode: 400, message: 'El header Idempotency-Key es obligatorio para solicitar una tutoría.' };
        }

        // 1. VERIFICACIÓN DE ROL (AUTORIZACIÓN)
        // El objeto req.user fue añadido por nuestro middleware jwt.middleware.js
        if (req.user.role !== 'student') {
            // Si el usuario no es un estudiante (ej. es un tutor), denegamos la acción.
            throw { statusCode: 403, message: 'Acción no permitida. Solo los estudiantes pueden solicitar tutorías.' };
        }

        // 2. FORZAR LA IDENTIDAD (INTEGRIDAD)
        // Creamos un nuevo payload para el servicio que es 100% confiable.
        // Usamos todo lo que viene en el body, PERO sobreescribimos/aseguramos
        // el idEstudiante con el que viene en el token (req.user.sub).
        const datosConfiables = {
            ...req.body,
            idEstudiante: req.user.sub, // 'sub' es el campo estándar para el ID de sujeto en JWT.
            idempotencyKey
        };
        
        const correlationId = req.correlationId;
        const demoFailAfterBloqueo = req.header('X-Demo-Fail-After-Bloqueo') === 'true';

        // 3. PASAR DATOS CONFIABLES AL SERVICIO
        // El servicio ahora recibirá un idEstudiante que sabemos que es auténtico.
        const resultado = await tutoriaService.solicitarTutoria(datosConfiables, correlationId, {
            demoFailAfterBloqueo
        });
        
        // =================== FIN DE CAMBIOS ===================

        res.status(201).json(resultado);
    } catch (error) {
        next(error);
    }
};

module.exports = { postSolicitud };

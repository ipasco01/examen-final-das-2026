const tutoriaService = require('../../domain/services/tutoria.service');

// DTO de respuesta pública (E2): tutoriaService/el repository devuelven la fila cruda de Postgres
// (columnas en minúscula por el RETURNING * sobre columnas sin comillas, más la columna interna
// `error` pensada para diagnóstico). Mapeamos explícitamente a los campos de contrato público en
// camelCase -- igual que el body de la solicitud -- y solo incluimos el motivo de una falla cuando
// corresponde, en vez de un `error: null` confuso en el camino feliz.
const toTutoriaResponse = (tutoria) => {
    const dto = {
        idTutoria: tutoria.idtutoria,
        idEstudiante: tutoria.idestudiante,
        idTutor: tutoria.idtutor,
        fecha: tutoria.fecha,
        materia: tutoria.materia,
        estado: tutoria.estado
    };
    if (tutoria.estado === 'FALLIDA' && tutoria.error) {
        dto.motivoFallo = tutoria.error;
    }
    return dto;
};

const postSolicitud = async (req, res, next) => {
    try {
        // ================== INICIO DE CAMBIOS ==================

        // 0. IDEMPOTENCY-KEY (OBLIGATORIO)
        // Sin esta clave no podemos deduplicar reintentos del cliente, así que se exige antes de cualquier
        // otra validación.
        const idempotencyKey = req.header('Idempotency-Key');
        if (!idempotencyKey) {
            throw Object.assign(new Error('El header Idempotency-Key es obligatorio para solicitar una tutoría.'), { statusCode: 400 });
        }

        // 1. VERIFICACIÓN DE ROL (AUTORIZACIÓN)
        // El objeto req.user fue añadido por nuestro middleware jwt.middleware.js
        if (req.user.role !== 'student') {
            // Si el usuario no es un estudiante (ej. es un tutor), denegamos la acción.
            throw Object.assign(new Error('Acción no permitida. Solo los estudiantes pueden solicitar tutorías.'), { statusCode: 403 });
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

        // E1: si la Idempotency-Key corresponde a una tutoría que ya quedó FALLIDA, este request no
        // "creó" nada -- responder 201 ahí decía "creado con éxito" sobre un recurso que en
        // realidad falló. 409 refleja que el estado actual del recurso es un conflicto terminal.
        const statusCode = resultado.estado === 'FALLIDA' ? 409 : 201;
        res.status(statusCode).json(toTutoriaResponse(resultado));
    } catch (error) {
        next(error);
    }
};

module.exports = { postSolicitud };

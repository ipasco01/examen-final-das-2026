const tutoriaService = require('../../domain/services/tutoria.service');

// S5: sin esto, un duracionMinutos/materia/fechaSolicitada inválido se reenviaba tal cual a
// ms-agenda o se persistía crudo (ej. "Tutoría de  confirmada" con materia vacía), y una
// fechaSolicitada mal formada recién se descubría cuando Postgres rechazaba el INSERT -- después
// de ya haber llamado a ms-agenda con el valor crudo en la URL. Mismo criterio que
// ms-agenda/agenda.controller.js usa para validar fechaHora: chequeo imperativo en el controller,
// sin librería nueva. Coincide además con los cuatro campos que swagger.yaml ya marca `required`
// en SolicitudTutoriaRequest, hoy sin aplicar en código.
//
// Solo forma/tipo aquí -- deliberadamente NO valida que fechaSolicitada sea futura. Esta función
// corre en todo request, incluidos los reintentos idempotentes (misma Idempotency-Key, mismo
// body); si el reintento llega después de que la fecha originalmente solicitada ya pasó, la Saga
// original de todos modos debe resolverse por el short-circuit de idempotencia, no rechazarse por
// forma. La regla de negocio "debe ser futura" vive en tutoria.service.js, después de ese
// short-circuit, donde solo aplica a una Saga genuinamente nueva.
const validarSolicitud = (body) => {
    const { idTutor, materia, duracionMinutos, fechaSolicitada } = body;

    if (!idTutor || typeof idTutor !== 'string') {
        throw Object.assign(new Error('El campo "idTutor" es obligatorio.'), { statusCode: 400 });
    }
    if (!materia || typeof materia !== 'string' || !materia.trim()) {
        throw Object.assign(new Error('El campo "materia" es obligatorio y no puede estar vacío.'), { statusCode: 400 });
    }
    if (typeof duracionMinutos !== 'number' || !Number.isFinite(duracionMinutos) || duracionMinutos <= 0) {
        throw Object.assign(new Error('El campo "duracionMinutos" debe ser un número positivo.'), { statusCode: 400 });
    }
    if (!fechaSolicitada || Number.isNaN(new Date(fechaSolicitada).getTime())) {
        throw Object.assign(new Error('El campo "fechaSolicitada" debe ser una fecha válida en formato ISO 8601.'), { statusCode: 400 });
    }
};

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
        tutorNombre: tutoria.nombretutor || null,
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

        // 1b. VALIDACIÓN DE CAMPOS (S5)
        validarSolicitud(req.body);

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
        // Reenviamos el mismo token del usuario a ms-usuarios/ms-agenda: ya pasó verifyToken aquí,
        // así que es válido para las llamadas server-to-server de esta misma Saga.
        const authHeader = req.header('Authorization');

        // 3. PASAR DATOS CONFIABLES AL SERVICIO
        // El servicio ahora recibirá un idEstudiante que sabemos que es auténtico.
        const resultado = await tutoriaService.solicitarTutoria(datosConfiables, correlationId, {
            demoFailAfterBloqueo,
            authHeader
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

// S8: no existía forma de consultar el estado de una tutoría después de crearla (ej. una que
// quedó PENDIENTE por una respuesta lenta de ms-agenda). No se distingue "no existe" de "no es
// tuya" con un 403 aparte -- ambos casos responden 404, para no confirmarle a un estudiante
// autenticado que un idTutoria ajeno existe.
const getTutoriaPorId = async (req, res, next) => {
    try {
        const { id } = req.params;
        const tutoria = await tutoriaService.obtenerTutoriaPorId(id);

        if (!tutoria || tutoria.idestudiante !== req.user.sub) {
            throw Object.assign(new Error('Tutoría no encontrada.'), { statusCode: 404 });
        }

        res.status(200).json(toTutoriaResponse(tutoria));
    } catch (error) {
        next(error);
    }
};

// Listado de "mis tutorías" -- pedido explícito del usuario tras agregar getTutoriaPorId: consultar
// una por id es poco útil desde un cliente si primero no sabés el id; esto es lo que realmente
// sirve para mostrar en una pantalla de "mis tutorías". Alcance acotado al estudiante autenticado
// (mismo criterio de ownership que postSolicitud/getTutoriaPorId), no a lo que el tutor tiene
// asignado -- ms-tutorias no tiene hoy ningún camino tutor-facing.
const getTutoriasDelEstudiante = async (req, res, next) => {
    try {
        const tutorias = await tutoriaService.listarTutoriasPorEstudiante(req.user.sub);
        res.status(200).json(tutorias.map(toTutoriaResponse));
    } catch (error) {
        next(error);
    }
};

// Cancelación de una tutoría CONFIRMADA (pedido explícito del usuario, cierra el gap de CANCELADA
// documentado en S11). Ownership acá también: 404 uniforme para "no existe" y "no es tuya".
const cancelarTutoria = async (req, res, next) => {
    try {
        const { id } = req.params;
        const resultado = await tutoriaService.cancelarTutoria(id, req.user.sub, req.correlationId);
        res.status(200).json(toTutoriaResponse(resultado));
    } catch (error) {
        next(error);
    }
};

module.exports = { postSolicitud, getTutoriaPorId, getTutoriasDelEstudiante, cancelarTutoria };

// ms-tutorias/src/domain/models/tutoria-estado.js
//
// Máquina de estados explícita para la tutoría. Estados posibles según el CHECK de
// `docs/setup-and-usage.md`: PENDIENTE, CONFIRMADA, FALLIDA, CANCELADA. Solo se declaran las
// transiciones que el código realmente ejecuta.

const ESTADOS = {
    PENDIENTE: 'PENDIENTE',
    CONFIRMADA: 'CONFIRMADA',
    FALLIDA: 'FALLIDA',
    CANCELADA: 'CANCELADA'
};

const TRANSICIONES_VALIDAS = {
    [ESTADOS.PENDIENTE]: [ESTADOS.CONFIRMADA, ESTADOS.FALLIDA],
    // Solo se puede cancelar una tutoría ya CONFIRMADA (tutoriaService#cancelarTutoria) -- una
    // PENDIENTE huérfana ya tiene su propio camino de cierre (el worker de reconciliación).
    [ESTADOS.CONFIRMADA]: [ESTADOS.CANCELADA]
};

// Estados desde los cuales es válido transicionar hacia `estadoDestino`. Un destino sin orígenes
// declarados (p.ej. CANCELADA, o cualquier estado terminal) devuelve un array vacío, lo que hace
// que el UPDATE guardado por este array (`WHERE estado = ANY($array)`) nunca matchee ninguna fila
// -- falla cerrado por diseño, no es un bug.
const obtenerEstadosOrigenValidos = (estadoDestino) => {
    return Object.entries(TRANSICIONES_VALIDAS)
        .filter(([, destinos]) => destinos.includes(estadoDestino))
        .map(([origen]) => origen);
};

module.exports = { ESTADOS, TRANSICIONES_VALIDAS, obtenerEstadosOrigenValidos };

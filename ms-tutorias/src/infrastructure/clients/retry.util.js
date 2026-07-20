// ms-tutorias/src/infrastructure/clients/retry.util.js
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Full jitter (AWS Architecture Blog, "Exponential Backoff And Jitter"): sortea un delay entre 0 y
// el techo exponencial en vez de un delay fijo o linear -- evita que varias Sagas concurrentes que
// fallaron al mismo tiempo reintenten todas en el mismo instante y sincronicen una segunda ola de
// carga sobre un servicio que recién se está recuperando.
const delayConJitter = (intento, baseDelayMs) => Math.random() * baseDelayMs * (2 ** (intento - 1));

// Solo se reintentan fallos de infraestructura: sin respuesta HTTP (timeout, conexión
// rechazada/reseteada, DNS) o el circuito ya abierto. Nunca se reintenta ante una respuesta HTTP
// real (4xx/5xx de negocio, p.ej. 404/409) para no enmascarar errores de negocio ni convertir un
// resultado de negocio válido en un reintento inútil.
const esFalloDeInfraestructura = (error, isOpenCircuitError) =>
    !error.response && !isOpenCircuitError(error);

// Ejecuta `ejecutar` hasta `maxIntentos` veces. Se detiene apenas: (a) tiene éxito, (b) el error no
// es reintentable (respuesta HTTP real, o circuito ya abierto -- en ese caso seguir insistiendo
// solo agregaría carga a un servicio que el breaker ya identificó como caído), o (c) se agotaron
// los intentos.
const conReintentos = async (ejecutar, { maxIntentos, baseDelayMs, isOpenCircuitError, onIntentoFallido }) => {
    let ultimoError;
    for (let intento = 1; intento <= maxIntentos; intento += 1) {
        try {
            return await ejecutar();
        } catch (error) {
            ultimoError = error;
            const reintentable = esFalloDeInfraestructura(error, isOpenCircuitError);
            if (!reintentable || intento === maxIntentos) throw error;
            if (onIntentoFallido) onIntentoFallido(intento, error);
            await sleep(delayConJitter(intento, baseDelayMs));
        }
    }
    throw ultimoError;
};

module.exports = { conReintentos, esFalloDeInfraestructura, delayConJitter };

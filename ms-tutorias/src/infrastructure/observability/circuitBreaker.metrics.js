const client = require('prom-client');
 
// Gauge (sube y baja, a diferencia de un Counter): representa el estado ACTUAL
// del circuit breaker en un momento dado, no un conteo acumulado.
// Valores: 0 = cerrado (todo bien), 0.5 = half-open (probando recuperación), 1 = abierto (cortado).
// La label "target_service" permite tener un solo gauge para los 2 breakers
// (hacia ms-agenda y hacia ms-usuarios) en vez de duplicar métricas.
const circuitBreakerState = new client.Gauge({
    name: 'circuit_breaker_state',
    help: 'Estado del circuit breaker hacia un servicio dependiente (0=cerrado, 0.5=half-open, 1=abierto)',
    labelNames: ['target_service']
});
 
module.exports = { circuitBreakerState };
 
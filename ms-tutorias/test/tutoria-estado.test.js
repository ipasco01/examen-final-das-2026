const assert = require('node:assert/strict');
const test = require('node:test');

const { ESTADOS, obtenerEstadosOrigenValidos } = require('../src/domain/models/tutoria-estado');

test('CONFIRMADA solo es alcanzable desde PENDIENTE', () => {
    assert.deepEqual(obtenerEstadosOrigenValidos(ESTADOS.CONFIRMADA), [ESTADOS.PENDIENTE]);
});

test('FALLIDA solo es alcanzable desde PENDIENTE', () => {
    assert.deepEqual(obtenerEstadosOrigenValidos(ESTADOS.FALLIDA), [ESTADOS.PENDIENTE]);
});

test('PENDIENTE no tiene orígenes válidos (es siempre el estado inicial)', () => {
    assert.deepEqual(obtenerEstadosOrigenValidos(ESTADOS.PENDIENTE), []);
});

test('CANCELADA solo es alcanzable desde CONFIRMADA', () => {
    assert.deepEqual(obtenerEstadosOrigenValidos(ESTADOS.CANCELADA), [ESTADOS.CONFIRMADA]);
});

test('un estado desconocido tampoco tiene orígenes válidos', () => {
    assert.deepEqual(obtenerEstadosOrigenValidos('NO_EXISTE'), []);
});

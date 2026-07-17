const assert = require('node:assert/strict');
const { test } = require('node:test');

const outboxRepository = require('../src/infrastructure/repositories/outbox.repository');
const compensacionRepository = require('../src/infrastructure/repositories/compensacion.repository');

const fakeClient = (rows) => {
    const queries = [];
    return {
        queries,
        client: {
            query: async (text, params) => {
                queries.push({ text, params });
                return { rows };
            }
        }
    };
};

test('outbox.reencolarFallidos sin ids reabre todas las filas FALLIDO', async () => {
    const { queries, client } = fakeClient([{ idoutbox: 'o1' }, { idoutbox: 'o2' }]);

    const filas = await outboxRepository.reencolarFallidos(client);

    assert.equal(filas.length, 2);
    assert.match(queries[0].text, /estado = 'FALLIDO'/);
    assert.doesNotMatch(queries[0].text, /idOutbox = ANY/);
    assert.deepEqual(queries[0].params, []);
});

test('outbox.reencolarFallidos con ids filtra por idOutbox', async () => {
    const { queries, client } = fakeClient([{ idoutbox: 'o1' }]);

    const filas = await outboxRepository.reencolarFallidos(client, ['o1']);

    assert.equal(filas.length, 1);
    assert.match(queries[0].text, /idOutbox = ANY\(\$1\)/);
    assert.deepEqual(queries[0].params, [['o1']]);
});

test('compensacion.reencolarFallidos sin ids reabre todas las filas FALLIDO', async () => {
    const { queries, client } = fakeClient([{ idcompensacion: 'c1' }]);

    const filas = await compensacionRepository.reencolarFallidos(client);

    assert.equal(filas.length, 1);
    assert.doesNotMatch(queries[0].text, /idCompensacion = ANY/);
    assert.deepEqual(queries[0].params, []);
});

test('compensacion.reencolarFallidos con ids filtra por idCompensacion', async () => {
    const { queries, client } = fakeClient([{ idcompensacion: 'c1' }]);

    const filas = await compensacionRepository.reencolarFallidos(client, ['c1', 'c2']);

    assert.equal(filas.length, 1);
    assert.match(queries[0].text, /idCompensacion = ANY\(\$1\)/);
    assert.deepEqual(queries[0].params, [['c1', 'c2']]);
});

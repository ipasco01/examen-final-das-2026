// S9 + S12: jwt.middleware.js no tenía ningún test (docs/audit-compliance-matrix.md ya lo pedía
// explícitamente). Cubre los casos 401 por token ausente/mal formado/inválido/expirado, y que un
// token válido firmado con HS256 (mismo algoritmo que ms-auth usa para firmar, por defecto al no
// especificar uno) pasa correctamente con el algorithms explícito agregado en S9.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const configPath = require.resolve(path.join(ROOT, 'src/config/index.js'));
const middlewarePath = path.join(ROOT, 'src/api/middlewares/jwt.middleware.js');

const SECRETO = 'secreto-de-test';

require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { jwtSecret: SECRETO }
};

delete require.cache[require.resolve(middlewarePath)];
const verifyToken = require(middlewarePath);

const createRequest = (headerValue) => ({
    header: (name) => (name === 'Authorization' ? headerValue : undefined)
});

const createResponse = () => {
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    return response;
};

test('rechaza con 401 cuando falta el header Authorization', () => {
    const req = createRequest(undefined);
    const res = createResponse();
    let nextCalled = false;

    verifyToken(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 401);
    assert.match(res.body.error.message, /Token no proporcionado/);
    assert.equal(nextCalled, false);
});

test('rechaza con 401 cuando el header no tiene formato "Bearer <token>"', () => {
    const casos = ['Bearer', 'Basic abc123', 'Bearer '];
    for (const headerValue of casos) {
        const req = createRequest(headerValue);
        const res = createResponse();
        let nextCalled = false;

        verifyToken(req, res, () => { nextCalled = true; });

        assert.equal(res.statusCode, 401, `caso: "${headerValue}"`);
        assert.match(res.body.error.message, /Formato de token inválido/);
        assert.equal(nextCalled, false);
    }
});

test('rechaza con 401 un token con firma inválida', () => {
    const tokenFirmadoConOtroSecreto = jwt.sign({ sub: 'e1', role: 'student' }, 'otro-secreto', { expiresIn: '1h' });
    const req = createRequest(`Bearer ${tokenFirmadoConOtroSecreto}`);
    const res = createResponse();
    let nextCalled = false;

    verifyToken(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 401);
    assert.match(res.body.error.message, /Token inválido o expirado/);
    assert.equal(nextCalled, false);
});

test('rechaza con 401 un token expirado', () => {
    const tokenExpirado = jwt.sign({ sub: 'e1', role: 'student' }, SECRETO, { expiresIn: -10 });
    const req = createRequest(`Bearer ${tokenExpirado}`);
    const res = createResponse();
    let nextCalled = false;

    verifyToken(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test('acepta un token HS256 válido y adjunta el payload decodificado a req.user', () => {
    const tokenValido = jwt.sign({ sub: 'e12345', name: 'Ana Torres', role: 'student' }, SECRETO, { expiresIn: '1h' });
    const req = createRequest(`Bearer ${tokenValido}`);
    const res = createResponse();
    let nextCalled = false;

    verifyToken(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
    assert.equal(req.user.sub, 'e12345');
    assert.equal(req.user.role, 'student');
});

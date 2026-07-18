// ms-tutorias/src/api/middlewares/jwt.middleware.js
const jwt = require('jsonwebtoken');
const config = require('../../config');

const verifyToken = (req, res, next) => {
    // 1. Obtener el header 'Authorization'
    const authHeader = req.header('Authorization');
    if (!authHeader) {
        return res.status(401).json({ error: { message: 'Acceso denegado. Token no proporcionado.' } });
    }

    // 2. Verificar que el formato sea "Bearer <token>"
    const [bearer, token] = authHeader.split(' ');
    if (bearer !== 'Bearer' || !token) {
        return res.status(401).json({ error: { message: 'Formato de token inválido. Debe ser "Bearer <token>".' } });
    }

    try {
        // 3. Verificar el token usando el secreto
        // S9: fijar el algoritmo esperado explícitamente. Con la config actual (secreto en
        // string, no un par de claves RS256) jwt.verify ya se limita a HS256/384/512 por defecto
        // -- no es explotable hoy -- pero no fijarlo es depender de un comportamiento implícito de
        // la librería en vez de una garantía explícita. Endurecimiento defensivo de costo cero.
        const decodedPayload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });

        // 4. Si el token es válido, adjuntar el payload al objeto request
        // para que los siguientes middlewares y controladores puedan usarlo.
        req.user = decodedPayload; // ej: req.user = { sub: 'e12345', name: 'Ana Torres', role: 'student', ... }
        
        next(); // El token es válido, permitir que la petición continúe.

    } catch (error) {
        // Si jwt.verify falla (firma inválida, token expirado), lanzará un error.
        return res.status(401).json({ error: { message: 'Token inválido o expirado.' } });
    }
};

module.exports = verifyToken;
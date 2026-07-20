// ms-agenda/src/api/middlewares/jwt.middleware.js
const jwt = require('jsonwebtoken');
const config = require('../../config');

const verifyToken = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) {
        return res.status(401).json({ error: { message: 'Acceso denegado. Token no proporcionado.' } });
    }

    const [bearer, token] = authHeader.split(' ');
    if (bearer !== 'Bearer' || !token) {
        return res.status(401).json({ error: { message: 'Formato de token inválido. Debe ser "Bearer <token>".' } });
    }

    try {
        const decodedPayload = jwt.verify(token, config.jwtSecret);
        req.user = decodedPayload;
        next();
    } catch (error) {
        return res.status(401).json({ error: { message: 'Token inválido o expirado.' } });
    }
};

module.exports = verifyToken;

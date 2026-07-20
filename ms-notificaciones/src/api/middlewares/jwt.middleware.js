// ms-notificaciones/src/api/middlewares/jwt.middleware.js
//
// David: archivo NUEVO. Es EXACTAMENTE el mismo código que ya usan
// ms-usuarios, ms-agenda y ms-tutorias -- no se inventa una forma nueva de
// validar el token, se copia la que ya está probada y funcionando en los
// otros 3 servicios, para que el "carnet" (JWT) se revise igual en todos
// lados.
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
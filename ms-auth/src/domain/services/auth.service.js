// ms-auth/src/domain/services/auth.service.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const userRepository = require('../../infrastructure/repositories/user.repository');

const login = async (username, password) => {
    // 1. Buscar al usuario
    const user = await userRepository.findByUsername(username);
    if (!user) {
        throw Object.assign(new Error('Credenciales inválidas'), { statusCode: 401 });
    }

    // 2. Comparar la contraseña proporcionada con el hash almacenado
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
        throw Object.assign(new Error('Credenciales inválidas'), { statusCode: 401 });
    }

    // 3. Si todo es válido, generar el JWT
    const payload = {
        sub: user.id,
        name: user.name,
        role: user.role,
        iss: "mobile-app-consumer"
    };

    const token = jwt.sign(payload, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn
    });

    return { access_token: token };
};

module.exports = { login };
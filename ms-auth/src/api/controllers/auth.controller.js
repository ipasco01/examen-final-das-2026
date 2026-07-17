const authService = require('../../domain/services/auth.service');

const postToken = async (req, res, next) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            throw Object.assign(new Error('Usuario y contraseña son requeridos'), { statusCode: 400 });
        }
        const token = await authService.login(username, password);
        res.status(200).json(token);
    } catch (error) {
        next(error);
    }
};

module.exports = { postToken };
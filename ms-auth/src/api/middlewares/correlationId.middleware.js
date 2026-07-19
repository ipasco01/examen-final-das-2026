const { randomUUID } = require('crypto');

const correlationIdMiddleware = (req, res, next) => {
    const correlationId = req.header('X-Correlation-ID') || randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);
    next();
};

module.exports = correlationIdMiddleware;
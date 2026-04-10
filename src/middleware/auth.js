/**
 * @file auth.js
 * @description Express middleware to verify JWT on protected routes.
 */
import jwt from 'jsonwebtoken';

/**
 * HTTP middleware — verifies Bearer token and attaches decoded payload to req.user.
 */
export function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { userId, username }
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

/**
 * Socket.io middleware — verifies JWT from socket.handshake.auth.token
 * and attaches decoded payload to socket.user.
 */
export function verifySocketJWT(socket, next) {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error('Authentication error: no token'));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = decoded; // { userId, username }
        next();
    } catch {
        next(new Error('Authentication error: invalid token'));
    }
}

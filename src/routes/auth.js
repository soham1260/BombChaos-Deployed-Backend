/**
 * @file auth.js (routes)
 * @description Auth routes: register and login.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

const router = Router();

function signToken(user) {
    return jwt.sign(
        { userId: user._id.toString(), username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.trim().length < 2 || username.trim().length > 20) {
        return res.status(400).json({ error: 'Username must be 2–20 characters' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const existing = await User.findOne({ username: username.trim() });
        if (existing) return res.status(409).json({ error: 'Username already taken' });

        const hashed = await bcrypt.hash(password, 10);
        const user = await User.create({ username: username.trim(), password: hashed });

        const token = signToken(user);
        res.status(201).json({
            token,
            user: { userId: user._id.toString(), username: user.username, rating: user.rating },
        });
    } catch (err) {
        console.error('[Auth] Register error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const user = await User.findOne({ username: username.trim() });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = signToken(user);
        res.json({
            token,
            user: { userId: user._id.toString(), username: user.username, rating: user.rating },
        });
    } catch (err) {
        console.error('[Auth] Login error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;

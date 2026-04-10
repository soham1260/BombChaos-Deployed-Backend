import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import authRoutes from '../src/routes/auth.js';
import { User } from '../src/models/User.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

let mongoServer;

beforeAll(async () => {
    // In-memory MongoDB database instance
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    
    // mock secret
    process.env.JWT_SECRET = 'test-secret';
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    if (mongoose.connection.readyState !== 0) {
        await User.deleteMany({});
    }
});

describe('Auth API Routes', () => {
    it('POST /api/auth/register - should create a new user and return a token', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({
                username: 'testuser',
                password: 'password123'
            });

        expect(res.statusCode).toBe(201);
        expect(res.body).toHaveProperty('token');
        expect(res.body.user).toHaveProperty('username', 'testuser');
    });

    it('POST /api/auth/register - should reject short passwords', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({
                username: 'testu',
                password: '123'
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/least 6 characters/i);
    });

    it('POST /api/auth/login - should authenticate valid user', async () => {
        // Register the user first
        await request(app).post('/api/auth/register').send({ username: 'logguy', password: 'password123' });

        // Test Logging in as that user
        const res = await request(app)
            .post('/api/auth/login')
            .send({
                username: 'logguy',
                password: 'password123'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
    });

    it('POST /api/auth/login - should fail with wrong password', async () => {
        await request(app).post('/api/auth/register').send({ username: 'logguy', password: 'password123' });

        const res = await request(app)
            .post('/api/auth/login')
            .send({
                username: 'logguy',
                password: 'wrongpassword'
            });

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toMatch(/invalid credentials/i);
    });
});

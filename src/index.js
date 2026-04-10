/**
 * @file index.js
 * @description BOMB CHAOS — Express + Socket.io server entry point.
 *              Handles auth, room management, lobby, and game event relay.
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { GameRoom } from './GameRoom.js';
import { connectDB } from './config/db.js';
import { verifySocketJWT } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import { User } from './models/User.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── REST Routes ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', rooms: rooms.size }));
app.use('/api/auth', authRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

/** Map<roomCode, GameRoom> */
const rooms = new Map();

/** Map<socketId, roomCode> — track which room each socket is in */
const socketRoom = new Map();

// ─── Socket.io JWT Auth Middleware ────────────────────────────────────────────
io.use(verifySocketJWT);

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Generate a cryptographically-adequate 6-char uppercase room code. */
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

/** Broadcast updated lobby state to everyone in a room. */
function broadcastRoomUpdate(room) {
    io.to(room.code).emit('room_update', room.serializeLobby());
}

/**
 * After a game ends, apply ELO-style rating changes (+25 / -25)
 * and emit rating_update to each player's socket.
 * @param {string|null} winnerId - socket ID of winner
 * @param {GameRoom} room
 */
async function updateRatings(winnerId, room) {
    const DELTA = 25;
    const ratingChanges = {}; // socketId -> { delta, newRating }

    const updatePromises = [...room.players.values()].map(async (player) => {
        if (!player.userId) return; // shouldn't happen but guard
        const isWinner = player.id === winnerId;
        const delta = isWinner ? DELTA : -DELTA;

        try {
            const updated = await User.findByIdAndUpdate(
                player.userId,
                { $inc: { rating: delta } },
                { new: true }
            );
            if (updated) {
                ratingChanges[player.id] = { delta, newRating: updated.rating };
            }
        } catch (err) {
            console.error('[Rating] Update error for', player.username, err.message);
        }
    });

    await Promise.all(updatePromises);

    // Emit individual rating_update events
    for (const [socketId, change] of Object.entries(ratingChanges)) {
        io.to(socketId).emit('rating_update', change);
    }
}

// ─── Socket.io Events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id} (${socket.user.username})`);

    // ── create_room ──────────────────────────────────────────────────────────
    /**
     * Username + rating come from JWT (socket.user); no nickname needed from client.
     * Client emits: { } (optional rating included in room for lobby display)
     * Server responds: { success, code?, error? }
     */
    socket.on('create_room', async (_, ack) => {
        const { userId, username } = socket.user;

        // Fetch current rating from DB
        let rating = 1000;
        try {
            const user = await User.findById(userId).select('rating');
            if (user) rating = user.rating;
        } catch { /* non-critical */ }

        const code = generateRoomCode();
        const room = new GameRoom(code, socket.id, username, io, userId, rating, updateRatings);
        rooms.set(code, room);
        socketRoom.set(socket.id, code);

        socket.join(code);
        broadcastRoomUpdate(room);
        console.log(`[Room] ${code} created by ${username}`);
        ack?.({ success: true, code });
    });

    // ── join_room ─────────────────────────────────────────────────────────────
    /**
     * Client emits: { code: string }
     * Server responds: { success, error? }
     */
    socket.on('join_room', async ({ code } = {}, ack) => {
        if (!code) return ack?.({ success: false, error: 'Missing room code' });
        const upperCode = code.toUpperCase();
        const room = rooms.get(upperCode);
        if (!room) return ack?.({ success: false, error: 'Room not found' });

        const { userId, username } = socket.user;

        // Fetch current rating from DB
        let rating = 1000;
        try {
            const user = await User.findById(userId).select('rating');
            if (user) rating = user.rating;
        } catch { /* non-critical */ }

        const result = room.addPlayer(socket.id, username, userId, rating);
        if (!result.success) return ack?.({ success: false, error: result.error });

        socketRoom.set(socket.id, upperCode);
        socket.join(upperCode);
        broadcastRoomUpdate(room);
        console.log(`[Room] ${username} joined ${upperCode}`);
        ack?.({ success: true, code: upperCode });
    });

    // ── player_ready ─────────────────────────────────────────────────────────
    socket.on('player_ready', () => {
        const room = _getRoom(socket.id);
        if (!room || room.phase !== 'lobby') return;
        room.toggleReady(socket.id);
        broadcastRoomUpdate(room);
    });

    // ── select_character ─────────────────────────────────────────────────────
    socket.on('select_character', ({ character } = {}) => {
        const room = _getRoom(socket.id);
        if (!room || room.phase !== 'lobby') return;
        room.selectCharacter(socket.id, character);
        broadcastRoomUpdate(room);
    });

    // ── start_game ───────────────────────────────────────────────────────────
    socket.on('start_game', (_, ack) => {
        const room = _getRoom(socket.id);
        if (!room) return ack?.({ success: false, error: 'Not in a room' });

        const result = room.startGame(socket.id);
        if (!result.success) return ack?.({ success: false, error: result.error });

        io.to(room.code).emit('game_start', {
            mapSeed: result.mapSeed,
            playerIds: result.playerIds,
            players: room.serializeLobby().players,
        });
        console.log(`[Game] Room ${room.code} started with seed ${result.mapSeed}`);
        ack?.({ success: true });
    });

    // ── player_move ──────────────────────────────────────────────────────────
    socket.on('player_move', (move) => {
        const room = _getRoom(socket.id);
        if (!room || room.phase !== 'game') return;
        room.queueMove(socket.id, move);
    });

    // ── place_bomb ───────────────────────────────────────────────────────────
    socket.on('place_bomb', () => {
        const room = _getRoom(socket.id);
        if (!room || room.phase !== 'game') return;
        const bomb = room.placeBomb(socket.id);
        if (bomb) {
            io.to(room.code).emit('bomb_placed', bomb);
        }
    });

    // ── detonate_bomb ─────────────────────────────────────────────────────────
    socket.on('detonate_bomb', () => {
        const room = _getRoom(socket.id);
        if (!room || room.phase !== 'game') return;
        room.detonateRemote(socket.id);
    });

    // ── return_to_lobby ───────────────────────────────────────────────────────
    socket.on('return_to_lobby', () => {
        const room = _getRoom(socket.id);
        if (!room) return;
        if (socket.id !== room.hostId) return;
        room.phase = 'lobby';
        room.gameState = null;
        for (const player of room.players.values()) {
            player.ready = false;
        }
        broadcastRoomUpdate(room);
        console.log(`[Room] ${room.code} returned to lobby`);
    });

    // ── leave_room ────────────────────────────────────────────────────────────
    socket.on('leave_room', () => {
        const room = _getRoom(socket.id);
        if (!room) return;

        const { empty } = room.removePlayer(socket.id);
        socketRoom.delete(socket.id);
        socket.leave(room.code);

        if (empty) {
            rooms.delete(room.code);
            console.log(`[Room] ${room.code} destroyed (empty after leave)`);
        } else {
            broadcastRoomUpdate(room);
            console.log(`[Room] ${socket.id} voluntarily left ${room.code}`);
        }
    });

    // ── chat_message ─────────────────────────────────────────────────────────
    socket.on('chat_message', ({ text } = {}) => {
        const room = _getRoom(socket.id);
        if (!room || !text || typeof text !== 'string') return;
        const player = room.players.get(socket.id);
        if (!player) return;
        io.to(room.code).emit('chat_message', {
            nickname: player.nickname,
            color: player.color,
            text: text.trim().slice(0, 200),
            timestamp: Date.now(),
        });
    });

    // ── player_taunt ─────────────────────────────────────────────────────────
    socket.on('player_taunt', ({ taunt } = {}) => {
        const room = _getRoom(socket.id);
        if (!room) return;
        const player = room.players.get(socket.id);
        if (!player) return;
        io.to(room.code).emit('player_taunt', { playerId: socket.id, nickname: player.nickname, taunt });
    });

    // ── game_over (rating update hook) ────────────────────────────────────────
    // Ratings are updated automatically by GameRoom via the onGameOver callback.

    // ── disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] Disconnected: ${socket.id} (${socket.user?.username})`);
        const room = _getRoom(socket.id);
        if (!room) return;

        const { empty } = room.removePlayer(socket.id);
        socketRoom.delete(socket.id);

        if (empty) {
            rooms.delete(room.code);
            console.log(`[Room] ${room.code} destroyed (empty)`);
        } else {
            broadcastRoomUpdate(room);
        }
    });

    // ─── Helper ──────────────────────────────────────────────────────────────
    function _getRoom(socketId) {
        const code = socketRoom.get(socketId);
        return code ? rooms.get(code) : null;
    }
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
    await connectDB();
    httpServer.listen(PORT, () => {
        console.log(` BOMB CHAOS server running on http://localhost:${PORT}`);
    });
}

start();

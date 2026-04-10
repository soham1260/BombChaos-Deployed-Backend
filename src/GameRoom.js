/**
 * @file GameRoom.js
 * @description Manages a single game room: lobby, player slots, 60 Hz game loop.
 */

import { GameState } from './GameState.js';
import {
    MAX_PLAYERS, MIN_PLAYERS_TO_START, TICK_MS, PLAYER_COLORS, CHARACTERS,
} from './constants.js';

export class GameRoom {
    /**
     * @param {string} code - 6-character room code
     * @param {string} hostId - Socket ID of the room creator
     * @param {string} hostNickname - Display name of the host
     * @param {import('socket.io').Server} io - Socket.io server instance
     * @param {string} [hostUserId] - MongoDB user ID of host
     * @param {number} [hostRating=1000] - Current ELO rating of host
     * @param {Function} [onGameOver] - Called with (winnerId, room) after game ends
     */
    constructor(code, hostId, hostNickname, io, hostUserId = null, hostRating = 1000, onGameOver = null) {
        this.code = code;
        this.hostId = hostId;
        this.io = io;

        /** Map<socketId, playerInfo> */
        this.players = new Map();
        this.players.set(hostId, {
            id: hostId,
            nickname: hostNickname,
            userId: hostUserId,
            rating: hostRating,
            slotIndex: 0,
            character: CHARACTERS[0],
            color: PLAYER_COLORS[0],
            ready: true,
            isHost: true,
        });

        this.phase = 'lobby'; // 'lobby' | 'game' | 'results'
        this.gameState = null;
        this._tickInterval = null;
        this._onGameOver = onGameOver; // callback for rating updates
        /** Pending move commands received between ticks */
        this._pendingMoves = new Map();
    }

    // ─── Lobby Management ────────────────────────────────────────────────────

    /**
     * Add a player to the room.
     * @param {string} socketId
     * @param {string} nickname
     * @returns {{ success: boolean, error?: string }}
     */
    addPlayer(socketId, nickname, userId = null, rating = 1000) {
        if (this.phase !== 'lobby') return { success: false, error: 'Game already in progress' };
        if (this.players.size >= MAX_PLAYERS) return { success: false, error: 'Room is full' };
        if ([...this.players.values()].some(p => p.nickname === nickname)) {
            nickname = nickname + Math.floor(Math.random() * 100);
        }

        const slotIndex = this._nextFreeSlot();
        this.players.set(socketId, {
            id: socketId,
            nickname,
            userId,
            rating,
            slotIndex,
            character: CHARACTERS[slotIndex],
            color: PLAYER_COLORS[slotIndex],
            ready: false,
            isHost: false,
        });
        return { success: true };
    }

    /** Get the next free slot index. */
    _nextFreeSlot() {
        const usedSlots = new Set([...this.players.values()].map(p => p.slotIndex));
        for (let i = 0; i < MAX_PLAYERS; i++) {
            if (!usedSlots.has(i)) return i;
        }
        return this.players.size;
    }

    /**
     * Remove a player (disconnect or voluntary leave).
     * @param {string} socketId
     * @returns {{ wasHost: boolean, empty: boolean }}
     */
    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (!player) return { wasHost: false, empty: false };

        this.players.delete(socketId);
        this._pendingMoves.delete(socketId);

        const empty = this.players.size === 0;
        let wasHost = player.isHost;

        if (!empty && wasHost && this.phase === 'lobby') {
            // Promote the first remaining player to host
            const newHost = this.players.values().next().value;
            newHost.isHost = true;
            this.hostId = newHost.id;
        }

        if (this.phase === 'game' && this.gameState) {
            const gp = this.gameState.players.get(socketId);
            if (gp) gp.alive = false;
            this._checkGamePause();
        }

        return { wasHost, empty };
    }

    /** If fewer than 2 players alive after a disconnect, end the game. */
    _checkGamePause() {
        const alivePlayers = [...this.gameState.players.values()].filter(p => p.alive).length;
        if (alivePlayers < MIN_PLAYERS_TO_START) {
            const remaining = [...this.gameState.players.values()].find(p => p.alive);
            this.gameState.gameOver = true;
            this.gameState.winnerId = remaining ? remaining.id : null;
        }
    }

    /**
     * Toggle ready status for a player.
     * @param {string} socketId
     */
    toggleReady(socketId) {
        const player = this.players.get(socketId);
        if (player) player.ready = !player.ready;
    }

    /**
     * Update character selection for a player.
     * @param {string} socketId
     * @param {string} character
     */
    selectCharacter(socketId, character) {
        const player = this.players.get(socketId);
        if (player && CHARACTERS.includes(character)) player.character = character;
    }

    /**
     * Attempt to start the game. Only host can call this.
     * @param {string} socketId
     * @returns {{ success: boolean, error?: string }}
     */
    startGame(socketId) {
        if (socketId !== this.hostId) return { success: false, error: 'Only host can start' };
        if (this.players.size < MIN_PLAYERS_TO_START) {
            return { success: false, error: 'Need at least 2 players' };
        }
        const notReady = [...this.players.values()].filter(p => !p.isHost && !p.ready);
        if (notReady.length > 0) return { success: false, error: 'All players must be ready' };

        this.phase = 'game';
        const mapSeed = Math.floor(Math.random() * 0xFFFFFF);

        // Sort players by slotIndex so their positions match slot order
        const playerIds = [...this.players.values()]
            .sort((a, b) => a.slotIndex - b.slotIndex)
            .map(p => p.id);

        this.gameState = new GameState(mapSeed, playerIds);
        this._startTickLoop();

        return { success: true, mapSeed, playerIds };
    }

    // ─── Game Loop ────────────────────────────────────────────────────────────

    /** Start the 60 Hz tick loop. */
    _startTickLoop() {
        this._tickInterval = setInterval(() => this._tick(), TICK_MS);
    }

    /** Stop the tick loop. */
    _stopTickLoop() {
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
    }

    /**
     * One game tick: apply moves, advance state, broadcast updates.
     */
    _tick() {
        if (!this.gameState) return;

        const events = this.gameState.tick(this._pendingMoves);
        this._pendingMoves.clear();

        const serialized = this.gameState.serialize();

        // Broadcast state update
        this.io.to(this.code).emit('game_state_update', serialized);

        // Emit discrete events
        for (const explosion of events.explosions) {
            this.io.to(this.code).emit('explosion', explosion);
        }
        for (const elim of events.eliminated) {
            this.io.to(this.code).emit('player_eliminated', elim);
        }
        for (const pu of events.powerupCollections) {
            this.io.to(this.code).emit('power_up_collected', pu);
        }

        if (this.gameState.gameOver) {
            this._stopTickLoop();
            this.phase = 'results';
            const scoreboard = this._buildScoreboard();
            this.io.to(this.code).emit('game_over', {
                winnerId: this.gameState.winnerId,
                scoreboard,
            });
            // Update ELO ratings in MongoDB
            if (this._onGameOver) {
                this._onGameOver(this.gameState.winnerId, this).catch(() => {});
            }
        }
    }

    /**
     * Queue a move update from a player (processed on next tick).
     * @param {string} socketId
     * @param {{ dx: number, dy: number }} move
     */
    queueMove(socketId, move) {
        if (!this.gameState || !this.gameState.players.has(socketId)) return;
        this._pendingMoves.set(socketId, {
            dx: Math.sign(move.dx || 0),
            dy: Math.sign(move.dy || 0),
        });
    }

    /**
     * Place a bomb for a player.
     * @param {string} socketId
     * @returns {Object|null}
     */
    placeBomb(socketId) {
        if (!this.gameState) return null;
        return this.gameState.placeBomb(socketId);
    }

    /**
     * Detonate remote bomb for a player.
     * Explosions, eliminations, and powerup collections triggered here are
     * emitted immediately (same as the tick loop) so clients receive the
     * 'explosion' socket event — and therefore play the sound — for remote
     * detonations too.
     * @param {string} socketId
     */
    detonateRemote(socketId) {
        if (!this.gameState) return;
        const events = { explosions: [], eliminated: [], powerupCollections: [] };
        this.gameState.detonateRemote(socketId, events);

        // Emit explosion events immediately (same path as the tick loop)
        for (const explosion of events.explosions) {
            this.io.to(this.code).emit('explosion', explosion);
        }
        for (const elim of events.eliminated) {
            this.io.to(this.code).emit('player_eliminated', elim);
        }
        for (const pu of events.powerupCollections) {
            this.io.to(this.code).emit('power_up_collected', pu);
        }
        // The next game_state_update tick will reconcile the authoritative state
        // (removed bomb, new fires, destroyed soft blocks, etc.)
    }


    // ─── Serialization ────────────────────────────────────────────────────────

    /** Build the final scoreboard. */
    _buildScoreboard() {
        if (!this.gameState) return [];
        return [...this.gameState.players.values()].map(gp => {
            const lobbyPlayer = this.players.get(gp.id) || {};
            return {
                id: gp.id,
                nickname: lobbyPlayer.nickname || 'Unknown',
                slotIndex: gp.slotIndex,
                color: lobbyPlayer.color,
                kills: gp.kills,
                bombsPlaced: gp.bombsPlaced,
                powerupsCollected: gp.powerupsCollected,
                survivalTime: Math.round(gp.survivalTicks / 60),
                won: gp.id === this.gameState.winnerId,
            };
        });
    }

    /** Serialize lobby state for room_update broadcasts. */
    serializeLobby() {
        return {
            code: this.code,
            hostId: this.hostId,
            phase: this.phase,
            players: [...this.players.values()].map(p => ({
                id: p.id,
                nickname: p.nickname,
                rating: p.rating,
                slotIndex: p.slotIndex,
                character: p.character,
                color: p.color,
                ready: p.ready,
                isHost: p.isHost,
            })),
        };
    }
}

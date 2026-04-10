import { GameRoom } from '../src/GameRoom.js';

class MockSocketIO {
    to() {
        return this;
    }
    emit() {}
}

const mockIo = new MockSocketIO();

describe('GameRoom Integration', () => {
    let room;

    beforeEach(() => {
        room = new GameRoom('ROOM1', 'socket-host-1', 'HostGuy', mockIo);
    });

    it('should initialize with the host as the first player', () => {
        expect(room.players.size).toBe(1);
        expect(room.hostId).toBe('socket-host-1');
        const p1 = room.players.get('socket-host-1');
        expect(p1.isHost).toBe(true);
    });

    it('should allow adding new players up to MAX_PLAYERS', () => {
        const result = room.addPlayer('socket-2', 'PlayerTwo');
        expect(result.success).toBe(true);
        expect(room.players.size).toBe(2);

        room.addPlayer('socket-3', 'PlayerTwo');
        const p3 = room.players.get('socket-3');
        expect(p3.nickname).not.toBe('PlayerTwo');
    });

    it('should migrate host if the original host leaves in lobby', () => {
        room.addPlayer('socket-2', 'PlayerTwo');
        expect(room.hostId).toBe('socket-host-1');
        
        room.removePlayer('socket-host-1');
        expect(room.players.size).toBe(1);
        expect(room.hostId).toBe('socket-2');
        const nextHost = room.players.get('socket-2');
        expect(nextHost.isHost).toBe(true);
    });

    it('should prevent starting the game if not all players are ready', () => {
        room.addPlayer('socket-2', 'PlayerTwo');
        
        const p2 = room.players.get('socket-2');
        expect(p2.ready).toBe(false);

        const startAttempt = room.startGame('socket-host-1');
        expect(startAttempt.success).toBe(false);
        expect(startAttempt.error).toMatch(/All players must be ready/i);
    });

    it('should start properly when all players are ready', () => {
        room.addPlayer('socket-2', 'PlayerTwo');
        room.toggleReady('socket-2');

        const startAttempt = room.startGame('socket-host-1');
        expect(startAttempt.success).toBe(true);
        expect(room.phase).toBe('game');
        expect(room.gameState).not.toBeNull();
    });
});

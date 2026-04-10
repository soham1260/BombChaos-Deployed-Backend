import { GameState } from '../src/GameState.js';
import { MAX_PLAYERS, MIN_PLAYERS_TO_START, GRID_WIDTH, GRID_HEIGHT, TILE_SIZE, TILE } from '../src/constants.js';

describe('GameState Integration Test', () => {

    it('should initialize a valid grid and correct number of players', () => {
        const seed = 12345;
        const playerIds = ['player1', 'player2'];
        const gameState = new GameState(seed, playerIds);

        // Grid must be GRID_HEIGHT * GRID_WIDTH
        expect(gameState.grid.length).toBe(GRID_HEIGHT);
        expect(gameState.grid[0].length).toBe(GRID_WIDTH);

        // Players shouldn't be dead originally
        expect(gameState.players.size).toBe(2);
        const p1 = gameState.players.get('player1');
        expect(p1.alive).toBe(true);

        // Game should not be over
        expect(gameState.gameOver).toBe(false);
    });

    it('should allow player to place a bomb and tick countdown to detonation', () => {
        const seed = 12345;
        const playerIds = ['player1', 'player2'];
        const gameState = new GameState(seed, playerIds);

        const bomb = gameState.placeBomb('player1');
        expect(bomb).not.toBeNull();
        expect(gameState.bombs.size).toBe(1);

        const activeBomb = gameState.bombs.get(bomb.id);
        expect(activeBomb.ticksLeft).toBeGreaterThan(0);
        
        let initialTicks = activeBomb.ticksLeft;

        for(let i=0; i<10; i++) {
            gameState.tick(new Map());
        }

        expect(activeBomb.ticksLeft).toBe(initialTicks - 10);
    });

    it('should correctly move player when a valid direction is submitted', () => {
        const seed = 12345;
        const playerIds = ['player1', 'player2'];
        const gameState = new GameState(seed, playerIds);

        const p1 = gameState.players.get('player1');
        const initialX = p1.x;
        const initialY = p1.y;

        const playerMoves = new Map();
        // Force the player to move Right (+X)
        playerMoves.set('player1', { dx: 1, dy: 0 });

        // Let the game tick happen
        gameState.tick(playerMoves);

        // Verifying we moved to the right
        expect(p1.x).toBeGreaterThan(initialX);
        expect(p1.y).toBe(initialY); // Shouldn't have moved in Y
    });
});

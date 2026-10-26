import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface TableToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const SCENE_PROPERTY = {
  type: 'string',
  description:
    'Scene ID or exact name. Defaults to the active scene; any other scene can be prepared without activating it or showing it to players.',
};

const square = z.object({ column: z.number().int(), row: z.number().int() });
const sceneArg = z.string().min(1).optional();

/**
 * Argument schemas for each tool. Keys are tool names; each maps the
 * validated arguments to the Foundry query payload (scene -> sceneId).
 */
const SCHEMAS = {
  'token-hp': z.object({
    tokenId: z.string().min(1),
    mode: z.enum(['damage', 'heal', 'set']),
    amount: z.number().min(0),
    markDead: z.boolean().default(false),
    scene: sceneArg,
  }),
  combat: z.object({
    action: z.enum([
      'status',
      'start',
      'end',
      'add',
      'roll-npcs',
      'roll',
      'next-turn',
      'previous-turn',
      'next-round',
    ]),
    tokenIds: z.array(z.string().min(1)).optional(),
    allTokens: z.boolean().optional(),
    gmOnly: z.boolean().optional(),
    scene: sceneArg,
  }),
  'token-grid': z.object({
    action: z.enum(['report', 'distance', 'move']),
    tokenIds: z.array(z.string().min(1)).optional(),
    fromTokenId: z.string().optional(),
    toTokenId: z.string().optional(),
    tokenId: z.string().optional(),
    by: z.object({ columns: z.number().int(), rows: z.number().int() }).optional(),
    to: square.optional(),
    note: z.string().optional(),
    animate: z.boolean().optional(),
    ignoreWalls: z.boolean().optional(),
    scene: sceneArg,
  }),
  'scene-snapshot': z.object({
    maxSize: z.number().int().min(200).max(3000).default(1500),
    scene: sceneArg,
  }),
  'show-journal': z.object({
    journal: z.string().min(1),
    page: z.string().min(1).optional(),
    users: z.array(z.string().min(1)).optional(),
  }),
  doors: z.object({
    action: z.enum(['list', 'open', 'close', 'lock', 'unlock']),
    doorId: z.string().optional(),
    scene: sceneArg,
  }),
  'run-macro': z.object({
    macro: z.string().min(1),
    args: z.record(z.unknown()).optional(),
  }),
  'scene-sounds': z.object({
    action: z.enum(['list', 'toggle', 'on', 'off']),
    soundId: z.string().optional(),
    scene: sceneArg,
  }),
  'move-party': z.object({
    scene: z.string().min(1),
    note: z.string().min(1).optional(),
    to: square.optional(),
    actors: z.array(z.string().min(1)).optional(),
    activate: z.boolean().default(false),
  }),
  'preload-scene': z.object({ scene: z.string().min(1) }),
  'scene-navigation': z.object({
    action: z.enum(['list', 'set']),
    scenes: z.array(z.string().min(1)).optional(),
    navigation: z.boolean().optional(),
  }),
  'character-audit': z.object({ actor: z.string().min(1) }),
  'ddb-import': z.object({
    url: z.string().min(1),
    player: z.string().min(1).optional(),
    folder: z.string().min(1).optional(),
  }),
} as const;

type ToolName = keyof typeof SCHEMAS;

/** Tools that can take longer than the bridge's default 10 s query timeout. */
const TIMEOUTS: Partial<Record<ToolName, number>> = {
  'scene-snapshot': 60000,
  'move-party': 30000,
  'preload-scene': 60000,
  'run-macro': 30000,
  'character-audit': 30000,
  'ddb-import': 180000,
};

export class TableTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: TableToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'TableTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'token-hp',
        description:
          'Damage, heal or set HP on one token (dnd5e). Works on unlinked NPC tokens (each goblin separately) and linked PCs. Damage drains temp HP first; healing stops at max HP. Returns HP before and after. Set markDead to mark an NPC dead (and defeated in combat) when it reaches 0.',
        inputSchema: {
          type: 'object',
          properties: {
            tokenId: { type: 'string', description: 'Token ID' },
            mode: { type: 'string', enum: ['damage', 'heal', 'set'] },
            amount: { type: 'number', description: 'HP amount (for set: the new HP value)' },
            markDead: {
              type: 'boolean',
              description: 'Mark an NPC dead when it drops to 0 HP (default false)',
            },
            scene: SCENE_PROPERTY,
          },
          required: ['tokenId', 'mode', 'amount'],
        },
      },
      {
        name: 'combat',
        description:
          'Run combat on a scene. Actions: status (turn order and whose turn it is), start (creates the encounter, adds tokenIds/allTokens, starts round 1), add, roll-npcs (rolls initiative for NPCs only; players roll their own from the tracker), roll (initiative for specific tokens), next-turn, previous-turn, next-round, end. Every action returns the turn order, current turn and which players still need to roll.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'status',
                'start',
                'end',
                'add',
                'roll-npcs',
                'roll',
                'next-turn',
                'previous-turn',
                'next-round',
              ],
            },
            tokenIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tokens to add (start/add) or roll for (roll)',
            },
            allTokens: { type: 'boolean', description: 'Add every token on the scene' },
            gmOnly: {
              type: 'boolean',
              description: 'Roll initiative privately to the GM (roll-npcs/roll)',
            },
            scene: SCENE_PROPERTY,
          },
          required: ['action'],
        },
      },
      {
        name: 'token-grid',
        description:
          "Token positions in grid terms, using the scene's own grid settings. Actions: report (each token's column/row, size and grid info), distance (between two tokens' centers, in scene units, using the scene's diagonal rule), move (a token by columns/rows, to a column/row, or to a named map note; reports blocked if a wall stops it).",
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['report', 'distance', 'move'] },
            tokenIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'report: limit to these tokens',
            },
            fromTokenId: { type: 'string', description: 'distance: first token' },
            toTokenId: { type: 'string', description: 'distance: second token' },
            tokenId: { type: 'string', description: 'move: token to move' },
            by: {
              type: 'object',
              properties: { columns: { type: 'number' }, rows: { type: 'number' } },
              description:
                'move: relative squares (columns right, rows down; negative for left/up)',
            },
            to: {
              type: 'object',
              properties: { column: { type: 'number' }, row: { type: 'number' } },
              description: 'move: target square',
            },
            note: { type: 'string', description: 'move: name of a map note to move to' },
            animate: { type: 'boolean', description: 'move: animate (default true)' },
            ignoreWalls: {
              type: 'boolean',
              description:
                'move: place the token even if walls are in the way (GM teleport). Without it, a move that walls stop returns blocked: true.',
            },
            scene: SCENE_PROPERTY,
          },
          required: ['action'],
        },
      },
      {
        name: 'scene-snapshot',
        description:
          "Render a scene as the GM sees it (all tokens, no player fog) to a PNG image. Hidden tokens are outlined in red and labelled HIDDEN. For a scene the GM isn't viewing, the GM's own view switches to it briefly and back; players are not moved and see nothing.",
        inputSchema: {
          type: 'object',
          properties: {
            maxSize: {
              type: 'number',
              description: 'Longest side in pixels (200-3000, default 1500)',
            },
            scene: SCENE_PROPERTY,
          },
        },
      },
      {
        name: 'show-journal',
        description:
          "Pop up a journal entry, or one page of it (text or image), on players' screens. Works even for journals the players don't own. Omit users to show it to all players.",
        inputSchema: {
          type: 'object',
          properties: {
            journal: { type: 'string', description: 'Journal entry ID or name' },
            page: { type: 'string', description: 'Page ID or name (optional)' },
            users: {
              type: 'array',
              items: { type: 'string' },
              description: 'Player names or their character names (optional)',
            },
          },
          required: ['journal'],
        },
      },
      {
        name: 'doors',
        description:
          'List the doors on a scene (ID, type, position, grid square, nearest map note, state), or open/close/lock/unlock one by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'open', 'close', 'lock', 'unlock'] },
            doorId: { type: 'string', description: 'Door (wall) ID, for everything except list' },
            scene: SCENE_PROPERTY,
          },
          required: ['action'],
        },
      },
      {
        name: 'run-macro',
        description:
          'Run a world macro by name or ID, executed by the GM. Script macros receive args as their scope. Returns the macro result when it can be serialized.',
        inputSchema: {
          type: 'object',
          properties: {
            macro: { type: 'string', description: 'Macro ID or name' },
            args: { type: 'object', description: 'Values passed to the macro scope (optional)' },
          },
          required: ['macro'],
        },
      },
      {
        name: 'scene-sounds',
        description:
          "List a scene's ambient sounds (ID, file, on/off, radius, volume, position, nearest note), or turn one on, off, or toggle it.",
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'toggle', 'on', 'off'] },
            soundId: {
              type: 'string',
              description: 'Ambient sound ID, for everything except list',
            },
            scene: SCENE_PROPERTY,
          },
          required: ['action'],
        },
      },
      {
        name: 'move-party',
        description:
          "Place the player characters' tokens on a scene around a named map note or grid square, moving their existing tokens there (past walls, and made visible) or creating tokens if they have none on it. Defaults to every character assigned to a player. Optionally activate the scene afterwards (players are moved to it only then).",
        inputSchema: {
          type: 'object',
          properties: {
            scene: { type: 'string', description: 'Target scene ID or name' },
            note: { type: 'string', description: 'Map note to gather around' },
            to: {
              type: 'object',
              properties: { column: { type: 'number' }, row: { type: 'number' } },
              description: 'Grid square to gather around (instead of note)',
            },
            actors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Actor IDs or names (default: characters assigned to players)',
            },
            activate: {
              type: 'boolean',
              description: 'Activate the scene afterwards (default false)',
            },
          },
          required: ['scene'],
        },
      },
      {
        name: 'scene-navigation',
        description:
          "Scene navigation bar: list (the scenes that have navigation on, and which players' bars can show them) or set (turn navigation on or off for named scenes). Only IDs and names are returned, never scene contents.",
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'set'] },
            scenes: {
              type: 'array',
              items: { type: 'string' },
              description: 'set: scene IDs or exact names',
            },
            navigation: { type: 'boolean', description: 'set: true to show, false to hide' },
          },
          required: ['action'],
        },
      },
      {
        name: 'preload-scene',
        description:
          "Make every connected player's browser preload a scene's assets without activating it or showing it, so a later switch is instant.",
        inputSchema: {
          type: 'object',
          properties: { scene: { type: 'string', description: 'Scene ID or name' } },
          required: ['scene'],
        },
      },
      {
        name: 'character-audit',
        description:
          'Audit a dnd5e actor: every feature, spell and item with its activities (attack/save/damage/heal), uses and recovery, active effects, and automation coverage from Midi-QOL, DAE, Automated Animations, premade-automation modules and so on. Flags anything broken or description-only, and lists which automation modules are installed and active.',
        inputSchema: {
          type: 'object',
          properties: { actor: { type: 'string', description: 'Actor ID or name' } },
          required: ['actor'],
        },
      },
      {
        name: 'ddb-import',
        description:
          'Import a D&D Beyond character into Foundry through the DDB-Importer module, from its character URL. Re-importing a character that was imported before updates that actor instead of creating a new one. Optionally gives a named player owner permission.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description:
                'D&D Beyond character URL, e.g. https://www.dndbeyond.com/characters/12345678',
            },
            player: { type: 'string', description: 'Player to make owner (optional)' },
            folder: {
              type: 'string',
              description: 'Actor folder name for a new import (optional)',
            },
          },
          required: ['url'],
        },
      },
    ];
  }

  handles(name: string): name is ToolName {
    return Object.prototype.hasOwnProperty.call(SCHEMAS, name);
  }

  async handle(name: ToolName, args: any): Promise<any> {
    const { scene, ...rest } = SCHEMAS[name].parse(args ?? {}) as Record<string, unknown>;
    const payload = scene === undefined ? rest : { ...rest, sceneId: scene };
    this.logger.info(`Running ${name}`, payload);
    try {
      const timeoutMs = TIMEOUTS[name];
      return await this.foundryClient.query(
        `foundry-mcp-bridge.${name}`,
        payload,
        timeoutMs ? { timeoutMs } : undefined
      );
    } catch (error) {
      this.logger.error(`${name} failed`, error);
      throw new Error(
        `${name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

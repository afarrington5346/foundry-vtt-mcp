import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface ChatToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class ChatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: ChatToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ChatTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'post-chat',
        description:
          'Post a message to Foundry chat under a speaker alias such as "Narrator", "GM", or an NPC name. If the alias exactly matches a world actor, the message is linked to that actor (portrait shown). Text is posted as plain text; blank lines start new paragraphs. Optionally whisper it to specific players instead of posting publicly.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message text' },
            speaker: {
              type: 'string',
              description: 'Name shown as the speaker, e.g. "Narrator", "GM", "Barkeep Mira"',
            },
            whisperTo: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Player names (or their assigned character names) to whisper to. Omit for a public message.',
            },
          },
          required: ['message', 'speaker'],
        },
      },
      {
        name: 'read-chat',
        description:
          'Read Foundry chat messages in log order, with speaker, user, text, flavor, whisper recipients and roll results. Pass sinceMessageId (use lastMessageId from a previous call) or sinceTimestamp to get only newer messages; with neither, returns the most recent messages.',
        inputSchema: {
          type: 'object',
          properties: {
            sinceMessageId: {
              type: 'string',
              description: 'Return messages posted after this message id',
            },
            sinceTimestamp: {
              type: ['number', 'string'],
              description:
                'Return messages posted after this time: milliseconds since epoch, or an ISO 8601 date-time',
            },
            limit: {
              type: 'number',
              description: 'Maximum messages to return (1-200, default 50)',
            },
          },
        },
      },
      {
        name: 'roll-dice',
        description:
          'Roll a dice formula with Foundry\'s own Roll and post it to chat as a named speaker (e.g. "Goblin"), with normal dice rendering. If the speaker exactly matches a world actor, the roll is linked to that actor and can use its roll data (e.g. "1d20 + @abilities.dex.mod"). Returns the total and each die\'s results.',
        inputSchema: {
          type: 'object',
          properties: {
            formula: { type: 'string', description: 'Dice formula, e.g. "1d20+4" or "2d6kh1"' },
            speaker: {
              type: 'string',
              description: 'Name shown as the roller, e.g. "Goblin", "Rovnig", "GM"',
            },
            flavor: {
              type: 'string',
              description: 'Label shown above the roll, e.g. "Stealth check"',
            },
            mode: {
              type: 'string',
              enum: ['public', 'gm-only', 'self'],
              description:
                'public: everyone sees it (default). gm-only: blind roll, only GMs see it. self: only the rolling user sees it.',
            },
          },
          required: ['formula', 'speaker'],
        },
      },
    ];
  }

  async handleRollDice(args: any): Promise<any> {
    const schema = z.object({
      formula: z.string().min(1),
      speaker: z.string().min(1),
      flavor: z.string().optional(),
      mode: z.enum(['public', 'gm-only', 'self']).default('public'),
    });
    const parsed = schema.parse(args);

    this.logger.info('Rolling dice', {
      formula: parsed.formula,
      speaker: parsed.speaker,
      mode: parsed.mode,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.roll-dice', parsed);
    } catch (error) {
      this.logger.error('Failed to roll dice', error);
      throw new Error(
        `Failed to roll dice: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handlePostChat(args: any): Promise<any> {
    const schema = z.object({
      message: z.string().min(1),
      speaker: z.string().min(1),
      whisperTo: z.array(z.string().min(1)).optional(),
    });
    const parsed = schema.parse(args);

    this.logger.info('Posting chat message', {
      speaker: parsed.speaker,
      whisperTo: parsed.whisperTo,
    });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.post-chat', parsed);
    } catch (error) {
      this.logger.error('Failed to post chat message', error);
      throw new Error(
        `Failed to post chat message: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleReadChat(args: any): Promise<any> {
    const schema = z.object({
      sinceMessageId: z.string().min(1).optional(),
      sinceTimestamp: z.union([z.number(), z.string().min(1)]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    });
    const parsed = schema.parse(args ?? {});

    let sinceTimestamp: number | undefined;
    if (parsed.sinceTimestamp !== undefined) {
      sinceTimestamp =
        typeof parsed.sinceTimestamp === 'number'
          ? parsed.sinceTimestamp
          : Date.parse(parsed.sinceTimestamp);
      if (Number.isNaN(sinceTimestamp)) {
        throw new Error(`sinceTimestamp is not a valid date: ${parsed.sinceTimestamp}`);
      }
    }

    try {
      return await this.foundryClient.query('foundry-mcp-bridge.read-chat', {
        sinceMessageId: parsed.sinceMessageId,
        sinceTimestamp,
        limit: parsed.limit,
      });
    } catch (error) {
      this.logger.error('Failed to read chat', error);
      throw new Error(
        `Failed to read chat: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

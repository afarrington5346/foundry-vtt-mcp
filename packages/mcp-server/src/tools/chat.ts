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
    ];
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

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface TokenManipulationToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const SCENE_PROPERTY = {
  type: 'string',
  description:
    'Scene ID or exact name. Defaults to the active scene; any other scene can be edited without activating it or showing it to players.',
};

export class TokenManipulationTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: TokenManipulationToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'TokenManipulationTools' });
  }

  /**
   * Tool definitions for token manipulation operations
   */
  getToolDefinitions() {
    return [
      {
        name: 'move-token',
        description:
          'Move a token to a new position on a scene (the active scene unless `scene` is given). Can optionally animate the movement.',
        inputSchema: {
          type: 'object',
          properties: {
            tokenId: {
              type: 'string',
              description: 'The ID of the token to move',
            },
            scene: SCENE_PROPERTY,
            x: {
              type: 'number',
              description: 'The new X coordinate (in pixels)',
            },
            y: {
              type: 'number',
              description: 'The new Y coordinate (in pixels)',
            },
            animate: {
              type: 'boolean',
              description: 'Whether to animate the movement (default: false)',
              default: false,
            },
          },
          required: ['tokenId', 'x', 'y'],
        },
      },
      {
        name: 'update-token',
        description:
          'Update various properties of a token such as visibility, disposition, size, rotation, elevation, name, or the light it gives off (a lit torch or lamp)',
        inputSchema: {
          type: 'object',
          properties: {
            tokenId: {
              type: 'string',
              description: 'The ID of the token to update',
            },
            scene: SCENE_PROPERTY,
            updates: {
              type: 'object',
              description: 'Object containing the properties to update',
              properties: {
                x: {
                  type: 'number',
                  description: 'New X coordinate',
                },
                y: {
                  type: 'number',
                  description: 'New Y coordinate',
                },
                width: {
                  type: 'number',
                  description: 'New width in grid units',
                },
                height: {
                  type: 'number',
                  description: 'New height in grid units',
                },
                rotation: {
                  type: 'number',
                  description: 'New rotation in degrees (0-360)',
                },
                hidden: {
                  type: 'boolean',
                  description: 'Whether the token is hidden from players',
                },
                disposition: {
                  type: 'number',
                  description: 'Token disposition: -1 (hostile), 0 (neutral), 1 (friendly)',
                  enum: [-1, 0, 1],
                },
                name: {
                  type: 'string',
                  description: 'New display name for the token',
                },
                elevation: {
                  type: 'number',
                  description: 'Elevation in distance units',
                },
                lockRotation: {
                  type: 'boolean',
                  description: 'Whether to lock the rotation',
                },
                light: {
                  type: 'object',
                  description:
                    'Light the token emits, in scene units. Torch: bright 20, dim 40. Hooded lantern: bright 30, dim 60. Candle: bright 5, dim 10. Light off: bright 0, dim 0.',
                  properties: {
                    bright: { type: 'number' },
                    dim: { type: 'number' },
                    color: { type: 'string', description: 'Optional hex colour, e.g. "#ff9b40"' },
                  },
                },
              },
            },
          },
          required: ['tokenId', 'updates'],
        },
      },
      {
        name: 'delete-tokens',
        description:
          'Delete one or more tokens from a scene (the active scene unless `scene` is given)',
        inputSchema: {
          type: 'object',
          properties: {
            tokenIds: {
              type: 'array',
              description: 'Array of token IDs to delete',
              items: {
                type: 'string',
              },
              minItems: 1,
            },
            scene: SCENE_PROPERTY,
          },
          required: ['tokenIds'],
        },
      },
      {
        name: 'get-token-details',
        description:
          'Get detailed information about a specific token including all properties and linked actor data',
        inputSchema: {
          type: 'object',
          properties: {
            tokenId: {
              type: 'string',
              description: 'The ID of the token to get details for',
            },
            scene: SCENE_PROPERTY,
          },
          required: ['tokenId'],
        },
      },
      {
        name: 'toggle-token-condition',
        description:
          'Toggle a status effect/condition on or off for a token. Use this to apply or remove conditions like Prone, Poisoned, Blinded, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            tokenId: {
              type: 'string',
              description: 'The ID of the token to modify',
            },
            scene: SCENE_PROPERTY,
            conditionId: {
              type: 'string',
              description:
                'The ID of the condition/status effect to toggle (e.g., "prone", "poisoned", "blinded")',
            },
            active: {
              type: 'boolean',
              description:
                'Optional: true to add the condition, false to remove it. If not specified, will toggle the current state.',
            },
          },
          required: ['tokenId', 'conditionId'],
        },
      },
      {
        name: 'get-available-conditions',
        description:
          'Get a list of all available status effects/conditions that can be applied to tokens in the current game system',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleMoveToken(args: any): Promise<any> {
    const schema = z.object({
      tokenId: z.string(),
      x: z.number(),
      y: z.number(),
      animate: z.boolean().optional().default(false),
      scene: z.string().min(1).optional(),
    });

    const { tokenId, x, y, animate, scene } = schema.parse(args);

    this.logger.info('Moving token', { tokenId, x, y, animate });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.move-token', {
        tokenId,
        x,
        y,
        animate,
        sceneId: scene,
      });

      this.logger.debug('Token moved successfully', { tokenId });

      return {
        success: true,
        tokenId,
        newPosition: { x, y },
        animated: animate,
      };
    } catch (error) {
      this.logger.error('Failed to move token', error);
      throw new Error(
        `Failed to move token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleUpdateToken(args: any): Promise<any> {
    const schema = z.object({
      tokenId: z.string(),
      updates: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotation: z.number().min(0).max(360).optional(),
        hidden: z.boolean().optional(),
        disposition: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
        name: z.string().optional(),
        elevation: z.number().optional(),
        lockRotation: z.boolean().optional(),
        light: z
          .object({
            bright: z.number().min(0).optional(),
            dim: z.number().min(0).optional(),
            color: z.string().optional(),
          })
          .optional(),
      }),
      scene: z.string().min(1).optional(),
    });

    const { tokenId, updates, scene } = schema.parse(args);

    this.logger.info('Updating token', { tokenId, updates });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.update-token', {
        tokenId,
        updates,
        sceneId: scene,
      });

      this.logger.debug('Token updated successfully', { tokenId, result });

      return {
        success: true,
        tokenId,
        updated: true,
        appliedUpdates: updates,
      };
    } catch (error) {
      this.logger.error('Failed to update token', error);
      throw new Error(
        `Failed to update token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleDeleteTokens(args: any): Promise<any> {
    const schema = z.object({
      tokenIds: z.array(z.string()).min(1),
      scene: z.string().min(1).optional(),
    });

    const { tokenIds, scene } = schema.parse(args);

    this.logger.info('Deleting tokens', { count: tokenIds.length, tokenIds });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.delete-tokens', {
        tokenIds,
        sceneId: scene,
      });

      this.logger.debug('Tokens deleted successfully', {
        deleted: result.deletedCount,
        requested: tokenIds.length,
      });

      return {
        success: result.success,
        deletedCount: result.deletedCount,
        tokenIds: result.tokenIds,
        errors: result.errors,
      };
    } catch (error) {
      this.logger.error('Failed to delete tokens', error);
      throw new Error(
        `Failed to delete tokens: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleGetTokenDetails(args: any): Promise<any> {
    const schema = z.object({
      tokenId: z.string(),
      scene: z.string().min(1).optional(),
    });

    const { tokenId, scene } = schema.parse(args);

    this.logger.info('Getting token details', { tokenId });

    try {
      const tokenData = await this.foundryClient.query('foundry-mcp-bridge.get-token-details', {
        tokenId,
        sceneId: scene,
      });

      this.logger.debug('Retrieved token details', {
        tokenId,
        hasActorData: !!tokenData.actorData,
      });

      return this.formatTokenDetails(tokenData);
    } catch (error) {
      this.logger.error('Failed to get token details', error);
      throw new Error(
        `Failed to get token details: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private formatTokenDetails(tokenData: any): any {
    return {
      id: tokenData.id,
      name: tokenData.name,
      position: {
        x: tokenData.x,
        y: tokenData.y,
      },
      size: {
        width: tokenData.width,
        height: tokenData.height,
      },
      appearance: {
        rotation: tokenData.rotation,
        scale: tokenData.scale,
        alpha: tokenData.alpha,
        hidden: tokenData.hidden,
        img: tokenData.img,
      },
      behavior: {
        disposition: this.getDispositionName(tokenData.disposition),
        elevation: tokenData.elevation,
        lockRotation: tokenData.lockRotation,
      },
      actor: tokenData.actorData
        ? {
            id: tokenData.actorId,
            name: tokenData.actorData.name,
            type: tokenData.actorData.type,
            img: tokenData.actorData.img,
            isLinked: tokenData.actorLink,
          }
        : null,
    };
  }

  private getDispositionName(disposition: number): string {
    switch (disposition) {
      case -1:
        return 'hostile';
      case 0:
        return 'neutral';
      case 1:
        return 'friendly';
      default:
        return 'unknown';
    }
  }

  async handleToggleTokenCondition(args: any): Promise<any> {
    const schema = z.object({
      tokenId: z.string(),
      conditionId: z.string(),
      active: z.boolean().optional(),
      scene: z.string().min(1).optional(),
    });

    const { tokenId, conditionId, active, scene } = schema.parse(args);

    this.logger.info('Toggling token condition', { tokenId, conditionId, active });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.toggle-token-condition', {
        tokenId,
        conditionId,
        active,
        sceneId: scene,
      });

      this.logger.debug('Token condition toggled successfully', { tokenId, conditionId, result });

      return {
        success: true,
        tokenId,
        conditionId,
        isActive: result.isActive,
        conditionName: result.conditionName,
      };
    } catch (error) {
      this.logger.error('Failed to toggle token condition', error);
      throw new Error(
        `Failed to toggle token condition: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleGetAvailableConditions(args: any): Promise<any> {
    this.logger.info('Getting available conditions');

    try {
      const result = await this.foundryClient.query(
        'foundry-mcp-bridge.get-available-conditions',
        {}
      );

      this.logger.debug('Retrieved available conditions', { count: result.conditions?.length });

      return {
        success: true,
        conditions: result.conditions,
        gameSystem: result.gameSystem,
      };
    } catch (error) {
      this.logger.error('Failed to get available conditions', error);
      throw new Error(
        `Failed to get available conditions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

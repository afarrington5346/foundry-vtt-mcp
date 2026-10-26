import { FoundryDataAccess } from './data-access.js';

/**
 * Game-table tools added in v0.8.6: token HP, combat, grid positions, scene
 * snapshots, journal hand-outs, doors, macros, ambient sounds, party moves and
 * scene preloading. Every scene-dependent tool takes an optional scene id or
 * name and defaults to the active scene, so a scene can be prepared without
 * activating it.
 */

const DOOR_STATES = ['closed', 'open', 'locked'] as const;
const DOOR_TYPES: Record<number, string> = { 1: 'door', 2: 'secret' };

/** Wait for the browser and Foundry's ticker; works in background tabs, where rAF stalls. */
async function settle(ms = 120): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
  const app = (canvas as any)?.app;
  try {
    app?.ticker?.update(performance.now());
  } catch {
    // The ticker throws if the canvas is mid-teardown; the caller renders explicitly.
  }
}

function findByIdOrName<T extends { id: string; name?: string | null }>(
  collection: Iterable<T>,
  ref: string,
  kind: string
): T {
  const items = Array.from<any>(collection);
  const lower = ref.toLowerCase().trim();
  const found =
    items.find(d => d.id === ref) ??
    items.find(d => d.name?.toLowerCase() === lower) ??
    (() => {
      const partial = items.filter(d => d.name?.toLowerCase().includes(lower));
      return partial.length === 1 ? partial[0] : undefined;
    })();
  if (!found) throw new Error(`${kind} not found: "${ref}"`);
  return found;
}

export class TableTools {
  constructor(private dataAccess: FoundryDataAccess) {}

  // ===== shared helpers =====

  private scene(sceneId?: string): any {
    this.dataAccess.validateFoundryState();
    return this.dataAccess.resolveTargetScene(sceneId);
  }

  private token(scene: any, tokenId: string): any {
    const token = scene.tokens.get(tokenId);
    if (!token) throw new Error(`Token ${tokenId} not found in scene "${scene.name}"`);
    return token;
  }

  private gridInfo(scene: any): any {
    const g = scene.grid;
    return {
      type: g.isGridless ? 'gridless' : g.isHexagonal ? 'hex' : 'square',
      size: g.size,
      distance: g.distance,
      units: g.units,
    };
  }

  /** Grid square (column/row) containing a point, or null on a gridless scene. */
  private square(
    scene: any,
    point: { x: number; y: number }
  ): { column: number; row: number } | null {
    const g = scene.grid;
    if (g.isGridless) return null;
    const { i, j } = g.getOffset(point);
    return { column: j, row: i };
  }

  private tokenCenter(scene: any, token: any): { x: number; y: number } {
    const g = scene.grid;
    return {
      x: token.x + (token.width * (g.sizeX ?? g.size)) / 2,
      y: token.y + (token.height * (g.sizeY ?? g.size)) / 2,
    };
  }

  private distance(scene: any, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const d = scene.grid.measurePath([a, b]).distance;
    return Math.round(d * 100) / 100;
  }

  private noteName(note: any): string {
    return note.text || note.page?.name || note.entry?.name || '(unnamed note)';
  }

  private findNote(scene: any, name: string): any {
    const lower = name.toLowerCase().trim();
    const notes = Array.from<any>(scene.notes);
    const exact = notes.filter(n => this.noteName(n).toLowerCase() === lower);
    const matches = exact.length
      ? exact
      : notes.filter(n => this.noteName(n).toLowerCase().includes(lower));
    if (matches.length === 0) {
      const known = notes.map(n => this.noteName(n)).join(', ') || 'none';
      throw new Error(`No map note named "${name}" on "${scene.name}". Notes: ${known}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `"${name}" matches several notes: ${matches.map(n => this.noteName(n)).join(', ')}`
      );
    }
    return matches[0];
  }

  private nearestNote(scene: any, point: { x: number; y: number }): any {
    let best: any = null;
    for (const note of scene.notes) {
      const d = this.distance(scene, point, { x: note.x, y: note.y });
      if (!best || d < best.distance) best = { name: this.noteName(note), distance: d };
    }
    return best ? { name: best.name, distance: best.distance, units: scene.grid.units } : null;
  }

  /** Top-left pixel position that puts a token in a grid square. */
  private topLeftFor(
    scene: any,
    square: { column: number; row: number }
  ): { x: number; y: number } {
    const p = scene.grid.getTopLeftPoint({ i: square.row, j: square.column });
    return { x: p.x, y: p.y };
  }

  private resolveUsers(names: string[]): any[] {
    const users = Array.from<any>((game.users as any)?.values() ?? []);
    const result: any[] = [];
    for (const target of names) {
      const term = target.toLowerCase().trim();
      const user =
        users.find(u => u.name?.toLowerCase() === term) ??
        users.find(u => !u.isGM && u.character?.name?.toLowerCase() === term);
      if (!user) {
        const known = users.map(u => u.name).join(', ');
        throw new Error(`No player or assigned character named "${target}". Players: ${known}`);
      }
      if (!result.includes(user)) result.push(user);
    }
    return result;
  }

  // ===== token-hp =====

  async tokenHp(options: {
    tokenId: string;
    sceneId?: string;
    mode: 'damage' | 'heal' | 'set';
    amount: number;
    markDead?: boolean;
  }): Promise<any> {
    const scene = this.scene(options.sceneId);
    const token = this.token(scene, options.tokenId);
    const actor = token.actor;
    if (!actor) throw new Error(`Token ${token.name} has no actor`);
    const hp = actor.system?.attributes?.hp;
    if (!hp || typeof hp.value !== 'number') {
      throw new Error(
        `${token.name} has no system.attributes.hp (only dnd5e-style HP is supported)`
      );
    }

    const snapshot = () => ({
      value: actor.system.attributes.hp.value,
      temp: actor.system.attributes.hp.temp ?? 0,
      max: actor.system.attributes.hp.max,
    });
    const before = snapshot();
    const effectiveMax = (hp.max ?? 0) + (hp.tempmax ?? 0);
    const amount = Math.max(0, Math.floor(options.amount));

    let value = before.value;
    let temp = before.temp;
    if (options.mode === 'damage') {
      const absorbed = Math.min(temp, amount);
      temp -= absorbed;
      value = Math.max(0, value - (amount - absorbed));
    } else if (options.mode === 'heal') {
      value = Math.max(value, Math.min(effectiveMax, value + amount));
    } else {
      value = Math.min(effectiveMax, amount);
    }

    const update: Record<string, number> = { 'system.attributes.hp.value': value };
    if (temp !== before.temp) update['system.attributes.hp.temp'] = temp;
    await actor.update(update);

    let markedDead = false;
    if (options.markDead && value === 0 && actor.type === 'npc') {
      await actor.toggleStatusEffect('dead', { active: true, overlay: true });
      for (const combat of game.combats ?? []) {
        const combatant = (combat as any).combatants.find(
          (c: any) => c.tokenId === token.id && c.sceneId === scene.id
        );
        if (combatant) await combatant.update({ defeated: true });
      }
      markedDead = true;
    }

    return {
      success: true,
      scene: scene.name,
      tokenId: token.id,
      name: token.name,
      actorType: actor.type,
      linked: token.actorLink,
      mode: options.mode,
      amount,
      before,
      after: snapshot(),
      markedDead,
    };
  }

  // ===== combat =====

  private findCombat(scene: any): any {
    const combats = (game.combats?.contents ?? []).filter((c: any) => c.scene?.id === scene.id);
    return combats.find((c: any) => c.active) ?? combats[0] ?? null;
  }

  private combatStatus(scene: any, combat: any): any {
    if (!combat) return { scene: scene.name, inCombat: false };
    const current = combat.combatant;
    return {
      scene: scene.name,
      inCombat: true,
      combatId: combat.id,
      started: combat.started,
      round: combat.round,
      turn: combat.turn,
      currentTurn: current
        ? { combatantId: current.id, name: current.name, tokenId: current.tokenId }
        : null,
      order: combat.turns.map((c: any, index: number) => ({
        index,
        combatantId: c.id,
        name: c.name,
        tokenId: c.tokenId,
        initiative: c.initiative,
        isPC: c.hasPlayerOwner,
        hidden: c.hidden,
        defeated: c.isDefeated,
        current: current?.id === c.id,
      })),
      awaitingPlayerRolls: combat.turns
        .filter((c: any) => c.hasPlayerOwner && c.initiative === null)
        .map((c: any) => c.name),
    };
  }

  private async addCombatants(
    scene: any,
    combat: any,
    tokenIds?: string[],
    all?: boolean
  ): Promise<string[]> {
    const tokens: any[] = all
      ? Array.from<any>(scene.tokens)
      : (tokenIds ?? []).map(id => this.token(scene, id));
    const existing = new Set(combat.combatants.map((c: any) => c.tokenId));
    const data = tokens
      .filter(t => !existing.has(t.id))
      .map(t => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden }));
    if (data.length) await combat.createEmbeddedDocuments('Combatant', data);
    return data.map(d => d.tokenId);
  }

  async combat(options: {
    action:
      | 'status'
      | 'start'
      | 'end'
      | 'add'
      | 'roll-npcs'
      | 'roll'
      | 'next-turn'
      | 'previous-turn'
      | 'next-round';
    sceneId?: string;
    tokenIds?: string[];
    allTokens?: boolean;
    gmOnly?: boolean;
  }): Promise<any> {
    const scene = this.scene(options.sceneId);
    let combat = this.findCombat(scene);
    const rollMode = options.gmOnly ? 'gmroll' : 'publicroll';
    const extra: Record<string, unknown> = {};

    const requireCombat = () => {
      if (!combat) throw new Error(`No combat on "${scene.name}". Use action "start" first.`);
    };

    switch (options.action) {
      case 'status':
        break;
      case 'start': {
        if (!combat) {
          const Combat = getDocumentClass('Combat') as any;
          combat = await Combat.create({ scene: scene.id, active: true });
          extra.created = true;
        }
        extra.added = await this.addCombatants(scene, combat, options.tokenIds, options.allTokens);
        if (!combat.started) await combat.startCombat();
        break;
      }
      case 'end': {
        requireCombat();
        // Combat#endCombat asks for confirmation in a dialog; deleting is what it does after.
        await combat.delete();
        return { success: true, scene: scene.name, ended: true, inCombat: false };
      }
      case 'add':
        requireCombat();
        if (!options.tokenIds?.length && !options.allTokens) {
          throw new Error('Give tokenIds or set allTokens');
        }
        extra.added = await this.addCombatants(scene, combat, options.tokenIds, options.allTokens);
        break;
      case 'roll-npcs':
        requireCombat();
        await combat.rollNPC({ messageOptions: { rollMode } });
        break;
      case 'roll': {
        requireCombat();
        if (!options.tokenIds?.length) throw new Error('Give tokenIds to roll for');
        const ids = options.tokenIds.map(tokenId => {
          const c = combat.combatants.find((x: any) => x.tokenId === tokenId);
          if (!c) throw new Error(`Token ${tokenId} is not in the combat`);
          return c.id;
        });
        await combat.rollInitiative(ids, { messageOptions: { rollMode } });
        break;
      }
      case 'next-turn':
        requireCombat();
        await combat.nextTurn();
        break;
      case 'previous-turn':
        requireCombat();
        await combat.previousTurn();
        break;
      case 'next-round':
        requireCombat();
        await combat.nextRound();
        break;
      default:
        throw new Error(`Unknown combat action: ${String(options.action)}`);
    }

    return { success: true, action: options.action, ...extra, ...this.combatStatus(scene, combat) };
  }

  // ===== token-grid =====

  private tokenGridInfo(scene: any, token: any): any {
    return {
      tokenId: token.id,
      name: token.name,
      square: this.square(scene, { x: token.x, y: token.y }),
      size: { width: token.width, height: token.height },
      hidden: token.hidden,
      position: { x: token.x, y: token.y },
    };
  }

  async tokenGrid(options: {
    action: 'report' | 'distance' | 'move';
    sceneId?: string;
    tokenIds?: string[];
    fromTokenId?: string;
    toTokenId?: string;
    tokenId?: string;
    by?: { columns: number; rows: number };
    to?: { column: number; row: number };
    note?: string;
    animate?: boolean;
    ignoreWalls?: boolean;
  }): Promise<any> {
    const scene = this.scene(options.sceneId);
    const grid = this.gridInfo(scene);

    if (options.action === 'report') {
      const tokens: any[] = options.tokenIds?.length
        ? options.tokenIds.map(id => this.token(scene, id))
        : Array.from<any>(scene.tokens);
      return {
        success: true,
        scene: scene.name,
        grid,
        tokens: tokens.map(t => this.tokenGridInfo(scene, t)),
      };
    }

    if (options.action === 'distance') {
      if (!options.fromTokenId || !options.toTokenId) {
        throw new Error('distance needs fromTokenId and toTokenId');
      }
      const a = this.token(scene, options.fromTokenId);
      const b = this.token(scene, options.toTokenId);
      return {
        success: true,
        scene: scene.name,
        grid,
        from: this.tokenGridInfo(scene, a),
        to: this.tokenGridInfo(scene, b),
        distance: this.distance(scene, this.tokenCenter(scene, a), this.tokenCenter(scene, b)),
        units: grid.units,
        measuredBetween: 'token centers, using the scene grid and its diagonal rule',
      };
    }

    if (options.action === 'move') {
      if (!options.tokenId) throw new Error('move needs tokenId');
      const token = this.token(scene, options.tokenId);
      const before = this.tokenGridInfo(scene, token);
      let target: { x: number; y: number };

      if (options.note) {
        const note = this.findNote(scene, options.note);
        const sq = this.square(scene, { x: note.x, y: note.y });
        target = sq
          ? this.topLeftFor(scene, sq)
          : {
              x: note.x - (token.width * grid.size) / 2,
              y: note.y - (token.height * grid.size) / 2,
            };
      } else if (options.to || options.by) {
        if (!before.square) throw new Error('Grid moves need a gridded scene; use note instead');
        const sq = options.to ?? {
          column: before.square.column + (options.by?.columns ?? 0),
          row: before.square.row + (options.by?.rows ?? 0),
        };
        target = this.topLeftFor(scene, sq);
      } else {
        throw new Error('move needs one of: by, to, note');
      }

      const d = scene.dimensions;
      const r = d.sceneRect;
      if (
        target.x < r.x ||
        target.y < r.y ||
        target.x >= r.x + r.width ||
        target.y >= r.y + r.height
      ) {
        throw new Error('That square is outside the scene map');
      }
      const reached = await this.placeToken(token, target, {
        animate: options.animate !== false,
        ignoreWalls: !!options.ignoreWalls,
      });
      const after = this.tokenGridInfo(scene, token);
      if (!reached) {
        return {
          success: false,
          blocked: true,
          scene: scene.name,
          grid,
          before,
          after,
          target: { square: this.square(scene, target), position: target },
          message:
            'Foundry stopped the move at a wall, so the token did not reach the target. Use ignoreWalls to place it there anyway.',
        };
      }
      return { success: true, scene: scene.name, grid, before, after };
    }

    throw new Error(`Unknown token-grid action: ${String(options.action)}`);
  }

  /**
   * Move a token to a top-left position. Foundry v13 runs position updates
   * through wall-constrained movement, so check where it ended up. With
   * ignoreWalls the token is displaced (teleported) instead.
   */
  private async placeToken(
    token: any,
    target: { x: number; y: number },
    options: { animate: boolean; ignoreWalls: boolean }
  ): Promise<boolean> {
    if (options.ignoreWalls) {
      try {
        if (typeof token.move !== 'function') throw new Error('no TokenDocument#move');
        await token.move([{ x: target.x, y: target.y, action: 'displace' }], { animate: false });
      } catch {
        await token.update(target, { animate: false, teleport: true });
      }
    } else {
      await token.update(target, { animate: options.animate });
    }
    return token.x === target.x && token.y === target.y;
  }

  // ===== scene-snapshot =====

  async sceneSnapshot(options: { sceneId?: string; maxSize?: number }): Promise<any> {
    const scene = this.scene(options.sceneId);
    const c: any = canvas;
    if (!c?.ready && !c?.scene) throw new Error('The GM canvas is not available');
    const maxSize = Math.min(3000, Math.max(200, Math.round(options.maxSize ?? 1500)));

    const originalScene = c.scene;
    const originalView = c.stage
      ? { x: c.stage.pivot.x, y: c.stage.pivot.y, scale: c.stage.scale.x }
      : null;
    const switched = originalScene?.id !== scene.id;
    if (switched) {
      // Only the GM's own view changes; players stay on their scene.
      await scene.view();
      await settle(400);
    }

    const controlled: string[] = c.tokens.controlled.map((t: any) => t.id);
    try {
      c.tokens.releaseAll();
      const rect = c.dimensions.sceneRect;
      const renderer = c.app.renderer;
      const res = renderer.resolution ?? 1;

      // Output pixels per scene pixel. The browser window is usually smaller than
      // that, so the scene is rendered at this zoom in screen-sized tiles.
      const k = Math.min(1, maxSize / Math.max(rect.width, rect.height));
      const width = Math.max(1, Math.round(rect.width * k));
      const height = Math.max(1, Math.round(rect.height * k));
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('Could not create a 2D canvas');
      ctx.imageSmoothingQuality = 'high';

      const [sw, sh] = c.screenDimensions;
      const zoom = k / res;
      c.pan({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scale: zoom });
      await settle(150);
      // Foundry may clamp the zoom; size tiles from the zoom it actually applied.
      const applied = c.stage.scale.x;
      const tileW = Math.max(50, Math.floor((sw * 0.9) / applied));
      const tileH = Math.max(50, Math.floor((sh * 0.9) / applied));
      let tiles = 0;
      for (let ty = rect.y; ty < rect.y + rect.height; ty += tileH) {
        for (let tx = rect.x; tx < rect.x + rect.width; tx += tileW) {
          const tw = Math.min(tileW, rect.x + rect.width - tx);
          const th = Math.min(tileH, rect.y + rect.height - ty);
          c.pan({ x: tx + tw / 2, y: ty + th / 2, scale: zoom });
          await settle(150);
          await settle(100);
          renderer.render(c.app.stage);
          const frame: HTMLCanvasElement = renderer.extract.canvas();
          const wt = c.stage.worldTransform;
          const a = wt.apply(new PIXI.Point(tx, ty));
          const b = wt.apply(new PIXI.Point(tx + tw, ty + th));
          const sx = Math.max(0, a.x * res);
          const sy = Math.max(0, a.y * res);
          const ex = Math.min(frame.width, b.x * res);
          const ey = Math.min(frame.height, b.y * res);
          if (ex <= sx || ey <= sy) continue;
          // Map whatever part of the tile is on screen back to scene space.
          const wx0 = tx + ((sx - a.x * res) / ((b.x - a.x) * res)) * tw;
          const wy0 = ty + ((sy - a.y * res) / ((b.y - a.y) * res)) * th;
          const wx1 = tx + ((ex - a.x * res) / ((b.x - a.x) * res)) * tw;
          const wy1 = ty + ((ey - a.y * res) / ((b.y - a.y) * res)) * th;
          ctx.drawImage(
            frame,
            sx,
            sy,
            ex - sx,
            ey - sy,
            (wx0 - rect.x) * k,
            (wy0 - rect.y) * k,
            (wx1 - wx0) * k,
            (wy1 - wy0) * k
          );
          tiles++;
        }
      }
      if (!tiles) throw new Error('Scene is not on screen; could not capture it');

      // Mark hidden tokens on the finished image, so it doesn't depend on canvas layers.
      const hiddenTokens: string[] = [];
      for (const t of c.tokens.placeables) {
        if (!t.document.hidden) continue;
        hiddenTokens.push(t.document.name);
        const x = (t.document.x - rect.x) * k;
        const y = (t.document.y - rect.y) * k;
        const w = t.w * k;
        const h = t.h * k;
        const line = Math.max(2, Math.round(Math.min(w, h) * 0.06));
        ctx.fillStyle = 'rgba(255, 23, 68, 0.18)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#ff1744';
        ctx.lineWidth = line;
        ctx.strokeRect(x + line / 2, y + line / 2, w - line, h - line);
        const font = Math.max(10, Math.min(18, Math.round(w * 0.3)));
        ctx.font = `bold ${font}px Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const labelY = y > font + 4 ? y - 2 : y + h + font + 2;
        const tw = ctx.measureText('HIDDEN').width;
        ctx.fillStyle = '#b00020';
        ctx.fillRect(x + w / 2 - tw / 2 - 3, labelY - font - 1, tw + 6, font + 3);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('HIDDEN', x + w / 2, labelY + 1);
      }

      // Keep the PNG under ~4.5 MB of base64 so MCP clients accept it.
      let image = out;
      let dataUrl = image.toDataURL('image/png');
      for (let attempt = 0; attempt < 5 && dataUrl.length >= 4_500_000; attempt++) {
        const smaller = document.createElement('canvas');
        smaller.width = Math.round(image.width * 0.8);
        smaller.height = Math.round(image.height * 0.8);
        smaller.getContext('2d')?.drawImage(image, 0, 0, smaller.width, smaller.height);
        image = smaller;
        dataUrl = image.toDataURL('image/png');
      }

      return {
        success: true,
        scene: scene.name,
        sceneId: scene.id,
        active: scene.active,
        width: image.width,
        height: image.height,
        tiles,
        hiddenTokens,
        note: hiddenTokens.length
          ? 'Hidden tokens are outlined in red and labelled HIDDEN.'
          : undefined,
        __image: { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' },
      };
    } finally {
      if (switched && originalScene) {
        await originalScene.view();
      } else {
        if (originalView) c.pan(originalView);
        for (const id of controlled) c.tokens.get(id)?.control({ releaseOthers: false });
      }
    }
  }

  // ===== show-journal =====

  async showJournal(options: { journal: string; page?: string; users?: string[] }): Promise<any> {
    this.dataAccess.validateFoundryState();
    const entry: any = findByIdOrName(game.journal as any, options.journal, 'Journal entry');
    const page: any = options.page
      ? findByIdOrName(entry.pages, options.page, `Page in "${entry.name}"`)
      : null;
    const users = options.users?.length ? this.resolveUsers(options.users) : [];
    const g: any = globalThis;
    const Journal = g.foundry?.documents?.collections?.Journal ?? g.Journal;
    // force shows it even to players without permission to the entry.
    await Journal.show(page ?? entry, { force: true, users: users.map(u => u.id) });

    const players = (game.users?.contents ?? []).filter((u: any) => !u.isGM);
    const targets = users.length ? users : players;
    return {
      success: true,
      journal: entry.name,
      page: page?.name ?? null,
      pageType: page?.type ?? null,
      shownTo: users.length ? users.map(u => u.name) : 'all players',
      offline: targets.filter((u: any) => !u.active).map((u: any) => u.name),
    };
  }

  // ===== doors =====

  async doors(options: {
    action: 'list' | 'open' | 'close' | 'lock' | 'unlock';
    sceneId?: string;
    doorId?: string;
  }): Promise<any> {
    const scene = this.scene(options.sceneId);
    const describe = (w: any) => {
      const [x1, y1, x2, y2] = w.c;
      const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      return {
        doorId: w.id,
        type: DOOR_TYPES[w.door] ?? 'door',
        state: DOOR_STATES[w.ds] ?? String(w.ds),
        position: { x: Math.round(mid.x), y: Math.round(mid.y) },
        square: this.square(scene, mid),
        nearestNote: this.nearestNote(scene, mid),
      };
    };

    if (options.action === 'list') {
      const doors = Array.from<any>(scene.walls).filter(w => w.door > 0);
      return { success: true, scene: scene.name, count: doors.length, doors: doors.map(describe) };
    }

    if (!options.doorId) throw new Error(`${options.action} needs doorId`);
    const wall = scene.walls.get(options.doorId);
    if (!wall || !(wall.door > 0)) throw new Error(`No door ${options.doorId} on "${scene.name}"`);
    const states: Record<string, number> = { open: 1, close: 0, lock: 2, unlock: 0 };
    const ds = states[options.action];
    if (ds === undefined) throw new Error(`Unknown doors action: ${String(options.action)}`);
    if (options.action === 'unlock' && wall.ds !== 2) {
      return { success: true, scene: scene.name, changed: false, door: describe(wall) };
    }
    const before = DOOR_STATES[wall.ds];
    if (wall.ds !== ds) await wall.update({ ds });
    return {
      success: true,
      scene: scene.name,
      changed: before !== DOOR_STATES[ds],
      before,
      door: describe(wall),
    };
  }

  // ===== run-macro =====

  async runMacro(options: { macro: string; args?: Record<string, unknown> }): Promise<any> {
    this.dataAccess.validateFoundryState();
    const macro: any = findByIdOrName(game.macros as any, options.macro, 'Macro');
    if (!macro.canExecute) throw new Error(`The GM cannot execute macro "${macro.name}"`);
    const result = await macro.execute(options.args ?? {});

    let value: unknown = null;
    if (result?.documentName) {
      value = { documentName: result.documentName, id: result.id, name: result.name ?? null };
    } else if (result !== undefined) {
      try {
        value = JSON.parse(JSON.stringify(result));
      } catch {
        value = String(result);
      }
    }
    return { success: true, macro: macro.name, macroId: macro.id, type: macro.type, result: value };
  }

  // ===== scene-sounds =====

  async sceneSounds(options: {
    action: 'list' | 'toggle' | 'on' | 'off';
    sceneId?: string;
    soundId?: string;
  }): Promise<any> {
    const scene = this.scene(options.sceneId);
    const describe = (s: any) => ({
      soundId: s.id,
      file: decodeURIComponent(
        String(s.path ?? '')
          .split('/')
          .pop() ?? ''
      ),
      path: s.path,
      on: !s.hidden,
      radius: s.radius,
      volume: s.volume,
      position: { x: s.x, y: s.y },
      square: this.square(scene, { x: s.x, y: s.y }),
      nearestNote: this.nearestNote(scene, { x: s.x, y: s.y }),
    });

    if (options.action === 'list') {
      const sounds = Array.from<any>(scene.sounds);
      return {
        success: true,
        scene: scene.name,
        count: sounds.length,
        sounds: sounds.map(describe),
      };
    }

    if (!options.soundId) throw new Error(`${options.action} needs soundId`);
    const sound = scene.sounds.get(options.soundId);
    if (!sound) throw new Error(`No ambient sound ${options.soundId} on "${scene.name}"`);
    const wasOn = !sound.hidden;
    const on = options.action === 'toggle' ? !wasOn : options.action === 'on';
    if (on !== wasOn) await sound.update({ hidden: !on });
    return { success: true, scene: scene.name, changed: on !== wasOn, sound: describe(sound) };
  }

  // ===== move-party =====

  async moveParty(options: {
    sceneId: string;
    note?: string;
    to?: { column: number; row: number };
    actors?: string[];
    activate?: boolean;
  }): Promise<any> {
    const scene = this.scene(options.sceneId);
    const g = scene.grid;

    const party: any[] = options.actors?.length
      ? options.actors.map(ref => findByIdOrName(game.actors as any, ref, 'Actor'))
      : ((game.users?.contents ?? []) as any[])
          .filter(u => !u.isGM && u.character)
          .map(u => u.character)
          .filter((a, i, all) => all.indexOf(a) === i);
    if (!party.length) {
      throw new Error('No player characters are assigned to users; pass actors explicitly');
    }

    let origin: { column: number; row: number };
    if (options.note) {
      const note = this.findNote(scene, options.note);
      const sq = this.square(scene, { x: note.x, y: note.y });
      if (!sq) throw new Error('move-party needs a gridded scene');
      origin = sq;
    } else if (options.to) {
      origin = options.to;
    } else {
      throw new Error('move-party needs note or to');
    }

    // Squares already taken by tokens that are not part of the party.
    const partyIds = new Set(party.map(a => a.id));
    const occupied = new Set<string>();
    for (const t of scene.tokens) {
      if (t.actorLink && partyIds.has(t.actorId)) continue;
      const sq = this.square(scene, { x: t.x, y: t.y });
      if (!sq) continue;
      for (let dc = 0; dc < Math.max(1, Math.round(t.width)); dc++) {
        for (let dr = 0; dr < Math.max(1, Math.round(t.height)); dr++) {
          occupied.add(`${sq.column + dc},${sq.row + dr}`);
        }
      }
    }
    const rect = scene.dimensions.sceneRect;
    const inside = (sq: { column: number; row: number }) => {
      const p = this.topLeftFor(scene, sq);
      return (
        p.x >= rect.x && p.y >= rect.y && p.x < rect.x + rect.width && p.y < rect.y + rect.height
      );
    };
    const free: { column: number; row: number }[] = [];
    for (let ring = 0; ring <= 4 && free.length < party.length; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const sq = { column: origin.column + dc, row: origin.row + dr };
          if (!occupied.has(`${sq.column},${sq.row}`) && inside(sq)) free.push(sq);
        }
      }
    }
    if (free.length < party.length) throw new Error('Not enough free squares near the target');

    const placed: any[] = [];
    for (const [index, actor] of party.entries()) {
      const sq = free[index];
      const position = this.topLeftFor(scene, sq);
      const existing = Array.from<any>(scene.tokens).find(
        t => t.actorLink && t.actorId === actor.id
      );
      if (existing) {
        // The party arrives from elsewhere: teleport past walls, and make sure players can see it.
        const wasHidden = existing.hidden;
        if (wasHidden) await existing.update({ hidden: false });
        const reached = await this.placeToken(existing, position, {
          animate: false,
          ignoreWalls: true,
        });
        placed.push({
          actor: actor.name,
          tokenId: existing.id,
          created: false,
          square: sq,
          ...(wasHidden ? { unhidden: true } : {}),
          ...(reached
            ? {}
            : { warning: 'did not reach the square', square: this.square(scene, existing) }),
        });
      } else {
        const tokenDoc = await actor.getTokenDocument({ ...position, hidden: false });
        const [created] = await scene.createEmbeddedDocuments('Token', [tokenDoc.toObject()]);
        placed.push({ actor: actor.name, tokenId: created.id, created: true, square: sq });
      }
    }

    if (options.activate) await scene.activate();
    return {
      success: true,
      scene: scene.name,
      grid: { size: g.size, distance: g.distance, units: g.units },
      placed,
      activated: !!options.activate,
      active: scene.active,
    };
  }

  // ===== scene-navigation =====

  /**
   * List the scenes shown in the navigation bar, or turn navigation on/off for
   * named scenes. Only ids, names and visibility are returned; scene contents
   * are never read.
   */
  async sceneNavigation(options: {
    action: 'list' | 'set';
    scenes?: string[];
    navigation?: boolean;
  }): Promise<any> {
    this.dataAccess.validateFoundryState();
    const players = Array.from<any>(game.users ?? []).filter(u => !u.isGM);
    const describe = (s: any) => ({
      sceneId: s.id,
      name: s.name,
      navigation: s.navigation,
      active: s.active,
      // A player's bar lists a navigation scene only if they can see it (Limited or better).
      inPlayerBars: s.navigation
        ? players.filter(u => s.testUserPermission(u, 'LIMITED')).map(u => u.name)
        : [],
    });

    if (options.action === 'list') {
      const shown = Array.from<any>(game.scenes ?? []).filter(s => s.navigation);
      return { success: true, count: shown.length, scenes: shown.map(describe) };
    }

    if (options.action !== 'set') {
      throw new Error(`Unknown scene-navigation action: ${String(options.action)}`);
    }
    if (!options.scenes?.length) throw new Error('set needs scenes');
    if (typeof options.navigation !== 'boolean')
      throw new Error('set needs navigation: true or false');
    // Resolve every name first, so one typo changes nothing.
    const targets = options.scenes.map(ref => this.dataAccess.resolveTargetScene(ref));
    const changed: string[] = [];
    for (const scene of targets) {
      if (scene.navigation !== options.navigation) {
        await scene.update({ navigation: options.navigation });
        changed.push(scene.name);
      }
    }
    return {
      success: true,
      navigation: options.navigation,
      changed,
      unchanged: targets.filter(s => !changed.includes(s.name)).map(s => s.name),
      scenes: targets.map(describe),
    };
  }

  // ===== preload-scene =====

  async preloadScene(options: { sceneId: string }): Promise<any> {
    const scene = this.scene(options.sceneId);
    // push=true asks every connected client to preload it; nothing is shown to players.
    await (game.scenes as any).preload(scene.id, true);
    return {
      success: true,
      scene: scene.name,
      sceneId: scene.id,
      active: scene.active,
      preloadedFor: ((game.users?.contents ?? []) as any[]).filter(u => u.active).map(u => u.name),
    };
  }
}

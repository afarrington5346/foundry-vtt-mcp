import { FoundryDataAccess } from './data-access.js';

/**
 * Character tools added in v0.8.6: an audit of whether an actor's features,
 * spells and items will work at the table (dnd5e 5.x activities), and
 * D&D Beyond import through the DDB-Importer module.
 */

/** Automation and animation modules the audit reports on. */
const AUTOMATION_MODULES: Record<string, string> = {
  'midi-qol': 'Midi-QOL',
  dae: 'DAE (Dynamic Active Effects)',
  'times-up': 'Times Up',
  autoanimations: 'Automated Animations',
  sequencer: 'Sequencer',
  JB2A_DnD5e: 'JB2A (free)',
  jb2a_patreon: 'JB2A (Patreon)',
  'automated-conditions-5e': 'Automated Conditions 5e',
  'chris-premades': "Cauldron of Plentiful Resources (Chris's Premades)",
  'gambits-premades': "Gambit's Premades",
  'dice-so-nice': 'Dice So Nice!',
  'ddb-importer': 'DDB Importer',
};

/** Item types that are containers for other data, not things you use at the table. */
const STRUCTURAL_TYPES = new Set(['class', 'subclass', 'background', 'race', 'species']);
/** Item types whose value is passive (worn, carried) unless they have activities. */
const PASSIVE_TYPES = new Set(['equipment', 'loot', 'container', 'backpack', 'tool']);

/** Consumable subtypes that are used up without an activity of their own. */
const PASSIVE_CONSUMABLES = new Set(['ammo', 'food', 'trinket']);

/** Activity types that roll or apply something on their own. */
const ACTING_ACTIVITIES = new Set([
  'attack',
  'save',
  'damage',
  'heal',
  'check',
  'summon',
  'enchant',
  'cast',
  'transform',
]);

function moduleState(id: string): { installed: boolean; active: boolean; version: string | null } {
  const mod: any = game.modules?.get(id);
  return { installed: !!mod, active: !!mod?.active, version: mod?.version ?? null };
}

export class CharacterTools {
  constructor(private dataAccess: FoundryDataAccess) {}

  private findActor(ref: string): any {
    const actors = Array.from<any>((game.actors as any) ?? []);
    const lower = ref.toLowerCase().trim();
    const actor =
      actors.find(a => a.id === ref) ??
      actors.find(a => a.name?.toLowerCase() === lower) ??
      (() => {
        const partial = actors.filter(a => a.name?.toLowerCase().includes(lower));
        if (partial.length > 1) {
          throw new Error(
            `"${ref}" matches several actors: ${partial.map(a => a.name).join(', ')}`
          );
        }
        return partial[0];
      })();
    if (!actor) throw new Error(`Actor not found: "${ref}"`);
    return actor;
  }

  /** Automated Animations autorec entries (world settings), keyed by menu. Best effort across AA versions. */
  private autorecLabels(): { label: string; exact: boolean; menu: string }[] {
    const out: { label: string; exact: boolean; menu: string }[] = [];
    if (!moduleState('autoanimations').active) return out;
    const settings: any = (game.settings as any).settings;
    for (const [key] of settings.entries()) {
      if (!key.startsWith('autoanimations.aaAutorec')) continue;
      let value: any;
      try {
        value = game.settings.get('autoanimations' as any, key.split('.')[1]);
      } catch {
        continue;
      }
      const entries = Array.isArray(value) ? value : Object.values(value ?? {});
      for (const entry of entries) {
        if (entry?.label) {
          out.push({
            label: String(entry.label),
            exact: !!entry.advanced?.exactMatch,
            menu: key.split('-').pop() ?? key,
          });
        }
      }
    }
    return out;
  }

  private summarizeActivity(
    item: any,
    activity: any,
    actor: any
  ): { summary: any; issues: string[]; warnings: string[] } {
    const issues: string[] = [];
    const warnings: string[] = [];
    const type = activity.type;
    const parts: any[] = activity.damage?.parts ?? [];
    const formulas = parts.map(p => p.formula ?? '').filter(Boolean);
    const baseDamage =
      type === 'attack' && activity.damage?.includeBase && item.system?.damage?.base?.formula
        ? item.system.damage.base.formula
        : null;
    // dnd5e prepares attack parts with the weapon's base damage already added, so
    // the extra parts are only the ones saved on the activity (the last N prepared).
    const stored =
      item._source?.system?.activities?.[activity.id]?.damage?.parts ??
      activity._source?.damage?.parts;
    const extraFormulas = Array.isArray(stored)
      ? formulas.slice(Math.max(0, formulas.length - stored.length))
      : formulas;
    const healing = type === 'heal' ? activity.healing?.formula || null : null;
    const effects = (activity.effects ?? [])
      .map((e: any) => e.effect?.name ?? e._id)
      .filter(Boolean);

    const rollData = actor.getRollData?.() ?? {};
    for (const f of [...formulas, baseDamage, healing].filter(Boolean) as string[]) {
      try {
        const resolved = Roll.replaceFormulaData(f, rollData, { missing: '0' } as any);
        if (!Roll.validate(resolved)) issues.push(`invalid formula "${f}"`);
      } catch {
        issues.push(`invalid formula "${f}"`);
      }
    }

    if (type === 'attack' && !formulas.length && !baseDamage) issues.push('attack has no damage');
    if (type === 'damage' && !formulas.length) issues.push('damage activity has no damage parts');
    if (type === 'heal' && !healing) issues.push('heal activity has no healing formula');
    if (type === 'save') {
      const abilities = activity.save?.ability;
      const hasAbility = abilities instanceof Set ? abilities.size > 0 : !!abilities?.length;
      if (!hasAbility) issues.push('save activity has no save ability');
      if (!formulas.length && !effects.length) {
        warnings.push(
          'save applies no damage and no effect (fine if the result is handled by hand)'
        );
      }
    }

    // Consumption targets must point at something that exists.
    for (const target of activity.consumption?.targets ?? []) {
      if (target.type === 'itemUses') {
        const other = target.target ? actor.items.get(target.target) : item;
        if (!other) issues.push('consumes uses of an item that is not on the actor');
        else if (!other.system?.uses?.max)
          issues.push(`consumes uses of "${other.name}", which has no uses`);
      } else if (target.type === 'activityUses' && !activity.uses?.max) {
        issues.push('consumes its own uses but has no use limit');
      } else if (target.type === 'attribute' && target.target) {
        const value = foundry.utils.getProperty(actor.system, target.target);
        if (value === undefined) issues.push(`consumes missing attribute "${target.target}"`);
      }
    }

    const uses = activity.uses?.max
      ? {
          max: activity.uses.max,
          spent: activity.uses.spent ?? 0,
          recovery: (activity.uses.recovery ?? []).map((r: any) => r.period),
        }
      : null;
    if (uses && !uses.recovery.length) warnings.push('activity uses never recover');
    if (baseDamage && extraFormulas.includes(baseDamage)) {
      warnings.push(
        `extra damage "${baseDamage}" repeats the base damage; if attacks roll it twice, remove the extra part`
      );
    }

    return {
      summary: {
        name: activity.name || type,
        type,
        attack:
          type === 'attack'
            ? `${activity.attack?.type?.value ?? ''} ${activity.attack?.type?.classification ?? ''}`.trim()
            : undefined,
        save: type === 'save' ? Array.from<any>(activity.save?.ability ?? []).join('/') : undefined,
        baseDamage: baseDamage ?? undefined,
        extraDamage: extraFormulas.length ? extraFormulas : undefined,
        healing: healing ?? undefined,
        effects: effects.length ? effects : undefined,
        activation: activity.activation?.type || undefined,
        uses: uses ?? undefined,
      },
      issues,
      warnings,
    };
  }

  /**
   * Import (or re-import) a D&D Beyond character through DDB-Importer's API.
   * An actor already flagged with the same D&D Beyond id is updated in place.
   */
  async ddbImport(options: { url: string; player?: string; folder?: string }): Promise<any> {
    this.dataAccess.validateFoundryState();
    const mod: any = game.modules?.get('ddb-importer');
    if (!mod?.active || !mod.api) throw new Error('The DDB Importer module is not active');
    const api = mod.api;

    const characterId: string | null =
      api.lib?.DDBCharacter?.getCharacterId?.(options.url) ??
      options.url.match(/(?:dndbeyond\.com|ddb\.ac)(?:\/profile\/.+)?\/characters\/(\d+)/)?.[1] ??
      null;
    if (!characterId) throw new Error(`Not a D&D Beyond character URL: ${options.url}`);

    // Resolve the player and folder before importing, so a typo fails without side effects.
    const users = Array.from<any>((game.users as any) ?? []);
    let owner: any = null;
    if (options.player) {
      const term = options.player.toLowerCase().trim();
      owner =
        users.find(u => u.name?.toLowerCase() === term) ??
        users.find(u => !u.isGM && u.character?.name?.toLowerCase() === term);
      if (!owner) {
        throw new Error(
          `No player named "${options.player}". Players: ${users.map(u => u.name).join(', ')}`
        );
      }
    }
    let folderId: string | null = null;
    if (options.folder) {
      const folder = Array.from<any>((game.folders as any) ?? []).find(
        f => f.type === 'Actor' && f.name?.toLowerCase() === options.folder!.toLowerCase()
      );
      if (!folder) throw new Error(`No Actor folder named "${options.folder}"`);
      folderId = folder.id;
    }

    const byDdbId = (a: any) =>
      String(a.flags?.ddbimporter?.dndbeyond?.characterId ?? '') === characterId;
    const existing = Array.from<any>((game.actors as any) ?? []).find(byDdbId) ?? null;
    const before = new Set((game.actors as any).map((a: any) => a.id));

    const messages: string[] = [];
    const notifier = (title: any, props?: { message?: string; isError?: boolean }) => {
      const text = [typeof title === 'string' ? title : '', props?.message ?? '']
        .filter(Boolean)
        .join(': ');
      if (text) messages.push(props?.isError ? `ERROR ${text}` : text);
    };

    let ok: boolean;
    let actor: any;
    if (existing) {
      // An earlier interactive import may have saved "ask which resources", which opens a blocking dialog.
      await existing.update({ 'flags.ddbimporter.resources.ask': false });
      ok = await api.importCharacter({ actor: existing, notifier });
      actor = existing;
    } else {
      ok = await api.importCharacterById(characterId, notifier, folderId);
      actor = Array.from<any>((game.actors as any) ?? []).find(
        a => !before.has(a.id) && byDdbId(a)
      );
    }

    if (!ok) {
      return {
        success: false,
        characterId,
        updatedExisting: !!existing,
        leftoverActor:
          !existing && actor
            ? { id: actor.id, name: actor.name, note: 'created by the failed import; not deleted' }
            : undefined,
        messages: messages.slice(-10),
        hint: 'DDB Importer returned false. A private character needs your Cobalt cookie set in DDB Importer in this GM browser.',
      };
    }

    if (owner && actor) {
      await actor.update({
        [`ownership.${owner.id}`]: (CONST as any).DOCUMENT_OWNERSHIP_LEVELS.OWNER,
      });
    }

    return {
      success: true,
      characterId,
      updatedExisting: !!existing,
      actorId: actor?.id ?? null,
      name: actor?.name ?? null,
      owner: owner?.name ?? null,
      ownerAssignedCharacter: owner ? (owner.character?.name ?? null) : undefined,
      ddbImporterVersion: mod.version,
      messages: messages.slice(-10),
    };
  }

  async characterAudit(options: { actor: string }): Promise<any> {
    this.dataAccess.validateFoundryState();
    if (game.system.id !== 'dnd5e')
      throw new Error('character-audit supports the dnd5e system only');
    const actor = this.findActor(options.actor);

    const modules = Object.fromEntries(
      Object.entries(AUTOMATION_MODULES).map(([id, label]) => [id, { label, ...moduleState(id) }])
    );
    const midi = modules['midi-qol'].active;
    const autorec = this.autorecLabels();

    const results = Array.from<any>(actor.items).map(item => {
      const issues: string[] = [];
      const warnings: string[] = [];
      const activities: any[] = [];
      for (const activity of item.system?.activities ?? []) {
        const {
          summary,
          issues: activityIssues,
          warnings: activityWarnings,
        } = this.summarizeActivity(item, activity, actor);
        activities.push(summary);
        issues.push(...activityIssues.map(i => `${summary.name}: ${i}`));
        warnings.push(...activityWarnings.map(i => `${summary.name}: ${i}`));
      }

      const uses = item.system?.uses;
      const itemUses = uses?.max
        ? {
            max: uses.max,
            spent: uses.spent ?? 0,
            recovery: (uses.recovery ?? []).map((r: any) =>
              r.period === 'recharge' ? `recharge ${r.formula}+` : r.period
            ),
          }
        : null;
      if (itemUses && !itemUses.recovery.length && item.type !== 'consumable') {
        warnings.push('has limited uses that never recover (normal for charges that are used up)');
      }

      const passiveEffects = Array.from<any>(item.effects ?? []).filter(
        e => e.transfer !== false && (e.changes?.length ?? 0) > 0
      );

      // Automation coverage for this item.
      const automation: string[] = [];
      const flags = item.flags ?? {};
      if (flags['chris-premades']?.info) automation.push("Chris's Premades automation");
      if (flags['gambits-premades']) automation.push("Gambit's Premades automation");
      // Midi-QOL leaves empty on-use fields on every item; count only real macros.
      const onUseName = String(flags['midi-qol']?.onUseMacroName ?? '').trim();
      const onUseParts = flags['midi-qol']?.onUseMacroParts?.items ?? [];
      if (onUseName || (Array.isArray(onUseParts) && onUseParts.some((p: any) => p?.macroName))) {
        automation.push('Midi-QOL on-use macro');
      }
      if (
        Array.from<any>(item.effects ?? []).some(e =>
          (e.changes ?? []).some((c: any) => /^(macro\.|flags\.(dae|midi-qol))/.test(c.key))
        )
      ) {
        automation.push('DAE/Midi effect macros');
      }
      const acting = activities.some(a => ACTING_ACTIVITIES.has(a.type));
      if (midi && acting) automation.push('Midi-QOL workflow (rolls and applies automatically)');
      if (flags.autoanimations?.isEnabled !== false && flags.autoanimations?.isCustomized) {
        automation.push('Automated Animations (item override)');
      } else if (autorec.length && flags.autoanimations?.isEnabled !== false) {
        const name = item.name.toLowerCase();
        const match = autorec.find(e =>
          e.exact ? name === e.label.toLowerCase() : name.includes(e.label.toLowerCase())
        );
        if (match)
          automation.push(`Automated Animations (autorec "${match.label}", ${match.menu})`);
      }

      // Classify.
      let status: string;
      if (STRUCTURAL_TYPES.has(item.type)) {
        status = 'structural';
      } else if (issues.length) {
        status = 'broken';
      } else if (acting) {
        status = 'works';
      } else if (activities.length) {
        status = 'utility-only';
      } else if (passiveEffects.length) {
        status = 'passive-effect';
      } else if (
        PASSIVE_TYPES.has(item.type) ||
        (item.type === 'equipment' && item.system?.armor?.value)
      ) {
        status = 'passive-item';
      } else if (item.type === 'consumable' && PASSIVE_CONSUMABLES.has(item.system?.type?.value)) {
        // Ammunition is spent by the weapon that fires it; food and the like are tracked by hand.
        status = 'passive-item';
      } else if (item.type === 'weapon' || item.type === 'spell' || item.type === 'consumable') {
        status = 'broken';
        issues.push(`${item.type} has no activity, so it cannot be used`);
      } else {
        status = 'description-only';
      }

      let spell: any;
      if (item.type === 'spell') {
        const sys = item.system;
        spell = {
          level: sys.level,
          method: sys.method ?? sys.preparation?.mode ?? null,
          prepared: sys.prepared ?? sys.preparation?.prepared ?? null,
        };
      }

      return {
        id: item.id,
        name: item.name,
        type: item.type,
        status,
        spell,
        activities,
        uses: itemUses ?? undefined,
        passiveEffects: passiveEffects.length ? passiveEffects.map(e => e.name) : undefined,
        automation,
        issues: issues.length ? issues : undefined,
        warnings: warnings.length ? warnings : undefined,
      };
    });

    const order = [
      'broken',
      'description-only',
      'utility-only',
      'works',
      'passive-effect',
      'passive-item',
      'structural',
    ];
    results.sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name)
    );
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const withWarnings = results.filter(r => r.warnings).length;

    return {
      success: true,
      actor: actor.name,
      actorId: actor.id,
      type: actor.type,
      system: `${game.system.id} ${game.system.version}`,
      modules,
      autorecEntries: modules.autoanimations.active ? autorec.length : undefined,
      itemsWithWarnings: withWarnings,
      statusKey: {
        broken: 'will not work as expected; see issues',
        warnings: 'separate from status: worth a look, but often correct by the rules',
        'description-only':
          'text only: no activity and no effect; fine for flavour, otherwise needs automation',
        'utility-only': 'has activities but none roll an attack, save, damage or healing',
        works: 'has a usable attack/save/damage/heal/check activity',
        'passive-effect': 'no activity, but applies an active effect',
        'passive-item': 'worn or carried gear with no activity',
        structural: 'class, subclass, background or species',
      },
      counts,
      items: results,
    };
  }
}

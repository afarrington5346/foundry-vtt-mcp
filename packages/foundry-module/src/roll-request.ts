/**
 * Roll-request buttons roll through the character's own sheet data (dnd5e), so the
 * player gets exactly what their sheet would roll: attack bonus and damage from the
 * item's activity, checks and saves from the actor, with every bonus and effect, and
 * with modules such as Midi-QOL hooking in as usual. A formula fixed when the request
 * was made (the old behaviour) missed all of that: an attack was a bare 1d20.
 */

export type NativeRollResult = 'rolled' | 'cancelled' | 'unsupported';

/** The item on the actor with this name, case-insensitive. */
export function findItem(actor: any, name: string): any {
  const wanted = name.trim().toLowerCase();
  return Array.from<any>(actor?.items ?? []).find(i => i.name?.toLowerCase() === wanted) ?? null;
}

/** The activity that rolls an item's attack, or its damage. */
export function findActivity(item: any, kind: 'attack' | 'damage'): any {
  const activities = Array.from<any>(item?.system?.activities ?? []);
  const attack = activities.find(a => a.type === 'attack');
  if (kind === 'attack') return attack ?? null;
  return (
    (attack?.damage?.parts?.length ? attack : null) ??
    activities.find(a => a.type === 'damage') ??
    activities.find(a => typeof a.rollDamage === 'function' && a.damage?.parts?.length) ??
    null
  );
}

/** Names of the actor's items that can be attacked with, for error messages. */
export function attackItemNames(actor: any): string[] {
  return Array.from<any>(actor?.items ?? [])
    .filter(i => findActivity(i, 'attack'))
    .map(i => i.name);
}

/**
 * Check a request before posting its button. Returns an error for Claude, or null.
 */
export function validateRollRequest(
  actor: any,
  rollType: string,
  rollTarget: string
): string | null {
  if (rollType !== 'attack' && rollType !== 'damage') return null;
  if (!actor) return `A ${rollType} roll needs a character.`;
  const item = findItem(actor, rollTarget);
  const known = attackItemNames(actor);
  if (!item) {
    return `"${actor.name}" has no item named "${rollTarget}". Items that can attack: ${known.join(', ') || 'none'}.`;
  }
  if (!findActivity(item, rollType)) {
    return `"${item.name}" has no ${rollType} roll. Items that can attack: ${known.join(', ') || 'none'}.`;
  }
  return null;
}

/**
 * Roll through the sheet. 'unsupported' means the caller should fall back to the
 * stored formula (no character, an unknown type, or an older system API).
 */
export async function rollNatively(
  actor: any,
  rollType: string,
  rollTarget: string,
  rollMode: string,
  skillCode: (name: string) => string
): Promise<NativeRollResult> {
  if (!actor) return 'unsupported';
  const message = { rollMode };
  let result: unknown;

  switch (rollType) {
    case 'ability':
      if (typeof actor.rollAbilityCheck !== 'function') return 'unsupported';
      result = await actor.rollAbilityCheck({ ability: rollTarget.toLowerCase() }, {}, message);
      break;
    case 'save':
      if (typeof actor.rollSavingThrow !== 'function') return 'unsupported';
      result = await actor.rollSavingThrow({ ability: rollTarget.toLowerCase() }, {}, message);
      break;
    case 'skill':
      if (typeof actor.rollSkill !== 'function') return 'unsupported';
      result = await actor.rollSkill({ skill: skillCode(rollTarget) }, {}, message);
      break;
    case 'initiative':
      // Rolls for the actor's combatant in the active combat (adds it if missing)
      if (typeof actor.rollInitiative !== 'function') return 'unsupported';
      result = await actor.rollInitiative({
        createCombatants: true,
        initiativeOptions: { messageOptions: { rollMode } },
      });
      break;
    case 'attack':
    case 'damage': {
      const activity = findActivity(findItem(actor, rollTarget), rollType);
      const method = rollType === 'attack' ? 'rollAttack' : 'rollDamage';
      if (!activity || typeof activity[method] !== 'function') return 'unsupported';
      result = await activity[method]({}, {}, message);
      break;
    }
    default:
      return 'unsupported';
  }

  // dnd5e returns null (or an empty list) when the player closes the roll dialog
  if (result === null || result === undefined || (Array.isArray(result) && result.length === 0)) {
    return 'cancelled';
  }
  return 'rolled';
}

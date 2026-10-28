/**
 * Roll-request buttons must roll through the sheet: in a live test an attack button
 * rolled a bare 1d20 and damage was a typed-in formula, both without the PC's bonuses.
 */

import { describe, expect, it, vi } from 'vitest';
import { findActivity, rollNatively, validateRollRequest } from './roll-request.js';

const skill = (name: string) => ({ perception: 'prc', stealth: 'ste' })[name.toLowerCase()] ?? name;

function halberd() {
  const attack = {
    type: 'attack',
    damage: { parts: [{ formula: '1d10' }] },
    rollAttack: vi.fn().mockResolvedValue([{ total: 19 }]),
    rollDamage: vi.fn().mockResolvedValue([{ total: 11 }]),
  };
  return { item: { name: 'Halberd', system: { activities: [attack] } }, attack };
}

function actor(items: any[] = []) {
  return {
    name: 'Aldren Veyle',
    items,
    rollAbilityCheck: vi.fn().mockResolvedValue([{ total: 12 }]),
    rollSavingThrow: vi.fn().mockResolvedValue([{ total: 14 }]),
    rollSkill: vi.fn().mockResolvedValue([{ total: 15 }]),
    rollInitiative: vi.fn().mockResolvedValue({ id: 'combat' }),
  };
}

describe('rollNatively', () => {
  it('rolls an attack and its damage through the named item', async () => {
    const { item, attack } = halberd();
    const a = actor([item]);
    await expect(rollNatively(a, 'attack', 'halberd', 'publicroll', skill)).resolves.toBe('rolled');
    expect(attack.rollAttack).toHaveBeenCalledWith({}, {}, { rollMode: 'publicroll' });
    await expect(rollNatively(a, 'damage', 'Halberd', 'gmroll', skill)).resolves.toBe('rolled');
    expect(attack.rollDamage).toHaveBeenCalledWith({}, {}, { rollMode: 'gmroll' });
  });

  it('rolls checks, saves, skills and initiative through the actor', async () => {
    const a = actor();
    await rollNatively(a, 'ability', 'DEX', 'publicroll', skill);
    expect(a.rollAbilityCheck).toHaveBeenCalledWith(
      { ability: 'dex' },
      {},
      { rollMode: 'publicroll' }
    );
    await rollNatively(a, 'save', 'wis', 'publicroll', skill);
    expect(a.rollSavingThrow).toHaveBeenCalledWith(
      { ability: 'wis' },
      {},
      { rollMode: 'publicroll' }
    );
    await rollNatively(a, 'skill', 'Perception', 'publicroll', skill);
    expect(a.rollSkill).toHaveBeenCalledWith({ skill: 'prc' }, {}, { rollMode: 'publicroll' });
    await expect(rollNatively(a, 'initiative', 'initiative', 'publicroll', skill)).resolves.toBe(
      'rolled'
    );
    expect(a.rollInitiative).toHaveBeenCalledWith(
      expect.objectContaining({ createCombatants: true })
    );
  });

  it('reports a closed roll dialog as cancelled', async () => {
    const a = actor();
    a.rollSkill.mockResolvedValue(null);
    await expect(rollNatively(a, 'skill', 'stealth', 'publicroll', skill)).resolves.toBe(
      'cancelled'
    );
  });

  it('falls back for custom rolls, no character, or an unknown item', async () => {
    await expect(rollNatively(actor(), 'custom', '1d4', 'publicroll', skill)).resolves.toBe(
      'unsupported'
    );
    await expect(rollNatively(null, 'skill', 'stealth', 'publicroll', skill)).resolves.toBe(
      'unsupported'
    );
    await expect(rollNatively(actor(), 'attack', 'Longbow', 'publicroll', skill)).resolves.toBe(
      'unsupported'
    );
  });

  it('finds damage on a damage-only activity', () => {
    const save = { type: 'save', damage: { parts: [] } };
    const dmg = { type: 'damage', damage: { parts: [{ formula: '2d6' }] }, rollDamage: vi.fn() };
    expect(findActivity({ system: { activities: [save, dmg] } }, 'damage')).toBe(dmg);
    expect(findActivity({ system: { activities: [save, dmg] } }, 'attack')).toBeNull();
  });
});

describe('validateRollRequest', () => {
  it('refuses an unknown attack item and lists the real ones', () => {
    const a = actor([halberd().item, { name: 'Rations', system: { activities: [] } }]);
    expect(validateRollRequest(a, 'attack', 'Halberd')).toBeNull();
    expect(validateRollRequest(a, 'damage', 'halberd')).toBeNull();
    expect(validateRollRequest(a, 'attack', 'Greatsword')).toMatch(
      /no item named "Greatsword".*Halberd/
    );
    expect(validateRollRequest(a, 'attack', 'Rations')).toMatch(/has no attack roll/);
    expect(validateRollRequest(a, 'skill', 'anything')).toBeNull();
  });
});

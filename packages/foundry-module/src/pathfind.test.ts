/**
 * Monsters must route around walls in one move, never through them (in a live test
 * one goblin took six tries and was finally teleported through a wall).
 */

import { describe, expect, it } from 'vitest';
import { findPath, truncatePath, type Cell } from './pathfind.js';

const k = (c: Cell) => `${c.column},${c.row}`;

/** A wall along the vertical line between column x-1 and x, for rows [from, to]. */
function verticalWall(x: number, from: number, to: number) {
  return (a: Cell, b: Cell) => {
    const crosses = (a.column < x && b.column >= x) || (b.column < x && a.column >= x);
    const row = Math.min(a.row, b.row);
    return crosses && row >= from && Math.max(a.row, b.row) <= to;
  };
}

const open = { passable: () => true, canEnd: () => true, blocked: () => false };

describe('findPath', () => {
  it('walks straight when nothing is in the way, diagonals costing 1', () => {
    const r = findPath({
      ...open,
      start: { column: 0, row: 0 },
      columns: 10,
      rows: 10,
      isGoal: c => k(c) === '3,3',
    })!;
    expect(r.path).toHaveLength(4);
    expect(r.costs.at(-1)).toBe(3);
  });

  it('routes around a wall instead of through it', () => {
    // Wall between columns 2 and 3 on rows 0-4; the only gap is at row 5+
    const blocked = verticalWall(3, 0, 4);
    const r = findPath({
      ...open,
      blocked,
      start: { column: 0, row: 0 },
      columns: 6,
      rows: 8,
      isGoal: c => k(c) === '5,0',
    })!;
    expect(r).not.toBeNull();
    for (let i = 1; i < r.path.length; i++) expect(blocked(r.path[i - 1], r.path[i])).toBe(false);
    expect(r.path.some(c => c.row >= 5)).toBe(true);
  });

  it('does not cut a wall corner diagonally', () => {
    const blocked = verticalWall(1, 0, 0); // wall between (0,0) and (1,0) only
    const r = findPath({
      ...open,
      blocked,
      start: { column: 0, row: 0 },
      columns: 3,
      rows: 3,
      isGoal: c => k(c) === '1,0',
    })!;
    // Can't go straight right, and the diagonal via (1,1)->(1,0) is fine, but (0,0)->(1,1) direct
    // diagonal would brush the wall end: the route must not include an illegal corner cut
    expect(r.path[0]).toEqual({ column: 0, row: 0 });
    expect(r.path.at(-1)).toEqual({ column: 1, row: 0 });
    expect(r.path.length).toBeGreaterThan(2);
  });

  it('returns null when walled off completely', () => {
    const r = findPath({
      ...open,
      blocked: verticalWall(2, 0, 9),
      start: { column: 0, row: 0 },
      columns: 5,
      rows: 10,
      isGoal: c => c.column === 4,
    });
    expect(r).toBeNull();
  });

  it('passes allies but not enemies, and never stops on a token', () => {
    const enemy = new Set(['1,0', '1,1']);
    const ally = new Set(['1,2']);
    const r = findPath({
      start: { column: 0, row: 0 },
      columns: 3,
      rows: 4,
      blocked: () => false,
      passable: c => !enemy.has(k(c)),
      canEnd: c => !enemy.has(k(c)) && !ally.has(k(c)),
      isGoal: c => c.column === 2 && c.row === 0,
    })!;
    expect(r.path.some(c => enemy.has(k(c)))).toBe(false);
  });

  it('reaches the nearest cell within reach of a target (toward)', () => {
    const target = { column: 6, row: 0 };
    const r = findPath({
      ...open,
      start: { column: 0, row: 0 },
      columns: 10,
      rows: 3,
      canEnd: c => k(c) !== k(target),
      isGoal: c => Math.max(Math.abs(c.column - target.column), Math.abs(c.row - target.row)) <= 1,
    })!;
    expect(r.path.at(-1)).toEqual({ column: 5, row: 0 });
  });
});

describe('closest-reachable fallback (score)', () => {
  it('moves as close as it can when walls cut it off from the target', () => {
    // Wall between columns 2 and 3 along every row: column 4 can't be reached
    const target = { column: 4, row: 2 };
    const dist = (c: Cell) =>
      Math.max(Math.abs(c.column - target.column), Math.abs(c.row - target.row));
    const r = findPath({
      ...open,
      blocked: verticalWall(3, 0, 9),
      start: { column: 0, row: 0 },
      columns: 6,
      rows: 5,
      isGoal: c => dist(c) <= 1,
      score: dist,
    })!;
    expect(r.fallback).toBe(true);
    // Right up against the wall: every column-2 square is equally close under the 5-ft diagonal
    // rule, and the cheapest one to reach wins the tie
    expect(r.path.at(-1)!.column).toBe(2);
    expect(dist(r.path.at(-1)!)).toBe(2);
    expect(r.costs.at(-1)).toBe(2);
  });

  it('still prefers a real goal when one is reachable', () => {
    const r = findPath({
      ...open,
      start: { column: 0, row: 0 },
      columns: 6,
      rows: 1,
      isGoal: c => c.column === 3,
      score: c => Math.abs(c.column - 5),
    })!;
    expect(r.fallback).toBeUndefined();
    expect(r.path.at(-1)).toEqual({ column: 3, row: 0 });
  });

  it('without score, an unreachable goal is still null', () => {
    const r = findPath({
      ...open,
      blocked: verticalWall(3, 0, 9),
      start: { column: 0, row: 0 },
      columns: 6,
      rows: 5,
      isGoal: c => c.column === 4,
    });
    expect(r).toBeNull();
  });
});

describe('truncatePath', () => {
  it('stops at the speed limit, on a cell it may end in', () => {
    const r = findPath({
      ...open,
      start: { column: 0, row: 0 },
      columns: 20,
      rows: 1,
      isGoal: c => c.column === 10,
    })!;
    const t = truncatePath(r, 6, c => c.column !== 6); // speed 30 ft = 6 squares; square 6 is occupied
    expect(t.path.at(-1)).toEqual({ column: 5, row: 0 });
    expect(t.costs.at(-1)).toBe(5);
  });
});

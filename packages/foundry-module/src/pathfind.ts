/**
 * Grid pathfinding for token moves: the shortest route over square-grid cells that
 * never crosses a wall. Pure, so it can be tested without Foundry; table-tools
 * supplies the wall test and which cells are occupied.
 *
 * An AI GM moving a monster used to aim straight at the target, hit a wall, retry a
 * handful of times and finally teleport through it (ignoreWalls).
 */

export interface Cell {
  column: number;
  row: number;
}

export interface PathOptions {
  start: Cell;
  columns: number;
  rows: number;
  /** Is this cell a destination? */
  isGoal: (cell: Cell) => boolean;
  /** A wall (or closed door) between two neighbouring cells */
  blocked: (from: Cell, to: Cell) => boolean;
  /** Can the mover pass through this cell (not occupied by an enemy)? */
  passable: (cell: Cell) => boolean;
  /** Can the mover end its move here (no other token there)? */
  canEnd: (cell: Cell) => boolean;
  /** Cost of a diagonal step relative to an orthogonal one (1 under the 2024 5-foot rule) */
  diagonalCost?: number;
  /**
   * Optional: if no goal is reachable, return the route to the reachable cell with the
   * lowest score instead of null (e.g. distance to the target: "get as close as you can")
   */
  score?: (cell: Cell) => number;
}

export interface PathResult {
  /** Cells from start to goal, inclusive */
  path: Cell[];
  /** Movement cost of each cell from the start, in steps */
  costs: number[];
  /** True when no goal was reachable and this is the closest reachable cell */
  fallback?: boolean;
}

const key = (c: Cell) => `${c.column},${c.row}`;
const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Cheapest path to the nearest goal cell, or null if none can be reached. */
export function findPath(o: PathOptions): PathResult | null {
  const diag = o.diagonalCost ?? 1;
  const dist = new Map<string, number>([[key(o.start), 0]]);
  const prev = new Map<string, Cell>();
  const open: Cell[] = [o.start];
  const done = new Set<string>();
  // With o.score: the reachable cell with the lowest score (e.g. distance to the target),
  // used when no goal can be reached at all
  let fallback: { cell: Cell; score: number } | null = null;
  const route = (cell: Cell, isFallback: boolean): PathResult => {
    const path: Cell[] = [cell];
    for (let c = prev.get(key(cell)); c; c = prev.get(key(c))) path.unshift(c);
    return {
      path,
      costs: path.map(c => dist.get(key(c))!),
      ...(isFallback ? { fallback: true } : {}),
    };
  };

  while (open.length) {
    // Grids here are a few hundred cells: a linear scan beats a heap for clarity
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (dist.get(key(open[i]))! < dist.get(key(open[best]))!) best = i;
    }
    const cell = open.splice(best, 1)[0];
    const k = key(cell);
    if (done.has(k)) continue;
    done.add(k);

    const canStop = o.canEnd(cell) || k === key(o.start);
    if (o.isGoal(cell) && canStop) return route(cell, false);
    if (o.score && canStop) {
      const s = o.score(cell);
      // Cells are settled cheapest-first, so on a tie the nearer one is kept
      if (!fallback || s < fallback.score) fallback = { cell, score: s };
    }

    for (const [dc, dr] of STEPS) {
      const next = { column: cell.column + dc, row: cell.row + dr };
      if (next.column < 0 || next.row < 0 || next.column >= o.columns || next.row >= o.rows)
        continue;
      const nk = key(next);
      if (done.has(nk) || !o.passable(next) || o.blocked(cell, next)) continue;
      // No squeezing diagonally past a wall corner: both orthogonal steps must be open
      if (dc && dr) {
        const a = { column: cell.column + dc, row: cell.row };
        const b = { column: cell.column, row: cell.row + dr };
        if (o.blocked(cell, a) || o.blocked(cell, b) || o.blocked(a, next) || o.blocked(b, next)) {
          continue;
        }
      }
      const cost = dist.get(k)! + (dc && dr ? diag : 1);
      if (cost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, cost);
        prev.set(nk, cell);
        open.push(next);
      }
    }
  }
  return fallback ? route(fallback.cell, true) : null;
}

/**
 * Cut a path to what the mover can cover this turn: the furthest cell within
 * maxSteps where it may stop.
 */
export function truncatePath(
  result: PathResult,
  maxSteps: number,
  canEnd: (c: Cell) => boolean
): PathResult {
  let last = 0;
  for (let i = 1; i < result.path.length; i++) {
    if (result.costs[i] > maxSteps + 1e-9) break;
    if (canEnd(result.path[i])) last = i;
  }
  return { path: result.path.slice(0, last + 1), costs: result.costs.slice(0, last + 1) };
}

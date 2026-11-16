// ============================================================================
// battle.training — STARTER controller template
// ============================================================================
//
// This is the template that ships with the battle-training-starter-kit.
// It is a teaching controller: correct, complete, and deliberately simple.
// It drafts a legal squad, drives at objectives, aims at the nearest visible
// enemy and fires when it can. It will beat the unmodified house-starter and
// lose to anything smarter. That is the point — every section below is marked
// with what it does and where the obvious improvements are.
//
// HOW A CONTROLLER WORKS (the short version — full docs:
// https://api.battle.training/docs/controller-api.md)
//
//   * Your controller is a plain object assigned to `globalThis.controller`.
//   * draft(h)  — optional, Season 2. Runs before hello() with the map, the
//                 rules and h.draft (roster / costs / budget). Return an
//                 array of 3–5 unit kinds whose total cost fits the budget,
//                 or return undefined to play the default squad.
//   * hello(h)  — called once per match with the rules and the full map.
//                 Do your heavy precomputation here (pathfinding grids,
//                 chokepoints): you get a generous budget once, but only
//                 ~10 ms of CPU per tick afterwards.
//   * tick(o)   — called 20 times a second with what your squad can see
//                 (o.units = your units, o.contacts = visible enemies,
//                 o.objectives = capture points). Return { units: [orders] }.
//
//   * Everything is integers. Positions are fixed-point: tiles × 65536.
//     Angles are 0..4095 for a full turn, 0 = east, increasing clockwise
//     (towards south). No network, no clock, no Math.random guarantees —
//     matches are deterministic and every replay is re-simulated.
//   * A tick() that throws sends empty orders for that tick. Never let it
//     throw: guard your assumptions.
//
// ORDERS (per unit, all fields optional except id)
//   steer     -65536..65536   turn rate, fraction of the unit's turnRate
//   throttle  -65536..65536   speed, fraction of the unit's top speed
//   aimAt     [x, y]          point a direct-fire turret at a position
//   fire      true            fire the main gun (direct) / engineer's MG
//             [x, y]          artillery: fire at a position (arc)
//   ability   "smoke"|"mine"  engineer abilities; missile carriers instead
//                             take a `target` every tick until locked (see
//                             the controller API docs)
//
// TEST BEFORE YOU UPLOAD:  node tools/local-test.mjs controller.js
// The local harness is the ladder's own engine — a result there is a
// result on the ladder.
// ============================================================================

const FP = 65536;   // fixed-point scale: 1 tile = 65536
const FULL = 4096;  // angle scale: full turn = 4096

let rules, map, side, hill;

// --- small geometry helpers -------------------------------------------------
function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) { return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }

/** Can a hull drive onto the tile containing (x, y)?
 *  Terrain ids: 2 = water, 4 = rock, 6 = ruin are closed to hulls.
 *  IMPROVE: a tile is really open when rules.terrainSpeed[class] > 0 for
 *  your unit's class — kinds differ (and preview maps add buildings, 8). */
function passable(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const t = map.terrain[ty * map.width + tx];
  return t !== 2 && t !== 4 && t !== 6;
}

/** The objective worth driving to: highest weight per tile of distance,
 *  skipping ones we already hold. Falls back to the map centre.
 *  IMPROVE: this sends the whole squad at one point. Real controllers
 *  split roles — a capturer per point, fighters where the enemy is —
 *  and weigh who else is already going there. */
function pickObjective(objectives, x, y) {
  let best = null, score = -1;
  for (const o of objectives || []) {
    if (o.owner === side && o.state === "held") continue;
    const s = o.weight / (1 + dist(x, y, o.x, o.y) / FP);
    if (s > score) { score = s; best = o; }
  }
  return best ? [best.x, best.y] : hill;
}

globalThis.controller = {
  // --- draft ---------------------------------------------------------------
  // Season 2 "Drafted": pick 3–5 kinds within h.draft.budget.
  // This template drafts two MBTs and two scouts (12 points) when a draft
  // is offered, and plays the default squad (scout + MBT + artillery)
  // otherwise.
  // IMPROVE: the draft decides games before they start. An APC captures
  // points at double rate; artillery out-ranges everything but cannot
  // brawl; drones spot but carry no gun. Read the last 7 days of draft
  // meta at https://api.battle.training/api/meta?theater=armor&days=7
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    const pick = ["mbt", "mbt", "scout", "scout"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every(k => d.roster.includes(k)) ? pick : undefined;
  },

  // --- hello ---------------------------------------------------------------
  // Called once with the rules and the full map. Store what tick() needs;
  // anything expensive belongs here, not in tick().
  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
  },

  // --- tick ----------------------------------------------------------------
  tick(o) {
    const units = [];
    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = rules.units[u.kind];
      const order = { id: u.id };

      // Nearest visible enemy.
      // IMPROVE: nearest is not always the right target — focus fire as a
      // squad on the lowest-HP contact in range, and lead moving targets
      // (shells take time to arrive).
      let target = null, best = Infinity;
      for (const c of o.contacts) { const d = dist(u.x, u.y, c.x, c.y); if (d < best) { best = d; target = c; } }

      // Movement: towards the best objective, unless an enemy is close
      // enough to shoot (then hold and fight). Artillery backs away from
      // anything inside its minimum range instead.
      let goal = pickObjective(o.objectives, u.x, u.y);
      if (target && best < spec.gun.maxRange * 0.8 && u.kind !== "scout") goal = null;
      if (u.kind === "artillery") goal = target && best < spec.gun.minRange * 1.5 ? [u.x * 2 - target.x, u.y * 2 - target.y] : null;
      if (goal && o.canMove) {
        let want = angleTo(u.x, u.y, goal[0], goal[1]);
        // Steer around obstacles: try the wanted heading, then fan out.
        // IMPROVE: this is greedy and can wedge on concave terrain. A*
        // over the tile grid, precomputed in hello(), is the standard fix.
        const offsets = [0, 341, -341, 683, -683, 1024, -1024];
        for (const off of offsets) {
          const a = (want + off) & (FULL - 1);
          const rad = (a / FULL) * 2 * Math.PI;
          if (passable(u.x + Math.cos(rad) * FP * 1.5, u.y + Math.sin(rad) * FP * 1.5)) { want = a; break; }
        }
        const d = angDiff(u.heading, want);
        order.steer = Math.max(-FP, Math.min(FP, Math.round((d / spec.turnRate) * FP)));
        order.throttle = Math.abs(d) > 512 ? Math.round(FP * 0.2) : FP;
        if (u.blocked) { order.throttle = -FP; order.steer = FP; }
      }

      // Weapons. Drones and engineers have no main gun; the engineer's
      // machine gun fires with fire: true when its secondary is ready.
      if (target) {
        if (spec.gun.mode === "none") {
          if (spec.secondary && u.reload2 === 0 && best <= spec.secondary.maxRange) order.fire = true;
        } else if (spec.gun.mode === "direct") {
          order.aimAt = [target.x, target.y];
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, target.x, target.y))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && aimed && best <= spec.gun.maxRange) order.fire = true;
        } else if (u.reload === 0 && best >= spec.gun.minRange && best <= spec.gun.maxRange) {
          order.fire = [target.x, target.y];
        }
      }
      units.push(order);
    }
    return { units };
  },
};

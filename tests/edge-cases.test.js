// Final-QA edge-case + integration tests.
//
// Cross-cutting scenarios that don't fit neatly in any single module's test
// file: rapid input, huge dt jumps (tab-inactive → active), long-game
// integrity, score rollover, state-machine deadlocks, full game+scorer
// integration, listener leak surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState, Phase } from '../src/game.js';
import { difficultyForRound, ballCountForRound } from '../src/difficulty.js';
import { Scorer } from '../src/scoring.js';
import { calmReport, computeCalmIndex } from '../src/calm-index.js';
import { Emitter } from '../src/events.js';

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function drainReveal(g, sliceMs = 30, budgetSeconds = 30) {
  const dt = sliceMs / 1000;
  let total = 0;
  g.tickReveal(0);
  while (
    (g.phase === Phase.REVEAL || g.phase === Phase.SPLIT_REVEAL) &&
    total < budgetSeconds
  ) {
    g.tickReveal(dt);
    total += dt;
  }
}

// ─── Rapid input stress ─────────────────────────────────────────────────────

describe('Rapid click storms', () => {
  it('100 clicks during IDLE all return "ignored", no crash', () => {
    const g = new GameState();
    for (let i = 0; i < 100; i++) {
      expect(g.handleClick(i)).toBe('ignored');
    }
    expect(g.phase).toBe(Phase.IDLE);
  });

  it('rapid clicks during REVEAL: first valid click is processed (not ignored)', () => {
    const g = new GameState({ rng: mulberry32(1) });
    g.startRound(3, [1, 2, 3]);
    expect(g.phase).toBe(Phase.REVEAL);
    // Impatient-player path: clicks during REVEAL short-circuit to RECALL.
    // The first click is processed; phase advances out of REVEAL.
    const first = g.handleClick(g.sequence[0]);
    expect(['correct', 'wrong']).toContain(first);
    expect(g.phase).not.toBe(Phase.REVEAL);
  });

  it('rapid wrong clicks (livesMax:1): only the FIRST triggers GAME_OVER', () => {
    // Phase 7: with default 3 lives this stress test would also need to
    // contend with the per-wrong-click cooldown. To keep the original
    // stress-shape (one wrong → GAME_OVER, then everything ignored), drive
    // the run with livesMax:1 — same single-strike semantics as v1.
    const g = new GameState({ rng: mulberry32(2), livesMax: 1 });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    const overFn = vi.fn();
    g.on('gameOver', overFn);
    const expected = g.sequence[0];
    const wrong = [1, 2, 3].find((id) => id !== expected);

    expect(g.handleClick(wrong)).toBe('wrong');
    // Subsequent rapid clicks are ignored — no double GAME_OVER.
    for (let i = 0; i < 50; i++) {
      expect(g.handleClick(wrong)).toBe('ignored');
      expect(g.handleClick(expected)).toBe('ignored');
    }
    expect(overFn).toHaveBeenCalledTimes(1);
    expect(g.phase).toBe(Phase.GAME_OVER);
  });

  it('rapid wrong clicks under default 3 lives + injected clock: 3 misses → GAME_OVER', () => {
    // Default lives + bypass cooldown via fast-forwarded clock so the test
    // can land 3 successive wrongs without burning real wall-clock time.
    let t = 0;
    const g = new GameState({ rng: mulberry32(2), now: () => t });
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    const overFn = vi.fn();
    g.on('gameOver', overFn);
    const expected = g.sequence[0];
    const wrong = [1, 2, 3].find((id) => id !== expected);

    // 3 wrongs, each separated by a cooldown-clearing clock tick.
    expect(g.handleClick(wrong)).toBe('wrong');
    t += 1000;
    expect(g.handleClick(wrong)).toBe('wrong');
    t += 1000;
    expect(g.handleClick(wrong)).toBe('wrong');

    expect(g.phase).toBe(Phase.GAME_OVER);
    expect(overFn).toHaveBeenCalledTimes(1);
    expect(overFn).toHaveBeenCalledWith({
      round: 3,
      reason: 'lives-exhausted',
      livesLost: 3,
    });

    // After GAME_OVER everything is ignored.
    for (let i = 0; i < 10; i++) {
      expect(g.handleClick(wrong)).toBe('ignored');
      expect(g.handleClick(expected)).toBe('ignored');
    }
  });

  it('rapid double-click on the same correct ball: only the first counts', () => {
    const g = new GameState({ rng: mulberry32(3) });
    g.startRound(3, [10, 20, 30]);
    drainReveal(g);
    const first = g.sequence[0];
    expect(g.handleClick(first)).toBe('correct');
    // 20 more clicks on the SAME ball — all ignored, no advance.
    const cursorAfterFirst = g.recallCursor;
    for (let i = 0; i < 20; i++) {
      expect(g.handleClick(first)).toBe('ignored');
    }
    expect(g.recallCursor).toBe(cursorAfterFirst);
  });
});

// ─── Tab-inactive → active simulation ───────────────────────────────────────

describe('Huge dt jumps (tab inactive → active)', () => {
  it('tickReveal with a 10-second dt does NOT skip steps, advances at most one boundary', () => {
    const g = new GameState({ rng: mulberry32(4) });
    g.startRound(3, [1, 2, 3]);
    g.tickReveal(0); // prime
    // Now hit it with a single huge dt — equivalent to tab returning from
    // background. Per the impl comment, we should advance ONE step boundary.
    g.tickReveal(10);
    // Reveal still in progress (didn't blast through to RECALL).
    expect(g.phase).toBe(Phase.REVEAL);
  });

  it('tickReveal with NaN/negative dt is ignored (no NaN propagation)', () => {
    const g = new GameState({ rng: mulberry32(5) });
    g.startRound(2, [1, 2]);
    expect(() => g.tickReveal(NaN)).not.toThrow();
    expect(() => g.tickReveal(-1)).not.toThrow();
    expect(() => g.tickReveal(Infinity)).not.toThrow();
    expect(g.phase).toBe(Phase.REVEAL);
  });

  it('many small dts followed by a huge dt eventually completes the reveal', () => {
    const g = new GameState({ rng: mulberry32(6) });
    g.startRound(3, [1, 2, 3]);
    g.tickReveal(0);
    // Pump for a few seconds normally.
    for (let i = 0; i < 100; i++) g.tickReveal(0.05);
    if (g.phase === Phase.REVEAL) {
      // Then a big dt (e.g. tab returned from background).
      g.tickReveal(5);
      // And keep going.
      for (let i = 0; i < 100; i++) g.tickReveal(0.05);
    }
    // Eventually we transitioned to RECALL.
    expect(g.phase).toBe(Phase.RECALL);
  });
});

// ─── Long-game integrity ────────────────────────────────────────────────────

describe('Long game integrity (20 rounds simulated)', () => {
  it('20 perfect rounds: totalScore sane, streak capped at MAX_MULTIPLIER', () => {
    const c = (() => {
      let t = 1_000_000;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    const s = new Scorer({ now: c.now });

    let totalCorrectClicks = 0;
    for (let r = 1; r <= 20; r++) {
      s.beginRound(r);
      const n = ballCountForRound(r);
      for (let i = 0; i < n; i++) {
        c.tick(500);
        s.registerCorrectClick({ depth: 0 });
        totalCorrectClicks += 1;
      }
      s.finishRound();
    }

    expect(s.streak).toBe(20);
    expect(s.bestStreak).toBe(20);
    expect(Number.isFinite(s.totalScore)).toBe(true);
    expect(Number.isInteger(s.totalScore)).toBe(true);
    expect(s.totalScore).toBeGreaterThan(0);

    // Every round from streak 10+ should have multiplier = 2.0 (capped).
    for (const round of s.roundStats.slice(9)) {
      expect(round.multiplier).toBeCloseTo(2.0, 5);
    }

    expect(s.getCalmStats().correctClicks).toBe(totalCorrectClicks);
  });

  it('mixed perfect/imperfect run: no NaN, streak resets correctly', () => {
    const c = (() => {
      let t = 0;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    const s = new Scorer({ now: c.now });

    for (let r = 1; r <= 12; r++) {
      s.beginRound(r);
      c.tick(400);
      s.registerCorrectClick({ depth: 0 });
      // Every 4th round: a wrong click.
      if (r % 4 === 0) s.registerWrongClick();
      s.finishRound();
    }

    expect(Number.isFinite(s.totalScore)).toBe(true);
    expect(s.totalScore).toBeGreaterThan(0);

    // Streak resets after r=4, r=8, r=12 (all the "wrong" rounds).
    // After r=12 (imperfect), streak should be 0.
    expect(s.streak).toBe(0);
    // bestStreak captures the longest perfect run (r=5..7 gives 3).
    expect(s.bestStreak).toBe(3);
  });

  it('Calm Index stays in [0,100] across a long noisy run', () => {
    const c = (() => {
      let t = 0;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    const s = new Scorer({ now: c.now });

    for (let r = 1; r <= 30; r++) {
      s.beginRound(r);
      const correct = (r % 3 === 0) ? 0 : Math.min(r, 5);
      const wrong = (r % 3 === 0) ? 1 : 0;
      for (let i = 0; i < correct; i++) {
        c.tick(300 + (i % 5) * 100);
        s.registerCorrectClick({ depth: 0, willSplit: r >= 4 && i === 0 });
      }
      for (let i = 0; i < wrong; i++) s.registerWrongClick();
      s.finishRound();
      const calm = computeCalmIndex(s.getCalmStats());
      expect(calm).toBeGreaterThanOrEqual(0);
      expect(calm).toBeLessThanOrEqual(100);
      expect(Number.isFinite(calm)).toBe(true);
    }
  });
});

// ─── State-machine integrity ────────────────────────────────────────────────

describe('State-machine — no deadlocks, all phases recoverable via reset', () => {
  function fresh(seed = 1) {
    return new GameState({ rng: mulberry32(seed) });
  }

  it('reset() from every phase lets a fresh round start', () => {
    // IDLE → reset → start
    let g = fresh();
    g.reset();
    expect(() => g.startRound(1, [1])).not.toThrow();

    // REVEAL → reset → start
    g = fresh();
    g.startRound(2, [1, 2]);
    g.reset();
    expect(() => g.startRound(3, [1, 2, 3])).not.toThrow();

    // RECALL → reset → start
    g = fresh();
    g.startRound(2, [1, 2]);
    drainReveal(g);
    g.reset();
    expect(() => g.startRound(1, [99])).not.toThrow();

    // SPLIT_REVEAL → reset → start
    g = new GameState({ rng: mulberry32(99) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    const splitId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitId);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
    g.reset();
    expect(() => g.startRound(1, [99])).not.toThrow();

    // RESOLVE → reset → start
    g = fresh();
    g.startRound(1, [42]);
    drainReveal(g);
    g.handleClick(42);
    expect(g.phase).toBe(Phase.RESOLVE);
    g.reset();
    expect(() => g.startRound(1, [99])).not.toThrow();

    // GAME_OVER → reset → start
    // Phase 7: a single wrong click no longer ends the game under default
    // lives — use livesMax:1 to force the GAME_OVER transition we want.
    g = new GameState({ rng: mulberry32(1), livesMax: 1 });
    g.startRound(2, [1, 2]);
    drainReveal(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.GAME_OVER);
    g.reset();
    expect(() => g.startRound(1, [99])).not.toThrow();
  });

  it('cannot startRound mid-cycle without resetting first', () => {
    const g = fresh();
    g.startRound(1, [1]);
    expect(() => g.startRound(2, [1, 2])).toThrow(/Cannot startRound/);
    drainReveal(g);
    expect(() => g.startRound(2, [1, 2])).toThrow(/Cannot startRound/);
  });

  it('SPLIT_REVEAL waits for acceptSplitChildren — no auto-progress', () => {
    const g = new GameState({ rng: mulberry32(99) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    const splitId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitId);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
    // Pump tickReveal lots — no auto-recovery, still SPLIT_REVEAL.
    for (let i = 0; i < 200; i++) g.tickReveal(0.05);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
  });
});

// ─── Game ↔ Scorer ↔ Calm Index integration ─────────────────────────────────

describe('Full game + scorer + Calm Index integration', () => {
  it('a perfect no-split round reports a high Calm Index', () => {
    const c = (() => {
      let t = 0;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    const g = new GameState({ rng: mulberry32(7) });
    const s = new Scorer({ now: c.now }).attachToGame(g);

    // Round 3 has 3 balls + splitCountForRound(3) === 0 → guaranteed no split.
    g.startRound(3, [1, 2, 3]);
    drainReveal(g);
    let safety = 50;
    while (!g.checkComplete() && safety-- > 0) {
      c.tick(400); // 400ms reactions → fast (< 700)
      g.handleClick(g.sequence[g.recallCursor]);
    }

    expect(g.phase).toBe(Phase.RESOLVE);
    expect(s.streak).toBe(1);

    const r = calmReport(s.getCalmStats());
    // 100% accuracy + 100% speed (400ms) + composure-fallback to accuracy = 100
    expect(r.index).toBe(100);
    expect(r.tier.name).toBe('Blossom');
  });

  it('a wrong click mid-round drops Calm Index toward Marker tier', () => {
    const c = (() => {
      let t = 0;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    // Phase 7: under default 3 lives a single wrong click won't trigger
    // GAME_OVER. Use livesMax:1 to preserve the original "wrong click ends
    // the game mid-round" scenario this test asserts on.
    const g = new GameState({ rng: mulberry32(8), now: c.now, livesMax: 1 });
    const s = new Scorer({ now: c.now }).attachToGame(g);

    g.startRound(3, [10, 20, 30]);
    drainReveal(g);
    c.tick(500);
    g.handleClick(g.sequence[0]); // correct
    // Wrong click → GAME_OVER (livesMax:1). attachToGame wires `wrongClick` →
    // registerWrongClick.
    const wrong = [10, 20, 30].find((id) => id !== g.sequence[1]);
    g.handleClick(wrong);

    expect(g.phase).toBe(Phase.GAME_OVER);
    // No roundComplete fired → finishRound never called → 0 rounds played.
    // But the wrong click still flipped perfect=false on _current.
    expect(s._current?.perfect).toBe(false);
    expect(s._current?.wrongClicks).toBe(1);

    // Calm stats are zero-rounded since no round finished — index = 0.
    const r = calmReport(s.getCalmStats());
    expect(r.index).toBe(0);
    expect(r.tier.name).toBe('Seedling');
  });

  it('round 4 with split: scorer correctly weights split-child clicks 20pts', () => {
    const c = (() => {
      let t = 0;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    const g = new GameState({ rng: mulberry32(99) });
    const s = new Scorer({ now: c.now }).attachToGame(g);

    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    const splitId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitId) {
      c.tick(400);
      g.handleClick(g.sequence[g.recallCursor]);
    }
    c.tick(400);
    g.handleClick(splitId); // primary click on willSplit ball: 10 pts
    g.acceptSplitChildren(splitId, [101, 102]);
    drainReveal(g);

    while (!g.checkComplete()) {
      c.tick(400);
      g.handleClick(g.sequence[g.recallCursor]);
    }

    // Score breakdown (basePoints from depth=0 vs depth=1 clicks):
    //   3 primary clicks (10, 20, splitId): 3 × 10 = 30
    //   2 split children (depth=1):           2 × 20 = 40
    //   basePoints = 70
    const round = s.roundStats[0];
    expect(round.basePoints).toBe(70);
    expect(round.hadSplit).toBe(true);
    expect(round.splitChildClicks).toBe(2);
  });
});

// ─── Listener leak surface ──────────────────────────────────────────────────

describe('Emitter listener hygiene', () => {
  it('many rounds with attachToGame do NOT silently leak listeners', () => {
    // attachToGame subscribes once. A single Scorer + game pair across many
    // rounds should keep listener count constant.
    const e = new Emitter();
    const s = new Scorer().attachToGame(e);
    // 4 events subscribed by attachToGame.
    expect(e._listeners.get('roundStart')?.size).toBe(1);
    expect(e._listeners.get('correctClick')?.size).toBe(1);
    expect(e._listeners.get('wrongClick')?.size).toBe(1);
    expect(e._listeners.get('roundComplete')?.size).toBe(1);

    // Drive 50 rounds via emits — listener count must stay at 1 each.
    for (let r = 1; r <= 50; r++) {
      e.emit('roundStart', { round: r });
      e.emit('correctClick', { ballId: 1, depth: 0, willSplit: false });
      e.emit('roundComplete', { round: r, perfect: true });
    }
    expect(e._listeners.get('roundStart').size).toBe(1);
    expect(e._listeners.get('correctClick').size).toBe(1);
  });

  it('removeAll on the game emitter detaches the scorer cleanly', () => {
    const e = new Emitter();
    new Scorer().attachToGame(e);
    e.removeAll();
    expect(e._listeners.get('roundStart')).toBeUndefined();
    expect(e._listeners.get('correctClick')).toBeUndefined();
  });
});

// ─── Score rollover at high values ──────────────────────────────────────────

describe('Score rollover at very high totals', () => {
  it('totalScore is always a finite integer even after thousands of clicks', () => {
    const c = (() => {
      let t = 0;
      return { now: () => t, tick: (ms) => (t += ms) };
    })();
    const s = new Scorer({ now: c.now });

    for (let r = 1; r <= 50; r++) {
      s.beginRound(r);
      // Worst case: 8 balls per round + 4 split children = 12 clicks/round.
      for (let i = 0; i < 12; i++) {
        c.tick(400);
        s.registerCorrectClick({ depth: i % 2 === 0 ? 0 : 1 });
      }
      s.finishRound();
    }
    expect(Number.isFinite(s.totalScore)).toBe(true);
    expect(Number.isInteger(s.totalScore)).toBe(true);
    expect(s.totalScore).toBeGreaterThan(0);
    // Sanity upper bound — even with max bonuses we stay well below
    // Number.MAX_SAFE_INTEGER (which is 2^53-1).
    expect(s.totalScore).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

// ─── Difficulty integration spot-checks ─────────────────────────────────────

describe('Difficulty curve sanity', () => {
  it('ballCountForRound increases monotonically across realistic rounds', () => {
    let last = 0;
    for (let r = 1; r <= 30; r++) {
      const n = ballCountForRound(r);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it('difficultyForRound is internally consistent', () => {
    for (let r = 1; r <= 15; r++) {
      const d = difficultyForRound(r);
      expect(d.round).toBe(r);
      expect(d.ballCount).toBe(ballCountForRound(r));
      expect(d.flashDuration).toBeGreaterThan(0);
      expect(d.gap).toBeGreaterThan(0);
      expect(d.maxSplitDepth).toBeGreaterThanOrEqual(1);
      expect(d.maxSplitDepth).toBeLessThanOrEqual(2);
    }
  });
});

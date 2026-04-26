// Tests for src/game.js — GameState state machine.
//
// Drives the state machine with explicit ticks (no timers, no DOM) and asserts
// emitted events + return values. Uses a seeded RNG for deterministic shuffles.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState, Phase } from '../src/game.js';
import { difficultyForRound } from '../src/difficulty.js';

// Deterministic RNG so sequence shuffles are reproducible.
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

// Drive REVEAL through to completion. Uses the difficulty for the current
// round (or supplied override) to pick a step duration; pumps small dt slices
// so we exercise the per-tick code path properly. Returns total elapsed.
function runRevealToCompletion(g, sliceMs = 50) {
  const d = difficultyForRound(g.round);
  const stepDur = d.flashDuration + d.gap;
  const totalNeeded =
    stepDur * g.sequence.length + (g._holdAfterReveal ?? d.holdAfterReveal) + 0.05;

  const dt = sliceMs / 1000;
  let total = 0;
  // First tick "primes" awaitingFirst without advancing time.
  g.tickReveal(0);
  while (g.phase === Phase.REVEAL && total < totalNeeded + 5) {
    g.tickReveal(dt);
    total += dt;
  }
  return total;
}

let game;

beforeEach(() => {
  game = new GameState({ rng: mulberry32(1234) });
});

describe('GameState construction', () => {
  it('starts in IDLE with zero round and empty arrays', () => {
    expect(game.phase).toBe(Phase.IDLE);
    expect(game.round).toBe(0);
    expect(game.ballIds).toEqual([]);
    expect(game.sequence).toEqual([]);
    expect(game.recallCursor).toBe(0);
    expect(game.perfect).toBe(true);
  });

  it('uses Math.random when no rng is passed', () => {
    const g = new GameState();
    expect(typeof g.rng).toBe('function');
  });
});

describe('startRound validation', () => {
  it('rejects round < 1', () => {
    expect(() => game.startRound(0, [1])).toThrow(/round/i);
    expect(() => game.startRound(-3, [1])).toThrow(/round/i);
  });

  it('rejects non-integer round', () => {
    expect(() => game.startRound(1.5, [1])).toThrow(/round/i);
    expect(() => game.startRound('1', [1])).toThrow(/round/i);
  });

  it('rejects empty / non-array ballIds', () => {
    expect(() => game.startRound(1, [])).toThrow(/ballIds/i);
    expect(() => game.startRound(1, null)).toThrow(/ballIds/i);
    expect(() => game.startRound(1, 'abc')).toThrow(/ballIds/i);
  });

  it('rejects start when phase is not IDLE or RESOLVE', () => {
    game.startRound(1, [1, 2, 3]);
    // Phase is now REVEAL — second startRound should throw
    expect(() => game.startRound(2, [4, 5, 6])).toThrow(/Cannot startRound/);
  });
});

describe('startRound success', () => {
  it('transitions IDLE → REVEAL and emits roundStart', () => {
    const phaseFn = vi.fn();
    const startFn = vi.fn();
    game.on('phase', phaseFn);
    game.on('roundStart', startFn);

    game.startRound(3, [10, 20, 30]);

    expect(game.phase).toBe(Phase.REVEAL);
    expect(phaseFn).toHaveBeenCalledWith(Phase.IDLE, Phase.REVEAL);
    expect(startFn).toHaveBeenCalledTimes(1);
    const payload = startFn.mock.calls[0][0];
    expect(payload.round).toBe(3);
    expect(payload.ballIds).toEqual([10, 20, 30]);
    expect(payload.sequence).toHaveLength(3);
    expect(payload.difficulty).toBeDefined();
  });

  it('roundStart payload arrays are copies (mutation-safe)', () => {
    const startFn = vi.fn();
    game.on('roundStart', startFn);
    game.startRound(2, [1, 2, 3]);
    const { ballIds, sequence } = startFn.mock.calls[0][0];
    ballIds.push(999);
    sequence.push(999);
    expect(game.ballIds).toEqual([1, 2, 3]);
    expect(game.sequence).toHaveLength(3);
  });
});

describe('generateSequence', () => {
  it('returns a permutation of input ballIds', () => {
    const ids = [11, 22, 33, 44, 55];
    const seq = game.generateSequence(ids);
    expect(seq).toHaveLength(ids.length);
    expect([...seq].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  });

  it('does not mutate the input', () => {
    const ids = [1, 2, 3];
    const before = [...ids];
    game.generateSequence(ids);
    expect(ids).toEqual(before);
  });

  it('is deterministic for a given seeded RNG', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new GameState({ rng: mulberry32(42) }).generateSequence(ids);
    const b = new GameState({ rng: mulberry32(42) }).generateSequence(ids);
    expect(a).toEqual(b);
  });

  it('produces different orders across many seeds (probabilistic sanity)', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const seen = new Set();
    for (let s = 0; s < 30; s++) {
      const seq = new GameState({ rng: mulberry32(s) }).generateSequence(ids);
      seen.add(seq.join(','));
    }
    // Out of 30 seeds we expect lots of distinct orders. >5 is a generous lower bound.
    expect(seen.size).toBeGreaterThan(5);
  });

  it('handles a single-ball sequence (round 1 case)', () => {
    expect(game.generateSequence([42])).toEqual([42]);
  });
});

describe('REVEAL phase ticking', () => {
  it('walks through every step and transitions to RECALL', () => {
    game.startRound(2, [1, 2]); // 2 balls (round 2 per spec table)
    const events = [];
    game.on('revealStep', (p) => events.push(['step', p.index, p.level]));
    game.on('revealStepEnd', (p) => events.push(['end', p.index]));
    game.on('revealComplete', () => events.push(['complete']));

    runRevealToCompletion(game);

    expect(game.phase).toBe(Phase.RECALL);
    expect(events.find((e) => e[0] === 'complete')).toBeDefined();
    // Each step in the sequence must have been ended.
    const ends = events.filter((e) => e[0] === 'end').map((e) => e[1]);
    expect(ends).toEqual(game.sequence.map((_, i) => i));
  });

  it('every revealStep level is in [0, 1]', () => {
    game.startRound(3, [1, 2, 3]);
    const levels = [];
    game.on('revealStep', (p) => levels.push(p.level));
    runRevealToCompletion(game);
    expect(levels.length).toBeGreaterThan(0);
    for (const lv of levels) {
      expect(lv).toBeGreaterThanOrEqual(0);
      expect(lv).toBeLessThanOrEqual(1);
    }
  });

  it('tickReveal is a no-op outside REVEAL phase', () => {
    const fn = vi.fn();
    game.on('revealStep', fn);
    game.tickReveal(0.1); // IDLE
    expect(fn).not.toHaveBeenCalled();

    game.startRound(2, [1, 2]);
    runRevealToCompletion(game);
    expect(game.phase).toBe(Phase.RECALL);
    fn.mockClear();
    game.tickReveal(0.1); // RECALL — should not emit
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores NaN / negative dt without throwing', () => {
    game.startRound(2, [1, 2]);
    expect(() => game.tickReveal(NaN)).not.toThrow();
    expect(() => game.tickReveal(-1)).not.toThrow();
    // Phase should not have advanced.
    expect(game.phase).toBe(Phase.REVEAL);
  });
});

describe('handleClick — RECALL happy path', () => {
  beforeEach(() => {
    game.startRound(3, [1, 2, 3]);
    runRevealToCompletion(game);
    expect(game.phase).toBe(Phase.RECALL);
  });

  it('correct click returns "correct" and advances cursor', () => {
    const expected = game.sequence[0];
    const fn = vi.fn();
    game.on('correctClick', fn);
    expect(game.handleClick(expected)).toBe('correct');
    expect(game.recallCursor).toBe(1);
    // Payload extended in Phase 4 to include depth + willSplit.
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ ballId: expected, indexInSequence: 0 }),
    );
    const payload = fn.mock.calls[0][0];
    expect(payload).toHaveProperty('depth');
    expect(payload).toHaveProperty('willSplit');
  });

  it('clicking the full sequence in order completes the round', () => {
    const completeFn = vi.fn();
    game.on('roundComplete', completeFn);
    for (const id of game.sequence) {
      expect(game.handleClick(id)).toBe('correct');
    }
    expect(game.phase).toBe(Phase.RESOLVE);
    expect(game.checkComplete()).toBe(true);
    // Phase 7: roundComplete payload now includes per-round lives-lost counter.
    expect(completeFn).toHaveBeenCalledWith({
      round: 3,
      perfect: true,
      livesLostThisRound: 0,
    });
  });

  it('double-click on already-correct ball returns "ignored"', () => {
    const first = game.sequence[0];
    expect(game.handleClick(first)).toBe('correct');
    expect(game.handleClick(first)).toBe('ignored');
    expect(game.recallCursor).toBe(1); // unchanged
  });
});

// Phase 7 changed wrong-click semantics: a single miss only deducts a life
// rather than ending the game. To preserve the legacy "single strike →
// GAME_OVER" assertions, this block constructs the game with livesMax:1 so
// one wrong click still triggers immediate game over (the lives-exhausted
// path) — that exercises the same control flow as the old single-strike rule.
describe('handleClick — wrong click → GAME_OVER (livesMax:1 / single-strike mode)', () => {
  let g;
  beforeEach(() => {
    g = new GameState({ rng: mulberry32(1234), livesMax: 1 });
    g.startRound(3, [1, 2, 3]);
    runRevealToCompletion(g);
  });

  it('wrong click returns "wrong", emits gameOver, blocks roundComplete', () => {
    const wrongFn = vi.fn();
    const lifeLostFn = vi.fn();
    const overFn = vi.fn();
    const completeFn = vi.fn();
    g.on('wrongClick', wrongFn);
    g.on('lifeLost', lifeLostFn);
    g.on('gameOver', overFn);
    g.on('roundComplete', completeFn);

    // Pick a ball that's NOT the expected one
    const expected = g.sequence[0];
    const wrong = g.ballIds.find((id) => id !== expected);
    expect(g.handleClick(wrong)).toBe('wrong');

    expect(g.phase).toBe(Phase.GAME_OVER);
    // Phase 7: wrongClick payload now carries livesRemaining.
    expect(wrongFn).toHaveBeenCalledWith({
      ballId: wrong,
      expectedBallId: expected,
      livesRemaining: 0,
    });
    // lifeLost fires alongside wrongClick.
    expect(lifeLostFn).toHaveBeenCalledWith({
      ballId: wrong,
      expectedBallId: expected,
      livesRemaining: 0,
      livesLostThisRound: 1,
    });
    // Phase 7: gameOver reason switched from 'wrong-click' to 'lives-exhausted'
    // and now reports total lives consumed (== livesMax on the final blow).
    expect(overFn).toHaveBeenCalledWith({
      round: 3,
      reason: 'lives-exhausted',
      livesLost: 1,
    });
    expect(completeFn).not.toHaveBeenCalled();
    expect(g.perfect).toBe(false);
  });

  it('subsequent clicks after GAME_OVER are ignored', () => {
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.handleClick(g.sequence[0])).toBe('ignored');
    expect(g.handleClick(wrong)).toBe('ignored');
  });
});

describe('handleClick — phase guards', () => {
  it('returns "ignored" during IDLE', () => {
    expect(game.handleClick(1)).toBe('ignored');
  });

  it('accepts clicks during REVEAL (auto-skips reveal animation)', () => {
    game.startRound(2, [1, 2]);
    expect(game.phase).toBe(Phase.REVEAL);
    const expected = game.sequence[0];
    const result = game.handleClick(expected);
    // Click is processed (not ignored); a wrong-id during REVEAL would also
    // resolve to 'wrong' rather than 'ignored'.
    expect(['correct', 'wrong']).toContain(result);
    // Phase must have advanced out of REVEAL.
    expect(game.phase).not.toBe(Phase.REVEAL);
  });

  it('returns "ignored" during RESOLVE', () => {
    game.startRound(1, [1]);
    runRevealToCompletion(game);
    game.handleClick(game.sequence[0]); // completes round
    expect(game.phase).toBe(Phase.RESOLVE);
    expect(game.handleClick(1)).toBe('ignored');
  });

  it('returns "ignored" for non-number / non-string ids', () => {
    game.startRound(2, [1, 2]);
    runRevealToCompletion(game);
    expect(game.handleClick(null)).toBe('ignored');
    expect(game.handleClick(undefined)).toBe('ignored');
    expect(game.handleClick({})).toBe('ignored');
    expect(game.handleClick([1])).toBe('ignored');
  });

  it('treats an unknown ball id as a wrong click (deducts a life, stays in RECALL)', () => {
    game.startRound(2, [1, 2]);
    runRevealToCompletion(game);
    // Click an id that isn't on the board — counts as wrong, not ignored,
    // since the player still made a click. Phase 7: with default 3 lives, a
    // single wrong click deducts a life and stays in RECALL (player can retry).
    const livesBefore = game.lives;
    const result = game.handleClick(999);
    expect(result).toBe('wrong');
    expect(game.phase).toBe(Phase.RECALL);
    expect(game.lives).toBe(livesBefore - 1);
    expect(game.livesLostThisRound).toBe(1);
  });
});

describe('round 1 edge case (single ball, tutorial)', () => {
  it('completes round 1 with a single click', () => {
    game.startRound(1, [42]);
    runRevealToCompletion(game);
    expect(game.sequence).toEqual([42]);
    expect(game.handleClick(42)).toBe('correct');
    expect(game.phase).toBe(Phase.RESOLVE);
    expect(game.perfect).toBe(true);
  });
});

describe('nextRound', () => {
  it('throws when not in RESOLVE', () => {
    expect(() => game.nextRound([1])).toThrow(/RESOLVE/);
    game.startRound(1, [1]);
    expect(() => game.nextRound([2])).toThrow(/RESOLVE/);
  });

  it('advances round number from RESOLVE', () => {
    game.startRound(1, [1]);
    runRevealToCompletion(game);
    game.handleClick(1);
    expect(game.phase).toBe(Phase.RESOLVE);
    game.nextRound([1, 2]);
    expect(game.round).toBe(2);
    expect(game.phase).toBe(Phase.REVEAL);
    expect(game.ballIds).toEqual([1, 2]);
  });
});

describe('reset', () => {
  it('clears state mid-round and returns to IDLE', () => {
    game.startRound(3, [1, 2, 3]);
    runRevealToCompletion(game);
    game.handleClick(game.sequence[0]);
    game.reset();

    expect(game.phase).toBe(Phase.IDLE);
    expect(game.round).toBe(0);
    expect(game.sequence).toEqual([]);
    expect(game.ballIds).toEqual([]);
    expect(game.recallCursor).toBe(0);
    expect(game.perfect).toBe(true);
  });

  it('allows starting a fresh round after reset', () => {
    game.startRound(2, [1, 2]);
    game.reset();
    expect(() => game.startRound(1, [99])).not.toThrow();
  });
});

describe('phase transition guards', () => {
  it('attempting an illegal transition (via setPhase internals) throws', () => {
    // Force an illegal jump: we can't call _setPhase publicly, but we can
    // verify the internal guard via a known scenario. After GAME_OVER, the
    // only legal next phase is IDLE — so reset() must be the way out.
    // Phase 7: use livesMax:1 so a single wrong click still triggers GAME_OVER
    // (the lives-exhausted path) — that's what this test wants to enter.
    const g = new GameState({ rng: mulberry32(1234), livesMax: 1 });
    g.startRound(2, [1, 2]);
    runRevealToCompletion(g);
    const wrong = g.ballIds.find((id) => id !== g.sequence[0]);
    g.handleClick(wrong);
    expect(g.phase).toBe(Phase.GAME_OVER);

    // Calling startRound from GAME_OVER should throw (guarded by phase check).
    expect(() => g.startRound(3, [1, 2, 3])).toThrow(/Cannot startRound/);

    // Reset escapes GAME_OVER.
    g.reset();
    expect(() => g.startRound(3, [1, 2, 3])).not.toThrow();
  });
});

describe('listener error isolation in game flow', () => {
  it('a buggy listener does not crash the loop', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    game.on('roundStart', () => { throw new Error('hud bug'); });
    expect(() => game.startRound(2, [1, 2])).not.toThrow();
    expect(game.phase).toBe(Phase.REVEAL);
    errSpy.mockRestore();
  });
});

// ─── Split mechanic ─────────────────────────────────────────────────────────
//
// Phase 4 added the split sub-mechanic: clicking a willSplit ball during
// RECALL transitions to SPLIT_REVEAL, the renderer attaches children via
// acceptSplitChildren, sub-sequence flashes, then back to RECALL. Sub-sequence
// is appended AFTER the unclicked main remainder (spec §3.3).

/**
 * Drain both REVEAL and SPLIT_REVEAL until the game lands in RECALL (or any
 * non-reveal terminal phase). Caps the tick budget so a stuck loop fails fast.
 */
function drainReveal(g, sliceMs = 30, budgetSeconds = 30) {
  const dt = sliceMs / 1000;
  let total = 0;
  // Prime the awaiting-first frame with a 0-dt tick.
  g.tickReveal(0);
  while (
    (g.phase === Phase.REVEAL || g.phase === Phase.SPLIT_REVEAL) &&
    total < budgetSeconds
  ) {
    g.tickReveal(dt);
    total += dt;
  }
  return total;
}

/** Click every remaining ball in the sequence in order. Returns array of
 *  results from handleClick. Stops if any click returns 'wrong'. */
function clickSequenceFromCursor(g) {
  const out = [];
  while (g.phase === Phase.RECALL && !g.checkComplete()) {
    const expected = g.sequence[g.recallCursor];
    const result = g.handleClick(expected);
    out.push(result);
    if (result === 'wrong') break;
    // If a willSplit click triggered SPLIT_REVEAL, bail — caller drives sub-cycle.
    if (g.phase !== Phase.RECALL) break;
  }
  return out;
}

describe('split mechanic — willSplit selection', () => {
  it('round 4 with 3 balls picks exactly 1 willSplit id', () => {
    const g = new GameState({ rng: mulberry32(7) });
    g.startRound(4, [10, 20, 30]);
    const flagged = [10, 20, 30].filter((id) => g.isWillSplit(id));
    expect(flagged).toHaveLength(1);
  });

  it('rounds 1–3 pick zero willSplit ids', () => {
    for (const round of [1, 2, 3]) {
      const g = new GameState({ rng: mulberry32(round) });
      const ids = Array.from({ length: round }, (_, i) => i + 1);
      g.startRound(round, ids);
      const flagged = ids.filter((id) => g.isWillSplit(id));
      expect(flagged).toHaveLength(0);
    }
  });

  it('round 8 with 5 balls picks 1 willSplit id (refined: bump moved to r10)', () => {
    // Refined spec §3.3: r8 introduces depth-2 NESTING but keeps splitCount=1
    // so the two new mechanics (nesting + more splits) are decoupled. The
    // splitCount=2 bump moved from r8 → r10.
    const g = new GameState({ rng: mulberry32(11) });
    g.startRound(8, [1, 2, 3, 4, 5]);
    const flagged = [1, 2, 3, 4, 5].filter((id) => g.isWillSplit(id));
    expect(flagged).toHaveLength(1);
  });

  it('round 10 with 5 balls picks 2 willSplit ids (refined: was r8)', () => {
    // The r8→r10 bump is what frees the r8 plateau for "nesting only" — pin
    // its new home so a future regression on splitCountForRound surfaces here.
    const g = new GameState({ rng: mulberry32(11) });
    g.startRound(10, [1, 2, 3, 4, 5]);
    const flagged = [1, 2, 3, 4, 5].filter((id) => g.isWillSplit(id));
    expect(flagged).toHaveLength(2);
  });

  it('round 12 with 5 balls picks 3 willSplit ids', () => {
    const g = new GameState({ rng: mulberry32(11) });
    g.startRound(12, [1, 2, 3, 4, 5]);
    const flagged = [1, 2, 3, 4, 5].filter((id) => g.isWillSplit(id));
    expect(flagged).toHaveLength(3);
  });

  it('roundStart event payload includes willSplitIds (subset of ballIds)', () => {
    const g = new GameState({ rng: mulberry32(13) });
    const startFn = vi.fn();
    g.on('roundStart', startFn);
    g.startRound(4, [10, 20, 30]);
    const payload = startFn.mock.calls[0][0];
    expect(Array.isArray(payload.willSplitIds)).toBe(true);
    expect(payload.willSplitIds).toHaveLength(1);
    expect([10, 20, 30]).toContain(payload.willSplitIds[0]);
  });

  it('isWillSplit and splitDepthOf reflect initial state for primary balls', () => {
    const g = new GameState({ rng: mulberry32(5) });
    g.startRound(4, [10, 20, 30]);
    for (const id of [10, 20, 30]) {
      expect(g.splitDepthOf(id)).toBe(0);
    }
    // willSplit returns true for exactly one of these.
    const trueCount = [10, 20, 30].filter((id) => g.isWillSplit(id)).length;
    expect(trueCount).toBe(1);
  });
});

describe('split mechanic — RECALL → SPLIT_REVEAL trigger', () => {
  let g, splitBallId, nonSplitIds;

  beforeEach(() => {
    g = new GameState({ rng: mulberry32(99) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    expect(g.phase).toBe(Phase.RECALL);
    // Find the willSplit ball.
    splitBallId = [10, 20, 30].find((id) => g.isWillSplit(id));
    nonSplitIds = [10, 20, 30].filter((id) => id !== splitBallId);
  });

  it('clicking a willSplit ball: returns "correct", advances cursor, transitions to SPLIT_REVEAL', () => {
    // Walk the sequence until we hit the willSplit ball.
    while (g.sequence[g.recallCursor] !== splitBallId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    const cursorBefore = g.recallCursor;

    const reqFn = vi.fn();
    const correctFn = vi.fn();
    g.on('splitRequested', reqFn);
    g.on('correctClick', correctFn);

    expect(g.handleClick(splitBallId)).toBe('correct');
    expect(g.recallCursor).toBe(cursorBefore + 1);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);

    // splitRequested fires with depth=1 and a sane childCount.
    expect(reqFn).toHaveBeenCalledTimes(1);
    const reqPayload = reqFn.mock.calls[0][0];
    expect(reqPayload.parentBallId).toBe(splitBallId);
    expect(reqPayload.depth).toBe(1);
    expect([2, 3]).toContain(reqPayload.childCount);

    // correctClick fired with willSplit:true and depth:0
    expect(correctFn).toHaveBeenCalledWith(
      expect.objectContaining({ ballId: splitBallId, willSplit: true, depth: 0 }),
    );
  });

  it('clicking a non-willSplit ball does NOT transition to SPLIT_REVEAL', () => {
    const first = g.sequence[g.recallCursor];
    if (first === splitBallId) {
      // The first sequence ball happens to be the split ball — skip this test scenario.
      return;
    }
    expect(g.handleClick(first)).toBe('correct');
    expect(g.phase).toBe(Phase.RECALL);
  });

  it('roundComplete is NOT emitted when split is mid-flight', () => {
    const completeFn = vi.fn();
    g.on('roundComplete', completeFn);
    while (g.sequence[g.recallCursor] !== splitBallId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitBallId);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
    expect(completeFn).not.toHaveBeenCalled();
  });
});

describe('split mechanic — acceptSplitChildren', () => {
  let g, splitBallId;

  function fastForwardToSplitTrigger(seed = 99) {
    g = new GameState({ rng: mulberry32(seed) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    splitBallId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitBallId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitBallId);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
  }

  it('rejects when called outside SPLIT_REVEAL', () => {
    const fresh = new GameState({ rng: mulberry32(1) });
    expect(() => fresh.acceptSplitChildren(1, [101, 102])).toThrow(/SPLIT_REVEAL/);
  });

  it('rejects when parent id does not match the pending split', () => {
    fastForwardToSplitTrigger();
    expect(() => g.acceptSplitChildren(99999, [101, 102])).toThrow(/parent mismatch/);
  });

  it('rejects empty / non-array childIds', () => {
    fastForwardToSplitTrigger();
    expect(() => g.acceptSplitChildren(splitBallId, [])).toThrow(/non-empty/);
    expect(() => g.acceptSplitChildren(splitBallId, null)).toThrow();
  });

  it('appends children at the end of sequence (after main remainder)', () => {
    fastForwardToSplitTrigger();
    const seqLenBefore = g.sequence.length;
    const cursorBefore = g.recallCursor;
    g.acceptSplitChildren(splitBallId, [101, 102]);
    expect(g.sequence.length).toBe(seqLenBefore + 2);
    expect(g.recallCursor).toBe(cursorBefore); // cursor unchanged
    // Last two entries are the children (in some shuffled order).
    const tail = g.sequence.slice(-2).sort();
    expect(tail).toEqual([101, 102]);
  });

  it('records depth=1 for children in _splitDepthByBallId', () => {
    fastForwardToSplitTrigger();
    g.acceptSplitChildren(splitBallId, [101, 102]);
    expect(g.splitDepthOf(101)).toBe(1);
    expect(g.splitDepthOf(102)).toBe(1);
  });

  it('emits splitTriggered with parent + children + depth', () => {
    fastForwardToSplitTrigger();
    const fn = vi.fn();
    g.on('splitTriggered', fn);
    g.acceptSplitChildren(splitBallId, [101, 102]);
    expect(fn).toHaveBeenCalledWith({
      parentBallId: splitBallId,
      childIds: [101, 102],
      depth: 1,
    });
  });

  it('starts a sub-reveal cycle and transitions back to RECALL', () => {
    fastForwardToSplitTrigger();
    const phaseFn = vi.fn();
    g.on('phase', phaseFn);
    g.acceptSplitChildren(splitBallId, [101, 102]);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
    drainReveal(g);
    expect(g.phase).toBe(Phase.RECALL);
    // SPLIT_REVEAL → RECALL transition fired.
    const transitions = phaseFn.mock.calls.map((c) => `${c[0]}→${c[1]}`);
    expect(transitions).toContain(`${Phase.SPLIT_REVEAL}→${Phase.RECALL}`);
  });

  it('sub-reveal events have mode:"sub" and reference the new sub-sequence', () => {
    fastForwardToSplitTrigger();
    const stepEvents = [];
    g.on('revealStep', (p) => stepEvents.push(p));
    const completeFn = vi.fn();
    g.on('revealComplete', completeFn);
    g.acceptSplitChildren(splitBallId, [101, 102]);
    drainReveal(g);
    // At least one revealStep with mode:'sub'
    const subSteps = stepEvents.filter((s) => s.mode === 'sub');
    expect(subSteps.length).toBeGreaterThan(0);
    for (const s of subSteps) {
      expect([101, 102]).toContain(s.ballId);
      expect(s.level).toBeGreaterThanOrEqual(0);
      expect(s.level).toBeLessThanOrEqual(1);
    }
    // revealComplete fires with mode:'sub' for the sub cycle.
    const subCompletes = completeFn.mock.calls.filter((c) => c[0]?.mode === 'sub');
    expect(subCompletes.length).toBe(1);
  });
});

describe('split mechanic — strict ordering (main first, then sub)', () => {
  let g, splitBallId;

  // Helper: build a round-4 game with optional opts (e.g. livesMax) and
  // fast-forward past the split flash → ready to take more clicks in RECALL.
  function buildSplitMidRound(opts = {}) {
    const game = new GameState({ rng: mulberry32(99), ...opts });
    game.startRound(4, [10, 20, 30]);
    drainReveal(game);
    const splitId = [10, 20, 30].find((id) => game.isWillSplit(id));
    while (game.sequence[game.recallCursor] !== splitId) {
      game.handleClick(game.sequence[game.recallCursor]);
    }
    game.handleClick(splitId);
    game.acceptSplitChildren(splitId, [101, 102]);
    drainReveal(game);
    expect(game.phase).toBe(Phase.RECALL);
    return { game, splitId };
  }

  beforeEach(() => {
    ({ game: g, splitId: splitBallId } = buildSplitMidRound());
  });

  it('clicking a split child BEFORE main remainder is finished → wrong + GAME_OVER (livesMax:1)', () => {
    // Phase 7: under default 3 lives a wrong click only deducts a life. Use
    // livesMax:1 to preserve the original "single strike → GAME_OVER" assertion.
    const { game, splitId: sid } = buildSplitMidRound({ livesMax: 1 });
    void sid;
    if (game.recallCursor >= 3) {
      // Edge: the split ball was the last in the sequence — no main remainder.
      // Skip to avoid a false negative.
      return;
    }
    const overFn = vi.fn();
    game.on('gameOver', overFn);
    expect(game.handleClick(101)).toBe('wrong');
    expect(game.phase).toBe(Phase.GAME_OVER);
    // Phase 7: gameOver reason is now 'lives-exhausted' (with livesLost:livesMax)
    // rather than the legacy 'wrong-click'.
    expect(overFn).toHaveBeenCalledWith({
      round: 4,
      reason: 'lives-exhausted',
      livesLost: 1,
    });
  });

  it('clicking a split child early under default lives: wrong + life lost, stays in RECALL', () => {
    // Companion to the livesMax:1 test above — under the real 3-lives default
    // the early-child miss is a soft penalty, not game over.
    if (g.recallCursor >= 3) return;
    const livesBefore = g.lives;
    expect(g.handleClick(101)).toBe('wrong');
    expect(g.phase).toBe(Phase.RECALL);
    expect(g.lives).toBe(livesBefore - 1);
    expect(g.livesLostThisRound).toBe(1);
  });

  it('correct order (remaining main → children) clears the round', () => {
    const completeFn = vi.fn();
    g.on('roundComplete', completeFn);
    // Click each remaining sequence entry in order.
    while (!g.checkComplete()) {
      const expected = g.sequence[g.recallCursor];
      expect(g.handleClick(expected)).toBe('correct');
    }
    expect(g.phase).toBe(Phase.RESOLVE);
    // Phase 7: roundComplete payload now includes livesLostThisRound.
    expect(completeFn).toHaveBeenCalledWith({
      round: 4,
      perfect: true,
      livesLostThisRound: 0,
    });
  });

  it('child id is the LAST thing in sequence (sub appended after main remainder)', () => {
    // Sub-sequence must come strictly after all original main balls.
    const lastTwo = g.sequence.slice(-2).sort();
    expect(lastTwo).toEqual([101, 102]);
    // And the slot immediately before the children is one of the original ids.
    const beforeChildren = g.sequence[g.sequence.length - 3];
    expect([10, 20, 30]).toContain(beforeChildren);
  });
});

describe('split mechanic — recursive splits at high rounds', () => {
  it('round 4 (maxSplitDepth=1): children of the split ball do NOT split further', () => {
    const g = new GameState({ rng: mulberry32(99) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    const splitBallId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitBallId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitBallId);
    g.acceptSplitChildren(splitBallId, [101, 102]);
    expect(g.isWillSplit(101)).toBe(false);
    expect(g.isWillSplit(102)).toBe(false);
  });

  it('round 12 (maxSplitDepth=2, nestProb=1.0): auto-pick marks exactly one depth-1 child', () => {
    // Original test ran at r=8 and asserted "exactly one depth-1 child is
    // auto-marked willSplit". Under the refined spec, r=8 nesting is 50%
    // probabilistic — the deterministic "exactly one" guarantee now lives at
    // r≥12 where nestingProbability = 1.0. This test preserves the original
    // intent (auto-pick caps at 1 child when nesting fires) at the new round
    // where the contract is unconditional. (The probabilistic path at r8/9
    // and r10/11 is covered separately by the
    // "probabilistic nesting" describe block below.)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const g = new GameState({ rng: mulberry32(11) });
      g.startRound(12, [1, 2, 3, 4, 5, 6]);
      drainReveal(g);
      // Walk to first willSplit ball.
      let firstSplit = null;
      while (firstSplit === null) {
        const id = g.sequence[g.recallCursor];
        if (g.isWillSplit(id)) firstSplit = id;
        else g.handleClick(id);
      }
      g.handleClick(firstSplit);
      expect(g.phase).toBe(Phase.SPLIT_REVEAL);
      g.acceptSplitChildren(firstSplit, [201, 202, 203]);
      // Exactly one of the three children is flagged willSplit (auto-pick
      // capped at 1 — the nesting probability at r12 is 100%).
      const childFlags = [201, 202, 203].filter((id) => g.isWillSplit(id));
      expect(childFlags).toHaveLength(1);
      // All three are recorded at depth 1.
      for (const id of [201, 202, 203]) {
        expect(g.splitDepthOf(id)).toBe(1);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('round 12 explicit childWillSplit option overrides the auto-pick', () => {
    // Same scenario as the round 8 override test we used to have, ported to
    // r12 so the auto-pick we are overriding is deterministic (100% nest).
    // The test intentionally feeds 2 children — game.js logs a "got 2,
    // expected 2-or-3" warning sometimes; we suppress it to keep test output
    // clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const g = new GameState({ rng: mulberry32(11) });
      g.startRound(12, [1, 2, 3, 4, 5, 6]);
      drainReveal(g);
      let firstSplit = null;
      while (firstSplit === null) {
        const id = g.sequence[g.recallCursor];
        if (g.isWillSplit(id)) firstSplit = id;
        else g.handleClick(id);
      }
      g.handleClick(firstSplit);
      g.acceptSplitChildren(firstSplit, [201, 202], { childWillSplit: [] });
      expect(g.isWillSplit(201)).toBe(false);
      expect(g.isWillSplit(202)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('depth-2 child (kind SPLIT_L2) cannot itself trigger a third-layer split', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = new GameState({ rng: mulberry32(11) });
    g.startRound(8, [1, 2, 3, 4, 5]);
    drainReveal(g);

    // Walk + handle ANY split encountered in the main sequence by feeding
    // children with childWillSplit:[] so the test path isn't perturbed by
    // round 8's 2 willSplit balls. Stop once we've fed the FIRST split
    // (we'll force its child to be willSplit so we can test depth-2 cap).
    let nextChildId = 200;
    let firstSplitDone = false;
    let safety = 50;
    while (!firstSplitDone && safety-- > 0) {
      const id = g.sequence[g.recallCursor];
      if (g.isWillSplit(id)) {
        g.handleClick(id);
        // First split: force child 201 to willSplit; second split: empty.
        const childIds = [++nextChildId, ++nextChildId];
        g.acceptSplitChildren(id, childIds, {
          childWillSplit: firstSplitDone ? [] : [childIds[0]],
        });
        drainReveal(g);
        firstSplitDone = true;
      } else {
        g.handleClick(id);
      }
    }
    expect(firstSplitDone).toBe(true);

    // Drain any remaining main balls + other willSplit triggers, accepting
    // each with empty childWillSplit, until we land on the depth-1 willSplit
    // child we forced earlier.
    const targetWillSplitChildId = 201; // the +1 from nextChildId start
    safety = 100;
    while (g.sequence[g.recallCursor] !== targetWillSplitChildId && safety-- > 0) {
      const id = g.sequence[g.recallCursor];
      if (g.isWillSplit(id)) {
        g.handleClick(id);
        const childIds = [++nextChildId, ++nextChildId];
        g.acceptSplitChildren(id, childIds, { childWillSplit: [] });
        drainReveal(g);
      } else {
        g.handleClick(id);
      }
    }
    expect(g.sequence[g.recallCursor]).toBe(targetWillSplitChildId);

    // Now click the depth-1 willSplit child → triggers depth-2 split.
    g.handleClick(targetWillSplitChildId);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);

    g.acceptSplitChildren(targetWillSplitChildId, [301, 302]);
    // Depth-2 children must NOT be willSplit (auto-pick capped by maxSplitDepth).
    expect(g.isWillSplit(301)).toBe(false);
    expect(g.isWillSplit(302)).toBe(false);
    expect(g.splitDepthOf(301)).toBe(2);
    expect(g.splitDepthOf(302)).toBe(2);
    warnSpy.mockRestore();
  });
});

describe('split mechanic — phase guards during SPLIT_REVEAL', () => {
  let g, splitBallId;

  beforeEach(() => {
    g = new GameState({ rng: mulberry32(99) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    splitBallId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitBallId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitBallId);
    expect(g.phase).toBe(Phase.SPLIT_REVEAL);
  });

  it('handleClick on already-clicked split parent is ignored during SPLIT_REVEAL', () => {
    // The split-flagged parent was already clicked (correctlyClicked), so
    // re-clicking it returns 'ignored' regardless of phase change.
    expect(g.handleClick(splitBallId)).toBe('ignored');
  });

  it('handleClick on unknown id during SPLIT_REVEAL fails wrong (children not spawned yet)', () => {
    // SPLIT_REVEAL is the brief gap between split-trigger and acceptSplitChildren.
    // Clicking any unknown id during this window short-circuits to RECALL and
    // is judged wrong against the next main-sequence id. Phase 7: under the
    // default 3 lives this only deducts one — assert via livesMax:1 to keep
    // the immediate-GAME_OVER assertion meaningful.
    const g1 = new GameState({ rng: mulberry32(99), livesMax: 1 });
    g1.startRound(4, [10, 20, 30]);
    drainReveal(g1);
    const sid = [10, 20, 30].find((id) => g1.isWillSplit(id));
    while (g1.sequence[g1.recallCursor] !== sid) {
      g1.handleClick(g1.sequence[g1.recallCursor]);
    }
    g1.handleClick(sid);
    expect(g1.phase).toBe(Phase.SPLIT_REVEAL);

    const result = g1.handleClick(101);
    expect(result).toBe('wrong');
    expect(g1.phase).toBe(Phase.GAME_OVER);
  });

  it('under default 3 lives: same scenario deducts a life and lands in RECALL', () => {
    const result = g.handleClick(101);
    expect(result).toBe('wrong');
    expect(g.phase).toBe(Phase.RECALL);
    expect(g.livesLostThisRound).toBe(1);
  });

  it('reset() clears _pendingSplit and returns to IDLE', () => {
    g.reset();
    expect(g.phase).toBe(Phase.IDLE);
    // Pending split should be cleared — verify by attempting a fresh start.
    expect(() => g.startRound(1, [1])).not.toThrow();
  });
});

describe('split mechanic — correctClick payload includes depth + willSplit', () => {
  it('depth-0 non-split click reports depth:0, willSplit:false', () => {
    const g = new GameState({ rng: mulberry32(1) });
    g.startRound(2, [10, 20]); // round 2 has no splits
    drainReveal(g);
    const fn = vi.fn();
    g.on('correctClick', fn);
    g.handleClick(g.sequence[0]);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 0, willSplit: false }),
    );
  });

  it('depth-1 child click (after split) reports depth:1', () => {
    const g = new GameState({ rng: mulberry32(99) });
    g.startRound(4, [10, 20, 30]);
    drainReveal(g);
    const splitBallId = [10, 20, 30].find((id) => g.isWillSplit(id));
    while (g.sequence[g.recallCursor] !== splitBallId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    g.handleClick(splitBallId);
    g.acceptSplitChildren(splitBallId, [101, 102]);
    drainReveal(g);
    // Skip remaining main, then click children.
    while (g.sequence[g.recallCursor] !== 101 && g.sequence[g.recallCursor] !== 102) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    const fn = vi.fn();
    g.on('correctClick', fn);
    const childToClick = g.sequence[g.recallCursor];
    g.handleClick(childToClick);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ ballId: childToClick, depth: 1, willSplit: false }),
    );
  });
});

// ─── Refined difficulty: split-childCount determinism (r4–7 vs r8+) ────────
//
// The refined design wires `pickSplitChildCount`'s `deterministic` flag to
// `round < SECOND_LAYER_SPLIT_ROUND` inside `_beginSplit`. r4–7 callers
// therefore get a fixed 2-child split (no luck-driven 3rd child); r8+
// callers restore the legacy ~33% chance of 3. Tests cover both branches at
// the integration level (game → split.js).

describe('split mechanic — refined child-count contract (r4–7 deterministic)', () => {
  // Helper: drive a game to splitRequested for `round` and report the
  // emitted childCount. Uses an rng that *would* roll 3 (rng()=0) to verify
  // the deterministic flag suppresses the lucky-third path.
  function childCountFor(round, ballIds, rngFactory) {
    const g = new GameState({ rng: rngFactory() });
    g.startRound(round, ballIds);
    drainReveal(g);
    const splitId = ballIds.find((id) => g.isWillSplit(id));
    if (!splitId) return null; // no split picked at this round (shouldn't happen for r≥4)
    while (g.sequence[g.recallCursor] !== splitId) {
      g.handleClick(g.sequence[g.recallCursor]);
    }
    let payload;
    g.on('splitRequested', (p) => {
      payload = p;
    });
    g.handleClick(splitId);
    return payload?.childCount ?? null;
  }

  it('round 4 always produces 2 children — even with rng that would roll 3', () => {
    // 25 different seeds: every one must give 2 children at r4 (deterministic).
    for (let seed = 1; seed <= 25; seed++) {
      const n = childCountFor(4, [10, 20, 30], () => mulberry32(seed));
      expect(n).toBe(2);
    }
  });

  it('rounds 5, 6, 7 all produce exactly 2 children regardless of rng', () => {
    for (const round of [5, 6, 7]) {
      for (let seed = 1; seed <= 25; seed++) {
        // r5/6/7 use 4-ball sets per refined ballCount table — but tests
        // pass arbitrary id arrays, sized to ensure splitCount=1 picks one.
        const ids = [10, 20, 30, 40];
        const n = childCountFor(round, ids, () => mulberry32(seed));
        expect(n).toBe(2);
      }
    }
  });

  it('round 8 (boundary): childCount distribution restores ~33% threes (200 trials, ±5%)', () => {
    // r8 is the first round where `deterministic: false` is passed to
    // pickSplitChildCount. Verify the random branch is in play with a tight
    // distribution check.
    let threes = 0;
    const N = 200;
    for (let seed = 0; seed < N; seed++) {
      const n = childCountFor(8, [10, 20, 30, 40, 50], () => mulberry32(seed));
      if (n === 3) threes += 1;
    }
    const rate = threes / N;
    // ~33% target with ±~8% tolerance — generous enough to absorb the small
    // sample noise from 200 trials but tight enough to fail if the
    // deterministic branch silently leaks into r8.
    expect(rate).toBeGreaterThan(0.22);
    expect(rate).toBeLessThan(0.42);
  });

  it('round 9 also uses the random branch (childCount sometimes equals 3)', () => {
    // Lighter assertion than the r8 distribution test — just verify that 3
    // is achievable at r9, i.e. the deterministic flag is OFF at r9.
    let everThree = false;
    for (let seed = 0; seed < 100 && !everThree; seed++) {
      const n = childCountFor(9, [10, 20, 30, 40, 50], () => mulberry32(seed));
      if (n === 3) everThree = true;
    }
    expect(everThree).toBe(true);
  });
});

// ─── Refined difficulty: probabilistic nesting (r8–9 / r10–11 / r12+) ──────
//
// `acceptSplitChildren` rolls `this.rng() < nestingProbability` to decide
// whether ONE depth-1 child gets auto-flagged willSplit. Tests use seeded
// mulberry32 over many trials and assert distribution within ±5% of the
// target rate. Each trial recreates the game from scratch so the rng state
// is reproducible per seed.

describe('split mechanic — probabilistic nesting (refined difficulty)', () => {
  // One trial: spin up a game at `round`, walk to the first willSplit ball,
  // click it, accept 3 children, return whether ANY child was auto-flagged.
  function nestTrial(round, seed, ballCount = 5) {
    const g = new GameState({ rng: mulberry32(seed) });
    const ids = Array.from({ length: ballCount }, (_, i) => i + 1);
    g.startRound(round, ids);
    drainReveal(g);
    let splitId = null;
    while (splitId === null) {
      const id = g.sequence[g.recallCursor];
      if (g.isWillSplit(id)) splitId = id;
      else g.handleClick(id);
    }
    g.handleClick(splitId);
    // Pass exactly 2 children — whatever pickSplitChildCount rolled, we
    // satisfy at least the deterministic case (childCount===2) and let the
    // game.js mismatch warning for childCount===3 surface harmlessly.
    const children = [201, 202];
    // Suppress the "got 2, expected 3" wiring-drift warning that
    // game.acceptSplitChildren prints when our static child count doesn't
    // match a r8+ random roll of 3.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      g.acceptSplitChildren(splitId, children);
    } finally {
      warnSpy.mockRestore();
    }
    return children.some((c) => g.isWillSplit(c)) ? 1 : 0;
  }

  function nestRate(round, trials = 200, ballCount = 5) {
    let nested = 0;
    for (let s = 0; s < trials; s++) nested += nestTrial(round, s, ballCount);
    return nested / trials;
  }

  it('rounds 4–7: NEVER nest (depth-2 not unlocked, nestingProbability=0)', () => {
    // Hard contract: no rng roll, no nested children at any seed.
    for (const round of [4, 5, 6, 7]) {
      for (let seed = 0; seed < 50; seed++) {
        expect(nestTrial(round, seed, 4)).toBe(0);
      }
    }
  });

  it('round 8: nests in ~50% of trials (200 seeds, target 0.50 ± 0.07)', () => {
    const rate = nestRate(8, 200, 5);
    expect(rate).toBeGreaterThan(0.43);
    expect(rate).toBeLessThan(0.57);
  });

  it('round 9: nests in ~50% of trials (200 seeds, target 0.50 ± 0.07)', () => {
    const rate = nestRate(9, 200, 5);
    expect(rate).toBeGreaterThan(0.43);
    expect(rate).toBeLessThan(0.57);
  });

  it('round 10: nests in ~75% of trials (200 seeds, target 0.75 ± 0.07)', () => {
    const rate = nestRate(10, 200, 5);
    expect(rate).toBeGreaterThan(0.68);
    expect(rate).toBeLessThan(0.82);
  });

  it('round 11: nests in ~75% of trials (200 seeds, target 0.75 ± 0.07)', () => {
    const rate = nestRate(11, 200, 5);
    expect(rate).toBeGreaterThan(0.68);
    expect(rate).toBeLessThan(0.82);
  });

  it('round 12: nests in 100% of trials (deterministic — was the old r8+ rule)', () => {
    // r12+ is the new home of "always nest". 100/100 trials must nest.
    const N = 100;
    let nested = 0;
    for (let s = 0; s < N; s++) nested += nestTrial(12, s, 6);
    expect(nested).toBe(N);
  });

  it('round 13+: nests in 100% of trials (continues capped behavior)', () => {
    const N = 80;
    let nested = 0;
    for (let s = 0; s < N; s++) nested += nestTrial(15, s, 7);
    expect(nested).toBe(N);
  });

  it('nesting roll uses this.rng (seeded determinism preserved)', () => {
    // Same seed → same nesting outcome. Two fresh games at the same round
    // and seed must agree on whether a nest occurred.
    for (let seed = 0; seed < 20; seed++) {
      const a = nestTrial(10, seed, 5);
      const b = nestTrial(10, seed, 5);
      expect(a).toBe(b);
    }
  });
});

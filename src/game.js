// Game state machine — pure logic, no Three.js.
//
// Drives reveal/recall/resolve cycles AND the split sub-mechanic. Emits
// events so the renderer + HUD can react without touching internals:
//
//   'phase'             (from, to)
//   'roundStart'        ({ round, sequence, ballIds, difficulty, willSplitIds })
//   'revealStep'        ({ index, ballId, level, mode })  // level∈[0,1] each tick
//   'revealStepEnd'     ({ index, ballId, mode })
//   'revealComplete'    ({ mode })
//   'correctClick'      ({ ballId, indexInSequence, depth, willSplit })
//   'wrongClick'        ({ ballId, expectedBallId, livesRemaining })
//   'lifeLost'          ({ ballId, expectedBallId, livesRemaining, livesLostThisRound })
//   'splitRequested'    ({ parentBallId, depth, childCount })
//   'splitTriggered'    ({ parentBallId, childIds, depth })  // after children attached
//   'roundComplete'     ({ round, perfect, livesLostThisRound })
//   'gameOver'          ({ round, reason, livesLost })
//
// Lives system (Phase 7):
//   - 3 lives at game start, persist across rounds (only reset() clears them).
//   - Wrong click decrements lives, fires 'lifeLost', does NOT advance the
//     cursor or shatter the ball — player can retry the same position.
//   - 500ms input cooldown after a wrong click; clicks during the cooldown
//     return 'cooldown' so the renderer can show a distinct "ignored" state.
//   - When lives reach 0, fires 'gameOver' with reason 'lives-exhausted'.
//   - Per-round livesLostThisRound counter — a round is "perfect" only with
//     zero lives lost; resets at startRound.
//
// Split mechanic:
//   1. startRound picks `splitCount` balls at random from the round's
//      population to be willSplit (depth 0 → depth 1 children).
//   2. When the player clicks a willSplit ball during RECALL, the game
//      emits 'splitRequested' and transitions RECALL → SPLIT_REVEAL.
//   3. The renderer (main.js) spawns the children and calls
//      acceptSplitChildren(parentId, childIds, [childWillSplit?]) to feed
//      them back. Their ids are appended to `sequence` AFTER the unclicked
//      portion of the main sequence (spec §3.3 — finish main first).
//   4. A faster sub-reveal cycle flashes the children's sub-sequence, then
//      transitions back to RECALL.
//   5. From round 8+, depth-1 children may themselves be willSplit
//      (capped at maxSplitDepth).

import { Emitter } from './events.js';
import { difficultyForRound, DIFFICULTY } from './difficulty.js';
import { pickWillSplit, pickSplitChildCount } from './split.js';

export const Phase = Object.freeze({
  IDLE: 'IDLE',
  REVEAL: 'REVEAL',
  RECALL: 'RECALL',
  SPLIT_REVEAL: 'SPLIT_REVEAL',
  RESOLVE: 'RESOLVE',
  GAME_OVER: 'GAME_OVER',
});

const VALID_TRANSITIONS = {
  [Phase.IDLE]: new Set([Phase.REVEAL]),
  // REVEAL can short-circuit to RECALL/SPLIT_REVEAL/RESOLVE/GAME_OVER when the
  // player clicks before the flash sequence finishes (impatient-player path).
  [Phase.REVEAL]: new Set([Phase.RECALL, Phase.SPLIT_REVEAL, Phase.RESOLVE, Phase.GAME_OVER]),
  [Phase.RECALL]: new Set([Phase.SPLIT_REVEAL, Phase.RESOLVE, Phase.GAME_OVER]),
  // Same for SPLIT_REVEAL — clicking on a child mid-sub-flash counts.
  [Phase.SPLIT_REVEAL]: new Set([Phase.RECALL, Phase.RESOLVE, Phase.GAME_OVER]),
  [Phase.RESOLVE]: new Set([Phase.REVEAL, Phase.GAME_OVER]),
  [Phase.GAME_OVER]: new Set([Phase.IDLE]),
};

/** Default RNG-backed shuffle. Returns a new array. */
function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class GameState extends Emitter {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.rng]              custom RNG for sequence shuffle
   * @param {() => number} [opts.now]              clock for cooldown timing
   *                                               (defaults to Date.now)
   * @param {number} [opts.livesMax]               starting/max lives (default 3)
   * @param {number} [opts.inputCooldownMs]        ms to ignore clicks after a
   *                                               wrong click (default 500)
   * @param {number} [opts.holdAfterReveal]        override pause after reveal
   * @param {number} [opts.subRevealSpeedup]       multiplier on flashDuration
   *                                               for sub-sequences (default 0.7)
   */
  constructor(opts = {}) {
    super();
    this.rng = opts.rng ?? Math.random;
    this._now = opts.now ?? (() => Date.now());
    this._holdAfterReveal =
      opts.holdAfterReveal ?? DIFFICULTY.HOLD_AFTER_REVEAL;
    this._subRevealSpeedup =
      opts.subRevealSpeedup ?? DIFFICULTY.SUB_SEQUENCE_SPEEDUP;

    // Lives system — persist across rounds, only cleared by reset().
    this.livesMax = Number.isFinite(opts.livesMax) ? opts.livesMax : 3;
    this.lives = this.livesMax;
    this.inputCooldownMs = Number.isFinite(opts.inputCooldownMs)
      ? opts.inputCooldownMs
      : 500;
    /** Wall-clock timestamp until which clicks return 'cooldown'. */
    this._cooldownUntil = 0;
    /** Per-round lives-lost counter. Resets on startRound (NOT on reset()). */
    this.livesLostThisRound = 0;

    this.phase = Phase.IDLE;
    this.round = 0;

    /** @type {Array<number>} ball ids currently on the board */
    this.ballIds = [];
    /** @type {Array<number>} ball ids in the order the player must click */
    this.sequence = [];
    /** Index of the next ball the player needs to click. */
    this.recallCursor = 0;

    /** Set of ballIds successfully clicked this round. */
    this.correctlyClicked = new Set();
    /** Whether any wrong click has happened this round. */
    this.perfect = true;

    /** @type {Set<number>} ids that will split when clicked this round */
    this._willSplitIds = new Set();
    /** @type {Map<number, number>} ballId → split depth (0 primary, 1+ children) */
    this._splitDepthByBallId = new Map();

    /** While SPLIT_REVEAL is awaiting acceptSplitChildren, holds the trigger. */
    this._pendingSplit = null;

    // Reveal-phase ticker state — used for both main REVEAL and SPLIT_REVEAL.
    this._reveal = null;
    this._difficulty = null;
  }

  // ─── public API ───────────────────────────────────────────────────────

  /** Begin a round. Caller is responsible for spawning the actual Ball meshes. */
  startRound(round, ballIds) {
    if (!Number.isInteger(round) || round < 1) {
      throw new Error(`startRound requires round >= 1, got ${round}`);
    }
    if (!Array.isArray(ballIds) || ballIds.length === 0) {
      throw new Error('startRound requires a non-empty ballIds array');
    }
    if (this.phase !== Phase.IDLE && this.phase !== Phase.RESOLVE) {
      throw new Error(`Cannot startRound from phase ${this.phase}`);
    }
    this.round = round;
    this.ballIds = [...ballIds];
    this.sequence = this.generateSequence(ballIds);
    this.recallCursor = 0;
    this.correctlyClicked = new Set();
    this.perfect = true;
    // Lives PERSIST across rounds — but the per-round counter + any active
    // cooldown clear so a new round starts with a clean input window.
    this.livesLostThisRound = 0;
    this._cooldownUntil = 0;
    this._difficulty = difficultyForRound(round);
    this._splitDepthByBallId = new Map(ballIds.map((id) => [id, 0]));
    this._willSplitIds = pickWillSplit(
      ballIds,
      this._difficulty.splitCount,
      this.rng,
    );
    this._pendingSplit = null;
    this._beginRevealCycle({
      startIndex: 0,
      endIndex: this.sequence.length,
      flashDuration: this._difficulty.flashDuration,
      mode: 'main',
      onComplete: () => {
        // Player may have already clicked early — only flip phase if still
        // in REVEAL/SPLIT_REVEAL.
        if (this.phase === Phase.REVEAL || this.phase === Phase.SPLIT_REVEAL) {
          this._setPhase(Phase.RECALL);
        }
      },
    });

    this._setPhase(Phase.REVEAL);
    this.emit('roundStart', {
      round,
      sequence: [...this.sequence],
      ballIds: [...this.ballIds],
      difficulty: this._difficulty,
      willSplitIds: [...this._willSplitIds],
    });
  }

  /**
   * Shuffle ball ids into the order they'll flash.
   * Exposed so tests can verify "is a permutation".
   */
  generateSequence(ballIds) {
    return shuffle(ballIds, this.rng);
  }

  /**
   * Drive the reveal-phase clock. Caller passes a per-frame dt (seconds).
   * Handles both main REVEAL and SPLIT_REVEAL cycles.
   */
  tickReveal(dt) {
    // Allow ticking during RECALL too — when player clicks early, phase flips
    // to RECALL but the reveal animation should keep playing visually.
    if (
      this.phase !== Phase.REVEAL &&
      this.phase !== Phase.SPLIT_REVEAL &&
      this.phase !== Phase.RECALL
    ) {
      return;
    }
    if (!this._reveal) return;
    if (!Number.isFinite(dt) || dt < 0) return;

    const r = this._reveal;
    const flashDur = r.flashDuration;
    const gap = this._difficulty.gap;
    const stepDur = flashDur + gap;
    const sliceLen = r.endIndex - r.startIndex;

    // Lead-in: a brief pause before the first flash so the player can
    // visually register newly-spawned balls (sub-reveal use case).
    if (r.leadInDuration > 0 && r.leadIn < r.leadInDuration) {
      r.leadIn += dt;
      if (r.leadIn < r.leadInDuration) return;
    }

    // First tick of the cycle — emit a level=0 frame for step 0 so the
    // renderer can stage initial state, then start accumulating elapsed.
    if (r.awaitingFirst) {
      r.awaitingFirst = false;
      r.relativeIndex = 0;
      r.elapsed = 0;
      this._emitRevealStep(0);
      return;
    }

    if (r.relativeIndex < sliceLen) {
      r.elapsed += dt;

      if (r.elapsed >= stepDur) {
        this._emitRevealStepEnd(r.relativeIndex);
        r.relativeIndex += 1;
        r.elapsed = 0;
        if (r.relativeIndex < sliceLen) {
          this._emitRevealStep(r.relativeIndex);
        }
      } else {
        const phase = r.elapsed <= flashDur ? r.elapsed / flashDur : 0;
        this._emitRevealStep(r.relativeIndex, phase);
      }
      return;
    }

    // All steps shown — wait the post-reveal hold then transition.
    r.postHold += dt;
    if (r.postHold >= r.postHoldDuration) {
      const onComplete = r.onComplete;
      const mode = r.mode;

      // If a main reveal was suspended for a sub-reveal, resume it now and
      // skip the sub's onComplete (which would prematurely flip phase).
      if (mode === 'sub' && this._suspendedMainReveal) {
        this._reveal = this._suspendedMainReveal;
        this._suspendedMainReveal = null;
        this.emit('revealComplete', { mode });
        return;
      }

      this._reveal = null;
      this.emit('revealComplete', { mode });
      onComplete?.();
    }
  }

  /**
   * Player clicked a ball during RECALL. Returns one of:
   *   'correct'  — sequence advanced
   *   'wrong'    — life lost; cursor unchanged so player can retry the slot
   *   'cooldown' — within the post-wrong-click input cooldown window
   *   'ignored'  — wrong phase, invalid id, or already-clicked ball
   */
  handleClick(ballId) {
    // Accept clicks during REVEAL and SPLIT_REVEAL too — impatient-player path.
    // Clicking mid-flash auto-skips the rest of the reveal animation.
    if (
      this.phase !== Phase.RECALL &&
      this.phase !== Phase.REVEAL &&
      this.phase !== Phase.SPLIT_REVEAL
    ) {
      return 'ignored';
    }

    // Cooldown gate — distinct from 'ignored' so the renderer can show a
    // "calm down, breathe" cue rather than a generic no-op.
    if (this._cooldownUntil > 0 && this._now() < this._cooldownUntil) {
      return 'cooldown';
    }

    if (typeof ballId !== 'number' && typeof ballId !== 'string') return 'ignored';
    if (this.correctlyClicked.has(ballId)) return 'ignored';

    // If clicked during REVEAL/SPLIT_REVEAL, transition to RECALL so clicks are
    // accepted, but DON'T stop the reveal animation — let the remaining balls
    // continue flashing so the player can still memorise the pattern visually
    // while clicking along. The reveal ticker is allowed to fire on RECALL too
    // (see tickReveal — guard updated to permit RECALL while _reveal is live).
    if (this.phase === Phase.REVEAL || this.phase === Phase.SPLIT_REVEAL) {
      this._setPhase(Phase.RECALL);
      this.emit('revealSkipped', { phase: Phase.RECALL });
    }

    const expected = this.sequence[this.recallCursor];
    if (ballId !== expected) {
      // Wrong click: deduct a life, set cooldown, fire events.
      // Crucially DO NOT advance the cursor, mark correctlyClicked, or
      // shatter the ball — the renderer keeps the slot live so the player
      // can retry the same position once the cooldown expires.
      this.perfect = false;
      this.lives = Math.max(0, this.lives - 1);
      this.livesLostThisRound += 1;
      this._cooldownUntil = this._now() + this.inputCooldownMs;

      this.emit('wrongClick', {
        ballId,
        expectedBallId: expected,
        livesRemaining: this.lives,
      });
      this.emit('lifeLost', {
        ballId,
        expectedBallId: expected,
        livesRemaining: this.lives,
        livesLostThisRound: this.livesLostThisRound,
      });

      if (this.lives <= 0) {
        this._setPhase(Phase.GAME_OVER);
        this.emit('gameOver', {
          round: this.round,
          reason: 'lives-exhausted',
          livesLost: this.livesMax,
        });
      }
      return 'wrong';
    }

    this.correctlyClicked.add(ballId);
    const indexInSequence = this.recallCursor;
    this.recallCursor += 1;
    const depth = this._splitDepthByBallId.get(ballId) ?? 0;
    const willSplit = this._willSplitIds.has(ballId);
    this.emit('correctClick', {
      ballId,
      indexInSequence,
      depth,
      willSplit,
    });

    if (willSplit) {
      this._beginSplit(ballId, depth);
      return 'correct';
    }

    if (this.checkComplete()) {
      this._setPhase(Phase.RESOLVE);
      this.emit('roundComplete', {
        round: this.round,
        perfect: this.perfect,
        livesLostThisRound: this.livesLostThisRound,
      });
    }
    return 'correct';
  }

  /**
   * Renderer callback after responding to 'splitRequested'.
   * Attaches the freshly-spawned children to game state, schedules the
   * sub-sequence reveal, and transitions out of SPLIT_REVEAL → REVEAL → RECALL.
   *
   * @param {number|string} parentBallId
   * @param {Array<number|string>} childIds
   * @param {object} [opts]
   * @param {Array<number|string>} [opts.childWillSplit]
   *   subset of childIds that should themselves split when clicked. If omitted,
   *   the game decides based on round/maxSplitDepth.
   */
  acceptSplitChildren(parentBallId, childIds, opts = {}) {
    if (this.phase !== Phase.SPLIT_REVEAL) {
      throw new Error(
        `acceptSplitChildren only valid in SPLIT_REVEAL, got ${this.phase}`,
      );
    }
    if (!this._pendingSplit || this._pendingSplit.parentBallId !== parentBallId) {
      throw new Error(`acceptSplitChildren parent mismatch: ${parentBallId}`);
    }
    if (!Array.isArray(childIds) || childIds.length === 0) {
      throw new Error('acceptSplitChildren requires non-empty childIds');
    }
    // Sanity check: renderer should supply exactly the count we asked for.
    // We accept the supplied list either way (defensive — never crash mid-game)
    // but warn loudly so a wiring drift surfaces in development.
    const expectedCount = this._pendingSplit.childCount;
    if (childIds.length !== expectedCount) {
      console.warn(
        `[game] acceptSplitChildren got ${childIds.length} children, expected ${expectedCount} for parent ${parentBallId}`,
      );
    }

    const childDepth = this._pendingSplit.depth;
    for (const id of childIds) {
      this._splitDepthByBallId.set(id, childDepth);
      this.ballIds.push(id);
    }

    // Decide which children themselves will split.
    let willSplitChildren = opts.childWillSplit;
    if (willSplitChildren === undefined) {
      const nextDepth = childDepth + 1;
      if (nextDepth <= this._difficulty.maxSplitDepth && childIds.length > 0) {
        // Spec: at deeper rounds we get cascading splits — pick 1 child.
        const chosen = pickWillSplit(childIds, 1, this.rng);
        willSplitChildren = [...chosen];
      } else {
        willSplitChildren = [];
      }
    }
    for (const id of willSplitChildren) this._willSplitIds.add(id);

    // Sub-sequence flash order — shuffled so the player can't predict it.
    const subSequence = shuffle(childIds, this.rng);
    const subStartIndex = this.sequence.length;
    this.sequence.push(...subSequence);

    this._pendingSplit = null;
    this.emit('splitTriggered', {
      parentBallId,
      childIds: [...childIds],
      depth: childDepth,
    });

    // Begin the sub-reveal flash cycle. Faster than main, shorter hold.
    const subFlashDur = Math.max(
      this._difficulty.flashDuration * this._subRevealSpeedup,
      DIFFICULTY.MIN_FLASH * 0.6, // never below ~210ms — still readable
    );
    // Lead-in: short pause so the player can register the freshly-spawned
    // children before the first flash. Generous at the intro round (4) and
    // tightens with difficulty, floor 0.30s. Roughly tracks flashDuration.
    const leadIn = Math.max(0.6 - (this.round - 4) * 0.04, 0.30);
    this._beginRevealCycle({
      startIndex: subStartIndex,
      endIndex: this.sequence.length,
      flashDuration: subFlashDur,
      postHoldDuration: this._holdAfterReveal * 0.6,
      leadInDuration: leadIn,
      mode: 'sub',
      onComplete: () => {
        // Player may have already clicked early — only flip phase if still
        // in REVEAL/SPLIT_REVEAL.
        if (this.phase === Phase.REVEAL || this.phase === Phase.SPLIT_REVEAL) {
          this._setPhase(Phase.RECALL);
        }
      },
    });
  }

  /** True when the player has clicked every ball in the sequence. */
  checkComplete() {
    return this.recallCursor >= this.sequence.length;
  }

  /** Advance from RESOLVE → REVEAL with the next round's ballIds. */
  nextRound(ballIds) {
    if (this.phase !== Phase.RESOLVE) {
      throw new Error(`nextRound only valid from RESOLVE, got ${this.phase}`);
    }
    this.startRound(this.round + 1, ballIds);
  }

  /** Reset to IDLE so the player can replay. Also restores full lives. */
  reset() {
    this.phase = Phase.IDLE;
    this.round = 0;
    this.ballIds = [];
    this.sequence = [];
    this.recallCursor = 0;
    this.correctlyClicked = new Set();
    this.perfect = true;
    this._reveal = null;
    this._suspendedMainReveal = null;
    this._difficulty = null;
    this._willSplitIds = new Set();
    this._splitDepthByBallId = new Map();
    this._pendingSplit = null;
    // Lives ONLY reset on full game reset — they persist across rounds.
    this.lives = this.livesMax;
    this.livesLostThisRound = 0;
    this._cooldownUntil = 0;
  }

  /** Inspector for tests / HUD — does this ball split when clicked this round? */
  isWillSplit(ballId) {
    return this._willSplitIds.has(ballId);
  }

  /** Inspector for tests / HUD — split nesting depth of a known ball. */
  splitDepthOf(ballId) {
    return this._splitDepthByBallId.get(ballId) ?? 0;
  }

  // ─── internals ────────────────────────────────────────────────────────

  _beginSplit(parentBallId, parentDepth) {
    const childCount = pickSplitChildCount(parentDepth + 1, this.rng);
    this._pendingSplit = {
      parentBallId,
      depth: parentDepth + 1,
      childCount,
    };
    this._setPhase(Phase.SPLIT_REVEAL);
    this.emit('splitRequested', {
      parentBallId,
      depth: parentDepth + 1,
      childCount,
    });
  }

  _beginRevealCycle({
    startIndex,
    endIndex,
    flashDuration,
    postHoldDuration,
    leadInDuration = 0,
    mode,
    onComplete,
  }) {
    const cycle = {
      relativeIndex: -1,
      elapsed: 0,
      postHold: 0,
      leadIn: 0,
      leadInDuration,
      awaitingFirst: true,
      startIndex,
      endIndex,
      flashDuration,
      postHoldDuration: postHoldDuration ?? this._holdAfterReveal,
      mode,
      onComplete,
    };

    // If a sub-reveal starts while the main reveal hasn't finished its cycle,
    // suspend the main cycle and resume it after sub completes. Without this,
    // remaining main balls never flash again after a mid-reveal split.
    if (mode === 'sub' && this._reveal && this._reveal.mode === 'main') {
      this._suspendedMainReveal = this._reveal;
    }

    this._reveal = cycle;
  }

  _setPhase(next) {
    const prev = this.phase;
    if (prev === next) return;
    const allowed = VALID_TRANSITIONS[prev];
    if (!allowed || !allowed.has(next)) {
      throw new Error(`Illegal phase transition ${prev} → ${next}`);
    }
    this.phase = next;
    this.emit('phase', prev, next);
  }

  _emitRevealStep(relativeIndex, level = 0) {
    const r = this._reveal;
    const absoluteIndex = r.startIndex + relativeIndex;
    this.emit('revealStep', {
      index: relativeIndex,
      absoluteIndex,
      ballId: this.sequence[absoluteIndex],
      level: Math.max(0, Math.min(1, level)),
      mode: r.mode,
    });
  }

  _emitRevealStepEnd(relativeIndex) {
    const r = this._reveal;
    const absoluteIndex = r.startIndex + relativeIndex;
    this.emit('revealStepEnd', {
      index: relativeIndex,
      absoluteIndex,
      ballId: this.sequence[absoluteIndex],
      mode: r.mode,
    });
  }
}

// Scoring module — pure logic, no DOM or Three.js.
//
// Tracks per-round stats + a running total. Drives the Calm Index module
// via `getCalmStats()`. Can be driven by explicit calls (test/mock) or
// auto-attached to a GameState via `.attachToGame(game)`.
//
// Spec §5 reference values:
//   - 10 pts per correct PRIMARY click
//   - 20 pts per correct SPLIT (depth > 0) click — harder to remember
//   - +50 perfect-round bonus
//   - Streak multiplier: (1 + streak × 0.1), capped at 2.0
//   - Speed bonus: average reaction below threshold → +30% of round base
//   - One wrong click resets streak to 0

import { Emitter } from './events.js';

export const POINTS = Object.freeze({
  PRIMARY: 10,
  SPLIT_BALL: 20,
  PERFECT_BONUS: 50,
  SPEED_BONUS_PCT: 0.3,
  MAX_MULTIPLIER: 2.0,
  COMBO_PER_STREAK: 0.1,
  // Average ms-per-correct-click below this triggers the speed bonus.
  SPEED_THRESHOLD_MS: 700,
});

export class Scorer extends Emitter {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] inject a clock for deterministic tests
   */
  constructor(opts = {}) {
    super();
    this._now = opts.now ?? (() => Date.now());
    this.reset();
  }

  reset() {
    this.totalScore = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.roundsPlayed = 0;
    this.roundStats = []; // chronological history

    this._current = null;
    this._totalCorrect = 0;
    this._totalClicks = 0;
    this._totalReactionsMs = [];
    this._splitRoundsTotal = 0; // # of rounds that had a split happen
    this._splitRoundsPerfect = 0;
  }

  /** Begin tracking for a new round. */
  beginRound(round) {
    const t = this._now();
    this._current = {
      round,
      startTime: t,
      lastClickTime: t,
      correctClicks: 0,
      wrongClicks: 0,
      splitChildClicks: 0,
      reactionsMs: [],
      hadSplit: false,
      perfect: true,
      basePoints: 0,
    };
    this.emit('roundBegan', { round });
  }

  /**
   * Register a correct click. `depth` > 0 means clicking a split-child ball
   * (worth 20 pts). `willSplit` flags that this click triggers a split
   * (so the round counts as a "split round" for Composure scoring).
   */
  registerCorrectClick({ depth = 0, willSplit = false } = {}) {
    const r = this._current;
    if (!r) return 0;
    const t = this._now();
    r.reactionsMs.push(Math.max(0, t - r.lastClickTime));
    r.lastClickTime = t;
    r.correctClicks += 1;
    if (depth > 0) r.splitChildClicks += 1;
    if (willSplit) r.hadSplit = true;

    const points = depth > 0 ? POINTS.SPLIT_BALL : POINTS.PRIMARY;
    r.basePoints += points;
    this.totalScore += points;
    this.emit('score', { points, reason: depth > 0 ? 'split' : 'primary' });
    return points;
  }

  /** A wrong click resets perfect-streak status for the round. */
  registerWrongClick() {
    const r = this._current;
    if (!r) return;
    r.wrongClicks += 1;
    r.perfect = false;
    r.lastClickTime = this._now();
  }

  /** End the round, apply bonuses, and append to history. */
  finishRound() {
    const r = this._current;
    if (!r) return null;
    const t = this._now();
    r.endTime = t;
    r.elapsedMs = t - r.startTime;
    r.totalClicks = r.correctClicks + r.wrongClicks;
    r.avgReactionMs = r.reactionsMs.length
      ? r.reactionsMs.reduce((a, b) => a + b, 0) / r.reactionsMs.length
      : 0;

    let multiplier = 1;
    let perfectBonus = 0;
    let speedBonus = 0;

    if (r.perfect) {
      this.streak += 1;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      multiplier = Math.min(
        1 + this.streak * POINTS.COMBO_PER_STREAK,
        POINTS.MAX_MULTIPLIER,
      );
      perfectBonus = Math.round(POINTS.PERFECT_BONUS * multiplier);

      if (
        r.avgReactionMs > 0 &&
        r.avgReactionMs < POINTS.SPEED_THRESHOLD_MS &&
        r.basePoints > 0
      ) {
        speedBonus = Math.round(r.basePoints * POINTS.SPEED_BONUS_PCT);
      }
    } else {
      this.streak = 0;
    }

    r.multiplier = multiplier;
    r.perfectBonus = perfectBonus;
    r.speedBonus = speedBonus;
    r.streakAtEnd = this.streak;
    r.totalRoundScore = r.basePoints + perfectBonus + speedBonus;

    this.totalScore += perfectBonus + speedBonus;
    this.roundsPlayed += 1;
    this.roundStats.push(r);
    this._totalCorrect += r.correctClicks;
    this._totalClicks += r.totalClicks;
    this._totalReactionsMs.push(...r.reactionsMs);
    if (r.hadSplit) {
      this._splitRoundsTotal += 1;
      if (r.perfect) this._splitRoundsPerfect += 1;
    }

    this._current = null;
    this.emit('roundFinished', r);
    return r;
  }

  /** Aggregate stats consumed by the Calm Index module. */
  getCalmStats() {
    const reactions = this._totalReactionsMs;
    const avg = reactions.length
      ? reactions.reduce((a, b) => a + b, 0) / reactions.length
      : 0;
    return {
      totalClicks: this._totalClicks,
      correctClicks: this._totalCorrect,
      avgReactionMs: avg,
      splitRoundsTotal: this._splitRoundsTotal,
      splitRoundsPerfect: this._splitRoundsPerfect,
    };
  }

  /** Snapshot for HUD rendering. */
  getHudSnapshot() {
    return {
      totalScore: this.totalScore,
      streak: this.streak,
      bestStreak: this.bestStreak,
      roundsPlayed: this.roundsPlayed,
    };
  }

  /**
   * Wire this scorer to a GameState by subscribing to its events.
   * Returns the scorer for chaining.
   */
  attachToGame(game) {
    game.on('roundStart', ({ round }) => this.beginRound(round));
    game.on('correctClick', ({ depth, willSplit }) =>
      this.registerCorrectClick({ depth, willSplit }),
    );
    game.on('wrongClick', () => this.registerWrongClick());
    game.on('roundComplete', () => this.finishRound());
    return this;
  }
}

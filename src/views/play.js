// Play view — the actual game, mountable/unmountable.
//
// This is a refactor of the old src/main.js boot path. Mount creates a
// canvas + HUD inside the supplied container; unmount disposes everything
// (Three.js renderer + textures, balls, shatter system, HUD, feedback,
// listeners) so navigating between routes doesn't leak GPU memory.
//
// Phase 11 wires in the Game-Over → leaderboard flow:
//   - Score is saved to mock-data on game over.
//   - Game-Over panel shows two extra buttons: "View Leaderboard" + "Back to Menu"
//   - The auth gate (handled at router level) ensures only signed-in users
//     ever reach this view.

import { createScene } from '../scene.js';
import { Ball, BallKind } from '../ball.js';
import { generatePositions } from '../positions.js';
import { GameState, Phase } from '../game.js';
import { ballCountForRound } from '../difficulty.js';
import { ShatterEffect } from '../shatter.js';
import { childKindForDepth, generateChildPositions } from '../split.js';
import { Scorer } from '../scoring.js';
import { calmReport } from '../calm-index.js';
import { HUD } from '../ui.js';
import { Feedback } from '../feedback.js';
import { addScore } from '../mock-data.js';
import { navigate } from '../router.js';

let active = null;

export function mount(container) {
  if (active) {
    // Defensive: if a previous instance somehow lingered, tear it down first.
    active.unmount();
  }

  // ── DOM scaffolding ────────────────────────────────────────────────────
  const canvasMount = document.createElement('div');
  canvasMount.className = 'play__canvas';
  canvasMount.setAttribute('role', 'application');
  canvasMount.setAttribute(
    'aria-label',
    'Zen Shards — memorise the glass balls, then click them in order',
  );

  const hudHost = document.createElement('div');
  hudHost.className = 'play__hud';
  hudHost.setAttribute('aria-live', 'polite');

  container.appendChild(canvasMount);
  container.appendChild(hudHost);

  // ── Engine ─────────────────────────────────────────────────────────────
  const stage = createScene(canvasMount);
  const game = new GameState();
  const shatter = new ShatterEffect({ scene: stage.scene });
  const scorer = new Scorer().attachToGame(game);
  const hud = new HUD({ root: hudHost });
  const feedback = new Feedback({
    breathElement: document.getElementById('breath-ambient'),
  });

  /** @type {Map<number, Ball>} */
  const ballsById = new Map();
  let scoreSaved = false; // dedupe — game-over fires once but be safe

  function clearBalls() {
    for (const b of ballsById.values()) {
      stage.remove(b.mesh);
      b.dispose();
    }
    ballsById.clear();
  }

  function spawnRound(round) {
    clearBalls();
    const count = ballCountForRound(round);
    const positions = generatePositions(count);
    const ids = [];
    for (const pos of positions) {
      const b = new Ball({ position: pos });
      ballsById.set(b.id, b);
      stage.add(b.mesh);
      ids.push(b.id);
    }
    return ids;
  }

  function liveBallPositions() {
    const out = [];
    for (const b of ballsById.values()) {
      if (b.mesh.visible) out.push(b.mesh.position);
    }
    return out;
  }

  function refreshHud() {
    const snap = scorer.getHudSnapshot();
    hud.applyScoreSnapshot(snap);
    const calm = calmReport(scorer.getCalmStats());
    hud.setCalm(calm.index, calm.tier);
  }

  function startGame() {
    scoreSaved = false;
    game.reset();
    scorer.reset();
    hud.setRound(1);
    hud.setHint('Memorise · Recall · Repeat');
    hud.setLives(game.lives, game.livesMax);
    refreshHud();
    const ids = spawnRound(1);
    game.startRound(1, ids);
  }

  // ─── Game-event → visual + scoring wiring ───────────────────────────────
  //
  // Every Emitter.on() returns an unsubscribe function — collect them in
  // `subs` so unmount() can detach all listeners atomically before tearing
  // down the HUD. Without this we had a small race where a tickReveal-driven
  // event (lifeLost, roundComplete, etc.) firing between hud.destroy() and
  // stage.dispose() would write to detached DOM nodes. Defensive but free.
  const subs = [];
  const sub = (target, event, fn) => subs.push(target.on(event, fn));
  // Tracks the deferred next-round timer so unmount can cancel it.
  let nextRoundTimer = null;

  sub(game, 'phase', (from, to) => {
    if (to === Phase.REVEAL) hud.setHint('Memorise');
    else if (to === Phase.RECALL) hud.setHint('Recall');
    else if (to === Phase.SPLIT_REVEAL) hud.setHint('Split — watch');
    else if (to === Phase.RESOLVE) hud.setHint('Breathe');
  });

  sub(game, 'roundStart', ({ round }) => hud.setRound(round));

  sub(game, 'revealStep', ({ ballId, level }) => {
    const b = ballsById.get(ballId);
    if (!b) return;
    const eased = level < 0.6 ? level / 0.6 : Math.max(0, 1 - (level - 0.6) / 0.4);
    b.setFlashLevel(eased);
  });

  sub(game, 'revealStepEnd', ({ ballId }) => {
    ballsById.get(ballId)?.setFlashLevel(0);
  });

  sub(game, 'correctClick', ({ ballId }) => {
    const b = ballsById.get(ballId);
    if (!b) return;
    b.markCorrect();
    shatter.spawn(b.mesh.position, b.baseColor, b.radius);
    b.markShattered();
    refreshHud();
  });

  sub(game, 'splitRequested', ({ parentBallId, depth, childCount }) => {
    const parent = ballsById.get(parentBallId);
    if (!parent) {
      console.warn('splitRequested for unknown parent — restarting cleanly', parentBallId);
      startGame();
      return;
    }
    const positions = generateChildPositions(parent.mesh.position, childCount, {
      spread: 1.5 + depth * 0.3,
      minDistance: 0.5,
      obstacles: liveBallPositions(),
    });
    const childKind = childKindForDepth(depth);
    const childIds = [];
    for (const pos of positions) {
      const child = new Ball({ position: pos, kind: childKind, splitDepth: depth });
      ballsById.set(child.id, child);
      stage.add(child.mesh);
      childIds.push(child.id);
    }
    game.acceptSplitChildren(parentBallId, childIds);
  });

  sub(game, 'wrongClick', () => {
    feedback.wrongClickVignette();
  });

  // Phase 7 lives system — keep HUD dots in sync.
  sub(game, 'lifeLost', ({ livesRemaining }) => {
    hud.setLives(livesRemaining, game.livesMax);
  });

  sub(game, 'roundComplete', ({ round, perfect }) => {
    refreshHud();
    if (perfect) feedback.perfectRoundHalo();
    nextRoundTimer = setTimeout(() => {
      nextRoundTimer = null;
      if (game.phase !== Phase.RESOLVE) return;
      const nextIds = spawnRound(round + 1);
      game.nextRound(nextIds);
    }, 1200);
  });

  sub(scorer, 'score', ({ points, reason }) => {
    if (!points) return;
    const tone = reason === 'split' ? 'bonus' : 'positive';
    feedback.scoreFloat(points, hud.scoreAnchor(), { tone });
  });

  sub(game, 'gameOver', ({ round, livesLost }) => {
    refreshHud();
    const calm = calmReport(scorer.getCalmStats());

    // Phase 11: persist the run to the leaderboard. Once per game-over.
    if (!scoreSaved) {
      scoreSaved = true;
      try {
        addScore({
          score: scorer.totalScore,
          calmIndex: calm.index,
          tier: calm.tier,
          round,
        });
      } catch (err) {
        console.error('addScore failed:', err);
      }
    }

    hud.showGameOver(
      {
        round,
        score: scorer.totalScore,
        bestStreak: scorer.bestStreak,
        calmIndex: calm.index,
        tier: calm.tier,
        livesUsed: Number.isFinite(livesLost) ? livesLost : game.livesMax - game.lives,
      },
      // Play Again
      startGame,
      // Phase 11 extras: View Leaderboard + Back to Menu
      {
        viewLeaderboard: () => {
          hud.hideGameOver();
          navigate('leaderboard');
        },
        backToMenu: () => {
          hud.hideGameOver();
          navigate('landing');
        },
      },
    );
  });

  // ─── Per-frame ticks ─────────────────────────────────────────────────────
  const stopTick = stage.onTick((dt, elapsed) => {
    game.tickReveal(dt);
    shatter.update(dt);
    for (const b of ballsById.values()) b.updateBreathing(elapsed);
  });

  // ─── Input ──────────────────────────────────────────────────────────────
  function onPointerDown(ev) {
    const hit = stage.pickAt(ev.clientX, ev.clientY);
    const ball = hit?.object?.userData?.ball;
    if (!ball) return;
    game.handleClick(ball.id);
  }
  canvasMount.addEventListener('pointerdown', onPointerDown);

  // ─── Boot ───────────────────────────────────────────────────────────────
  stage.start();
  startGame();

  // Expose for in-page debugging — keeps parity with the previous main.js.
  window.__zen = { stage, game, ballsById, shatter, scorer, hud, feedback, BallKind };

  // ─── Unmount handle ─────────────────────────────────────────────────────
  // Order matters here. Goal: no game/scorer/tick callback can fire after
  // any of the dispose calls below — otherwise we'd write to detached DOM
  // (HUD nodes) or freed GPU resources.
  //   1. detach the input source so no new game.handleClick fires
  //   2. stop the render loop + remove the per-frame tick listener
  //   3. cancel pending timers (next-round)
  //   4. unsubscribe every game/scorer listener (Emitter.on returned disposers)
  //   5. only THEN tear down balls / shatter / feedback / HUD / stage
  function unmount() {
    canvasMount.removeEventListener('pointerdown', onPointerDown);
    try { stage.stop(); } catch { /* ignore */ }
    try { stopTick?.(); } catch { /* ignore */ }
    if (nextRoundTimer) {
      clearTimeout(nextRoundTimer);
      nextRoundTimer = null;
    }
    while (subs.length) {
      try { subs.pop()(); } catch { /* ignore */ }
    }
    clearBalls();
    try { shatter.dispose(); } catch { /* ignore */ }
    try { feedback.dispose(); } catch { /* ignore */ }
    try { hud.destroy(); } catch { /* ignore */ }
    try { stage.dispose(); } catch { /* ignore */ }
    if (window.__zen) delete window.__zen;
    if (canvasMount.parentNode) canvasMount.parentNode.removeChild(canvasMount);
    if (hudHost.parentNode) hudHost.parentNode.removeChild(hudHost);
    active = null;
  }

  active = { unmount };
  return active;
}

export function unmount() {
  active?.unmount();
}

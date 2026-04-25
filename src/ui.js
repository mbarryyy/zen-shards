// HUD shell — vanilla DOM, dumb-component pattern.
//
// Phase 5 (dev-lead) shipped the structure. Phase 6 (ui-3d-designer) layered
// on motion + accessibility:
//   - Pill values pulse briefly when they change (data-attr → CSS animation)
//   - setHint cross-fades the text instead of swapping instantly
//   - setCalm pulses the tier emoji when the tier changes
//   - showGameOver animates the panel in (entering class → final state)
//   - ARIA labels + roles so screen readers can read the HUD
//
// All polish honors prefers-reduced-motion via CSS in index.html.
// Public method signatures are unchanged from Phase 5 — main.js needs no edit.

const PILL_PULSE_MS = 350; // matches CSS .hud-pill__value.pulsing animation
const HINT_FADE_MS = 320; // matches CSS .hud-hint transition

export class HUD {
  /**
   * @param {object} opts
   * @param {HTMLElement} [opts.root]   defaults to #ui
   */
  constructor({ root } = {}) {
    this.root =
      root ?? (typeof document !== 'undefined' ? document.getElementById('ui') : null);
    if (!this.root) throw new Error('HUD requires a root element');
    this._lastValues = { round: null, score: null, streak: null };
    this._lastTierEmoji = null;
    this._hintTimer = null;
    // Phase 11: setters early-return when this is true so any in-flight
    // game-event arriving between unmount tearing down the HUD DOM and the
    // GameState losing its last reference can't write to detached nodes.
    this._destroyed = false;
    this._build();
  }

  // ─── DOM construction ───────────────────────────────────────────────

  _build() {
    this.root.innerHTML = '';
    this.root.classList.add('hud');

    // Top-centre pill row: Round · Score · Streak
    const top = document.createElement('div');
    top.className = 'hud-top';
    top.setAttribute('role', 'group');
    top.setAttribute('aria-label', 'Game status');
    this.pillRound = this._pill('Round', '1', 'round');
    this.pillScore = this._pill('Score', '0', 'score');
    this.pillStreak = this._pill('Streak', '0', 'streak');
    top.append(this.pillRound, this.pillScore, this.pillStreak);
    this.root.appendChild(top);

    // Lives indicator — three dots top-right of the HUD pill row. Each dot
    // fades to its `.lost` style when a life is consumed; the wrapper gets
    // `.last-life` when only one remains so ui-3d-designer can layer a
    // pulsing red glow without dev-lead touching CSS structure.
    this.lives = document.createElement('div');
    this.lives.className = 'hud-lives';
    this.lives.setAttribute('role', 'group');
    this.lives.setAttribute('aria-label', 'Lives remaining');
    this.lives.setAttribute('aria-live', 'polite');
    this.livesDots = [];
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'hud-lives__dot';
      dot.setAttribute('aria-hidden', 'true');
      this.lives.appendChild(dot);
      this.livesDots.push(dot);
    }
    this._lastLives = 3;
    this.root.appendChild(this.lives);

    // Centred phase hint just below the pills.
    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint';
    this.hint.setAttribute('aria-live', 'polite');
    this.hint.setAttribute('aria-atomic', 'true');
    this.hint.textContent = 'Memorise · Recall · Repeat';
    this.root.appendChild(this.hint);

    // Bottom-left Calm Index gauge.
    const calm = document.createElement('div');
    calm.className = 'hud-calm';
    calm.setAttribute('role', 'group');
    calm.setAttribute('aria-label', 'Calm Index');
    this.calmTier = document.createElement('span');
    this.calmTier.className = 'hud-calm__tier';
    this.calmTier.textContent = '🌾';
    this.calmTier.setAttribute('aria-hidden', 'true'); // emoji decorative
    const barWrap = document.createElement('div');
    barWrap.className = 'hud-calm__bar';
    barWrap.setAttribute('role', 'progressbar');
    barWrap.setAttribute('aria-valuemin', '0');
    barWrap.setAttribute('aria-valuemax', '100');
    barWrap.setAttribute('aria-valuenow', '0');
    barWrap.setAttribute('aria-label', 'Calm Index value');
    this.calmBar = barWrap;
    this.calmFill = document.createElement('div');
    this.calmFill.className = 'hud-calm__fill';
    barWrap.appendChild(this.calmFill);
    this.calmValue = document.createElement('span');
    this.calmValue.className = 'hud-calm__value';
    this.calmValue.textContent = '—';
    const calmLabel = document.createElement('span');
    calmLabel.className = 'hud-calm__label';
    calmLabel.textContent = 'Calm Index';
    calm.append(this.calmTier, barWrap, this.calmValue, calmLabel);
    this.root.appendChild(calm);

    // Bottom-right level indicator.
    this.level = document.createElement('div');
    this.level.className = 'hud-level';
    this.level.setAttribute('aria-hidden', 'true'); // duplicates Round pill
    this.level.textContent = 'Level 1';
    this.root.appendChild(this.level);

    // Game-Over modal — hidden until shown.
    this.gameOver = document.createElement('div');
    this.gameOver.className = 'hud-gameover';
    this.gameOver.hidden = true;
    this.root.appendChild(this.gameOver);
  }

  _pill(label, value, kind) {
    const el = document.createElement('div');
    el.className = 'hud-pill';
    el.dataset.kind = kind;
    el.setAttribute('aria-label', `${label} ${value}`);
    const lbl = document.createElement('span');
    lbl.className = 'hud-pill__label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.className = 'hud-pill__value';
    val.textContent = value;
    el.append(lbl, val);
    el._value = val;
    el._labelText = label;
    return el;
  }

  /** Trigger a one-shot CSS pulse on a pill's value text. */
  _pulse(pill) {
    if (!pill || !pill._value) return;
    const el = pill._value;
    el.classList.remove('pulsing');
    // Re-trigger the animation by reading offsetWidth between class flips.
    void el.offsetWidth;
    el.classList.add('pulsing');
    // CSS animation auto-removes via animationend in modern browsers, but
    // we also strip after a safe delay in case it's interrupted.
    if (pill._pulseTimer) clearTimeout(pill._pulseTimer);
    pill._pulseTimer = setTimeout(() => {
      el.classList.remove('pulsing');
    }, PILL_PULSE_MS + 50);
  }

  /** Update a pill's value, refresh aria-label, and pulse if changed. */
  _setPill(pill, value, key) {
    const str = String(value);
    if (this._lastValues[key] === str) return;
    pill._value.textContent = str;
    pill.setAttribute('aria-label', `${pill._labelText} ${str}`);
    if (this._lastValues[key] !== null) this._pulse(pill);
    this._lastValues[key] = str;
  }

  // ─── public setters ──────────────────────────────────────────────────

  setRound(round) {
    if (this._destroyed) return;
    this._setPill(this.pillRound, round, 'round');
    this.level.textContent = `Level ${round}`;
  }

  setScore(score) {
    if (this._destroyed) return;
    this._setPill(this.pillScore, score, 'score');
  }

  setStreak(streak) {
    if (this._destroyed) return;
    this._setPill(this.pillStreak, streak, 'streak');
  }

  /**
   * @param {number} value 0..100
   * @param {{name:string, emoji:string}} [tier]
   */
  setCalm(value, tier) {
    if (this._destroyed) return;
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    this.calmFill.style.width = `${v}%`;
    this.calmValue.textContent = String(v);
    if (this.calmBar) {
      this.calmBar.setAttribute('aria-valuenow', String(v));
      if (tier) {
        this.calmBar.setAttribute('aria-valuetext', `${v} (${tier.name})`);
      } else {
        this.calmBar.setAttribute('aria-valuetext', String(v));
      }
    }
    if (tier) {
      const emoji = tier.emoji;
      if (emoji && emoji !== this._lastTierEmoji) {
        this.calmTier.textContent = emoji;
        // Pulse the emoji on tier change so the player notices the shift.
        this.calmTier.classList.remove('pulsing');
        void this.calmTier.offsetWidth;
        this.calmTier.classList.add('pulsing');
        this._lastTierEmoji = emoji;
      } else if (!this._lastTierEmoji) {
        this.calmTier.textContent = emoji;
        this._lastTierEmoji = emoji;
      }
    }
  }

  /**
   * Cross-fade the phase hint text. Same call signature as Phase 5; the
   * `fade` option is now ignored (transitions always run, controlled by CSS
   * + reduced-motion media query).
   */
  setHint(text) {
    if (this._destroyed) return;
    if (!text || this.hint.textContent === text) return;
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this.hint.classList.add('hud-hint--out');
    this._hintTimer = setTimeout(() => {
      this.hint.textContent = text;
      this.hint.classList.remove('hud-hint--out');
      this._hintTimer = null;
    }, HINT_FADE_MS);
  }

  /** Update HUD top pills + level from a Scorer snapshot. */
  applyScoreSnapshot({ totalScore, streak }) {
    if (this._destroyed) return;
    this.setScore(totalScore);
    this.setStreak(streak);
  }

  /**
   * Update the lives indicator. Toggles `.lost` on each dot beyond the
   * current `remaining` count, and `.last-life` on the wrapper when one
   * life is left so styling can pulse a warning glow.
   *
   * @param {number} remaining   current lives (0..max)
   * @param {number} [max]       upper bound for dot count (default 3)
   */
  setLives(remaining, max = 3) {
    if (this._destroyed) return;
    if (!this.livesDots) return;
    const r = Math.max(0, Math.min(max, Math.round(Number(remaining) || 0)));

    // Re-stretch the dot strip if max changed (e.g. tuned in opts).
    while (this.livesDots.length < max) {
      const dot = document.createElement('span');
      dot.className = 'hud-lives__dot';
      dot.setAttribute('aria-hidden', 'true');
      this.lives.appendChild(dot);
      this.livesDots.push(dot);
    }
    while (this.livesDots.length > max) {
      const dot = this.livesDots.pop();
      dot.remove();
    }

    // Pulse the JUST-lost dot so the player feels the deduction. Compare
    // to the previous render so we only flash the newly-lost dot, not all
    // already-lost ones on a re-render.
    const prev = this._lastLives ?? max;
    for (let i = 0; i < this.livesDots.length; i++) {
      const dot = this.livesDots[i];
      const lost = i >= r;
      dot.classList.toggle('lost', lost);
      // Newly-lost (was visible before, now lost): drop a one-shot pulse class.
      if (lost && i < prev) {
        dot.classList.remove('losing');
        void dot.offsetWidth;
        dot.classList.add('losing');
        if (dot._loseTimer) clearTimeout(dot._loseTimer);
        dot._loseTimer = setTimeout(() => dot.classList.remove('losing'), 700);
      }
    }
    this.lives.classList.toggle('last-life', r === 1);
    this.lives.setAttribute('aria-label', `Lives remaining ${r} of ${max}`);
    this._lastLives = r;
  }

  /**
   * Show the Game-Over panel and wire its action buttons.
   * Adds an entrance animation by toggling .entering → final state on
   * the next frame, which CSS picks up via transition.
   *
   * Phase 11 added the optional `extras` arg so the play view can wire
   * "View Leaderboard" + "Back to Menu" alongside the existing Play Again.
   * Both extras are optional — when omitted only Play Again renders, so
   * legacy callers (and tests) keep the original layout.
   *
   * @param {object} stats          summary fields shown on the panel
   * @param {Function} onPlayAgain  click handler for the Play Again button
   * @param {object} [extras]
   * @param {Function} [extras.viewLeaderboard]
   * @param {Function} [extras.backToMenu]
   */
  showGameOver(
    { round, score, bestStreak, calmIndex, tier, livesUsed },
    onPlayAgain,
    extras = {},
  ) {
    if (this._destroyed) return;
    const tierStr = tier ? `${tier.emoji} ${tier.name}` : `${calmIndex}`;
    // Lives Used row is optional — only render when caller supplies a count
    // so legacy boot paths (without the lives system) keep their layout.
    const livesRow =
      Number.isFinite(livesUsed)
        ? `<dt>Lives Used</dt><dd>${livesUsed}</dd>`
        : '';
    const showLeaderboardBtn = typeof extras.viewLeaderboard === 'function';
    const showMenuBtn = typeof extras.backToMenu === 'function';
    const leaderboardBtn = showLeaderboardBtn
      ? `<button class="hud-gameover__btn" type="button" data-action="leaderboard"
                  aria-label="View leaderboard">Leaderboard</button>`
      : '';
    const menuBtn = showMenuBtn
      ? `<button class="hud-gameover__btn hud-gameover__btn--ghost" type="button"
                  data-action="menu" aria-label="Back to menu">Back to Menu</button>`
      : '';
    this.gameOver.innerHTML = `
      <div class="hud-gameover__panel" role="dialog" aria-modal="true" aria-labelledby="gover-title">
        <div class="hud-gameover__title" id="gover-title">Stillness</div>
        <dl class="hud-gameover__stats">
          <dt>Rounds Survived</dt><dd>${round}</dd>
          <dt>Total Score</dt><dd>${score}</dd>
          <dt>Best Streak</dt><dd>${bestStreak}</dd>
          ${livesRow}
          <dt>Calm Index</dt><dd>${calmIndex} <span class="hud-gameover__tier">${tierStr}</span></dd>
        </dl>
        <div class="hud-gameover__actions">
          <button class="hud-gameover__btn hud-gameover__btn--primary" type="button" autofocus
                  data-action="play-again" aria-label="Play again">Play Again</button>
          ${leaderboardBtn}
          ${menuBtn}
        </div>
      </div>
    `;
    const onClick = (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'play-again':
          this.hideGameOver();
          onPlayAgain?.();
          break;
        case 'leaderboard':
          extras.viewLeaderboard?.();
          break;
        case 'menu':
          extras.backToMenu?.();
          break;
      }
    };
    this.gameOver.addEventListener('click', onClick);

    // Animate in: start with .entering class (suppressed state via CSS),
    // unhide, then strip .entering on next frame so transitions kick in.
    this.gameOver.classList.add('entering');
    this.gameOver.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Phase 12 QA fix: HUD.destroy() nulls this.gameOver, but a deferred
        // rAF scheduled here can still fire after a play.unmount() that ran
        // mid-game. Guard against the post-destroy callback so we don't
        // throw on `null.classList`.
        if (this._destroyed || !this.gameOver) return;
        this.gameOver.classList.remove('entering');
      });
    });
  }

  hideGameOver() {
    if (this._destroyed) return;
    this.gameOver.hidden = true;
    this.gameOver.classList.remove('entering');
  }

  /**
   * Convenience: the DOM node a HUD-anchored score float should rise from.
   * Phase 6 main.js wires Feedback.scoreFloat() to anchor on the score pill.
   * Returns null after destroy so feedback.scoreFloat falls back to its
   * top-center default position instead of anchoring on a detached node.
   */
  scoreAnchor() {
    if (this._destroyed) return null;
    return this.pillScore?._value ?? this.pillScore ?? null;
  }

  /**
   * Free DOM (mostly for tests + hot-reload safety).
   * Marks the instance as destroyed and nulls out cached node references so
   * any in-flight game-event setter writes become cheap no-ops instead of
   * scribbling on detached DOM.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = null;
    // Clear pulse timers stashed on each pill so they don't fire post-destroy.
    for (const pill of [this.pillRound, this.pillScore, this.pillStreak]) {
      if (pill?._pulseTimer) clearTimeout(pill._pulseTimer);
    }
    if (this.root) {
      this.root.innerHTML = '';
      this.root.classList.remove('hud');
    }
    // Null out cached node refs so any stale setter write is a no-op via
    // the _destroyed guard above (and a NPE if anything slips through —
    // which would be a bug worth surfacing rather than silently corrupting
    // a detached node).
    this.pillRound = this.pillScore = this.pillStreak = null;
    this.hint = this.calmTier = this.calmBar = this.calmFill = this.calmValue = null;
    this.level = this.gameOver = this.lives = null;
    this.livesDots = null;
  }
}

// Phase M2 — Integration tests for the scene + play-view wiring.
//
// Two passes:
//   1. play.js calls stage.getViewportFit() on spawnRound and on split, and
//      passes the returned bounds into the position generator. We spy on
//      the scene stub's getViewportFit + on the position-generator module
//      so we can read what was actually passed.
//   2. scene.js source-parse: verify the resize + orientationchange
//      listeners are added AND removed (the orientationchange path is the
//      M2 fix per dev-lead's audit §14 callout). scene.js requires Three.js,
//      so we lock the wiring at the source rather than instantiate it.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ─── Pass 1 · play.js ↔ stage.getViewportFit() ──────────────────────────

// Spy on the position generators so we can read the bounds that play.js
// hands them. Hoisted via vi.mock so play.js sees the mocked module.
const positionsMock = vi.hoisted(() => ({
  generatePositions: vi.fn((count, opts = {}) => {
    // Return `count` positions inside the supplied bounds (centroid).
    const out = [];
    for (let i = 0; i < count; i++) out.push({ x: 0, y: 0, z: 0 });
    return out;
  }),
  generateChildPositions: vi.fn((origin, count, opts = {}) => {
    const out = [];
    for (let i = 0; i < count; i++) out.push({ x: 0, y: 0, z: 0 });
    return out;
  }),
}));
vi.mock('../src/positions.js', () => positionsMock);

// Scene stub mirrors the existing pattern in play-integration.test.js but
// exposes a configurable getViewportFit so each test can swap the bounds.
const sceneState = vi.hoisted(() => ({
  fit: {
    fov: 45,
    aspect: 16 / 9,
    isPortrait: false,
    visibleWidth: 16,
    visibleHeight: 9,
    bounds: { x: [-5, 5], y: [-3, 3], z: [-2, 2] },
  },
  getViewportFitCalls: 0,
}));

vi.mock('../src/scene.js', () => {
  const tickListeners = new Set();
  function createScene(mount) {
    return {
      scene: { _stub: true },
      camera: { _stub: true },
      renderer: { _stub: true },
      add: () => {},
      remove: () => {},
      pickAt: () => null,
      start: () => {},
      stop: () => {},
      onTick: (fn) => { tickListeners.add(fn); return () => tickListeners.delete(fn); },
      getViewportFit: () => {
        sceneState.getViewportFitCalls += 1;
        return sceneState.fit;
      },
      dispose: () => { tickListeners.clear(); },
      get elapsed() { return 0; },
    };
  }
  return { createScene };
});

vi.mock('../src/ball.js', async () => {
  let nextId = 1;
  class Ball {
    constructor({ position, kind = 'primary', splitDepth = 0 } = {}) {
      this.id = `b${nextId++}`;
      this.kind = kind;
      this.splitDepth = splitDepth;
      this.mesh = {
        visible: true,
        position: { ...position, copy: () => {} },
        userData: {},
      };
    }
    setFlashing() {}
    markCorrect() {}
    markShattered() {}
    update() {}
    dispose() {}
  }
  return {
    Ball,
    BallKind: Object.freeze({ PRIMARY: 'primary', SPLIT_L1: 'split-l1', SPLIT_L2: 'split-l2' }),
    BALL_STATE: { IDLE: 'idle', FLASHING: 'flashing', CORRECT: 'correct', SHATTERED: 'shattered' },
    _resetBallStub() { nextId = 1; },
  };
});

vi.mock('../src/shatter.js', () => {
  class ShatterEffect {
    constructor() {}
    spawn() {}
    update() {}
    dispose() {}
  }
  return { ShatterEffect };
});

vi.mock('../src/feedback.js', () => {
  class Feedback {
    constructor() {}
    wrongClickVignette() {}
    perfectRoundHalo() {}
    scoreFloat() {}
    dispose() {}
  }
  return { Feedback };
});

vi.mock('../src/router.js', () => ({
  navigate: () => {},
  currentRoute: () => null,
  start: () => {},
  stop: async () => {},
}));

import * as play from '../src/views/play.js';
import { signIn, _resetMockData } from '../src/mock-data.js';

let container;

beforeEach(() => {
  try { localStorage.removeItem('zen.user'); } catch { /* ignore */ }
  try { localStorage.removeItem('zen.scores'); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  _resetMockData();
  signIn('m2@example.com');

  document.body.innerHTML = '';
  container = document.createElement('div');
  container.id = 'page-container';
  document.body.appendChild(container);

  positionsMock.generatePositions.mockClear();
  positionsMock.generateChildPositions.mockClear();
  sceneState.getViewportFitCalls = 0;
  delete window.__zen;
});

afterEach(() => {
  try { play.unmount(container); } catch { /* ignore */ }
  delete window.__zen;
});

describe('M2 · play.js spawnRound pulls live viewport bounds', () => {
  it('spawnRound calls stage.getViewportFit() and passes fit.bounds to generatePositions', () => {
    play.mount(container);

    expect(sceneState.getViewportFitCalls).toBeGreaterThan(0);
    expect(positionsMock.generatePositions).toHaveBeenCalled();

    // Inspect the bounds argument on the most-recent call.
    const lastCall = positionsMock.generatePositions.mock.calls.at(-1);
    const opts = lastCall[1] ?? {};
    expect(opts.bounds).toBeDefined();
    expect(opts.bounds).toEqual(sceneState.fit.bounds);
  });

  it('round bounds reflect a NEW viewport fit when getViewportFit returns different bounds', () => {
    // Simulate the player rotating to portrait between mount and the next round.
    play.mount(container);
    const initialBounds = positionsMock.generatePositions.mock.calls.at(-1)[1].bounds;
    expect(initialBounds).toEqual({ x: [-5, 5], y: [-3, 3], z: [-2, 2] });

    // Swap to a portrait fit (iPhone 13 mini-ish).
    sceneState.fit = {
      fov: 65,
      aspect: 0.46,
      isPortrait: true,
      visibleWidth: 6,
      visibleHeight: 13,
      bounds: { x: [-3, 3], y: [-6.5, 6.5], z: [-2, 2] },
    };

    // Trigger the next round by dispatching the round-over → spawn flow.
    // Easiest path: re-mount (mount calls spawnRound for round 1 again).
    play.unmount(container);
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    positionsMock.generatePositions.mockClear();

    play.mount(container);

    const portraitBounds = positionsMock.generatePositions.mock.calls.at(-1)[1].bounds;
    expect(portraitBounds).toEqual({ x: [-3, 3], y: [-6.5, 6.5], z: [-2, 2] });
    // The two fits should NOT be the same object — bounds genuinely tracked the swap.
    expect(portraitBounds).not.toEqual(initialBounds);
  });
});

// ─── Pass 2 · scene.js source-parse: listener wiring ────────────────────

describe('M2 · scene.js subscribes to BOTH resize and orientationchange', () => {
  const SCENE_SRC = readFileSync(resolve(here, '..', 'src', 'scene.js'), 'utf8');

  it('imports computeViewportFit from the new helper module', () => {
    expect(SCENE_SRC).toMatch(
      /import\s*\{[^}]*computeViewportFit[^}]*\}\s*from\s*['"]\.\/viewport-fit\.js['"]/,
    );
  });

  it('adds a resize listener AND an orientationchange listener', () => {
    expect(SCENE_SRC).toMatch(
      /window\.addEventListener\(\s*['"]resize['"]\s*,\s*onResize\s*\)/,
    );
    expect(SCENE_SRC).toMatch(
      /window\.addEventListener\(\s*['"]orientationchange['"]\s*,\s*onResize\s*\)/,
    );
  });

  it('removes BOTH listeners on dispose (no leak after route change)', () => {
    expect(SCENE_SRC).toMatch(
      /window\.removeEventListener\(\s*['"]resize['"]\s*,\s*onResize\s*\)/,
    );
    expect(SCENE_SRC).toMatch(
      /window\.removeEventListener\(\s*['"]orientationchange['"]\s*,\s*onResize\s*\)/,
    );
  });

  it('onResize re-runs computeViewportFit and updates camera.fov + camera.aspect', () => {
    // Locks the M2 behaviour: camera follows the viewport on rotation, not just aspect.
    expect(SCENE_SRC).toMatch(/function\s+onResize\s*\(\s*\)\s*\{[\s\S]*?computeViewportFit\(/);
    expect(SCENE_SRC).toMatch(/camera\.aspect\s*=\s*fit\.aspect/);
    expect(SCENE_SRC).toMatch(/camera\.fov\s*=\s*fit\.fov/);
    expect(SCENE_SRC).toMatch(/camera\.updateProjectionMatrix\s*\(/);
  });

  it('exposes getViewportFit in the public createScene return', () => {
    // Both the function definition AND the return-object key must exist.
    expect(SCENE_SRC).toMatch(/function\s+getViewportFit\s*\(\s*\)\s*\{/);
    expect(SCENE_SRC).toMatch(/return\s*\{[\s\S]*?getViewportFit[\s\S]*?\}/);
  });
});

// ─── Pass 3 · play.js source-parse: split-children pass bounds too ──────

describe('M2 · play.js split-children inherit the live viewport bounds', () => {
  const PLAY_SRC = readFileSync(resolve(here, '..', 'src', 'views', 'play.js'), 'utf8');

  it('splitRequested handler pulls a fresh getViewportFit() before generating child positions', () => {
    // We don't care about exact var names — just that getViewportFit is called
    // inside the splitRequested branch and a `bounds:` property reaches the
    // generateChildPositions call on the same handler.
    const splitBranch = /splitRequested[\s\S]*?stage\.getViewportFit\(\)[\s\S]*?generateChildPositions\([\s\S]*?bounds:[\s\S]*?\}\)/;
    expect(PLAY_SRC).toMatch(splitBranch);
  });

  it('spawnRound() pulls a fresh getViewportFit() and passes bounds to generatePositions', () => {
    const spawnBranch = /spawnRound[\s\S]*?stage\.getViewportFit\(\)[\s\S]*?generatePositions\([\s\S]*?bounds:/;
    expect(PLAY_SRC).toMatch(spawnBranch);
  });
});

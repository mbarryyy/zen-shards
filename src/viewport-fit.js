// Viewport-fit helper — maps the renderer's mount size to a camera FOV
// and visible-volume bounds usable by the position generator.
//
// Pure & deterministic on purpose: no Three.js, no DOM. The play view
// pulls a fresh fit on every spawnRound (so balls land inside whatever
// the user's currently looking at) and scene.js consumes `fov` directly
// at create + onResize time. Phase M2.

const DEFAULT_BASE_FOV = 45; // landscape / desktop
const DEFAULT_PORTRAIT_FOV = 65; // wide enough that vertical phones still
//                                  show a usable horizontal slice
const DEFAULT_CAMERA_DISTANCE = 12; // matches scene.js camera.position.z
const DEFAULT_MARGIN_RATIO = 0.85; // leave room near the frustum edge so
//                                    balls aren't clipped by the canvas
const DEFAULT_DEPTH = 4; // z-axis range, kept symmetric around z=0
//                          (matches the legacy ±2 from positions.js)
const DEFAULT_BALL_RADIUS_PAD = 0.6; // safety pad for the largest ball radius
//                                      (PRIMARY=0.55) so the ball SURFACE,
//                                      not its centre, stays inside the view

// Aspect at or above PORTRAIT_PIVOT uses baseFov; at or below
// PORTRAIT_FULL uses portraitFov; we lerp between them so transitions
// (resizing a desktop window narrow, or rotating a tablet) don't snap.
const PORTRAIT_PIVOT = 1.0;
const PORTRAIT_FULL = 0.55;

/**
 * Compute the camera FOV and ball-spawn bounds that fit a given viewport.
 *
 * @param {object} opts
 * @param {number} opts.width             mount.clientWidth in CSS px
 * @param {number} opts.height            mount.clientHeight in CSS px
 * @param {number} [opts.cameraDistance]  camera-to-origin distance (default 12)
 * @param {number} [opts.baseFov]         landscape FOV in degrees (default 45)
 * @param {number} [opts.portraitFov]     narrow-portrait FOV in degrees (default 65)
 * @param {number} [opts.marginRatio]     fraction of frustum used for bounds (default 0.85)
 * @param {number} [opts.depth]           z-axis range, centred on 0 (default 4)
 * @returns {{
 *   fov: number,
 *   aspect: number,
 *   isPortrait: boolean,
 *   visibleWidth: number,
 *   visibleHeight: number,
 *   bounds: { x:[number,number], y:[number,number], z:[number,number] },
 * }}
 */
export function computeViewportFit(opts = {}) {
  const width = Math.max(1, opts.width ?? 1);
  const height = Math.max(1, opts.height ?? 1);
  const cameraDistance = opts.cameraDistance ?? DEFAULT_CAMERA_DISTANCE;
  const baseFov = opts.baseFov ?? DEFAULT_BASE_FOV;
  const portraitFov = opts.portraitFov ?? DEFAULT_PORTRAIT_FOV;
  const marginRatio = clamp(opts.marginRatio ?? DEFAULT_MARGIN_RATIO, 0, 1);
  const depth = opts.depth ?? DEFAULT_DEPTH;

  const aspect = width / height;
  const isPortrait = width < height;
  const fov = pickFov(aspect, baseFov, portraitFov);
  const ballRadiusPad = opts.ballRadiusPad ?? DEFAULT_BALL_RADIUS_PAD;

  // Compute the visible frustum at the *closest* z a ball can occupy
  // (cameraDistance - depth/2). At z = +depth/2 the ball is closer to the
  // camera than the canonical z=0 plane, so the visible area is smaller —
  // use that worst-case so balls at any depth fit on screen.
  const closestDistance = Math.max(0.1, cameraDistance - depth / 2);
  const visibleHeight =
    2 * Math.tan(((fov / 2) * Math.PI) / 180) * closestDistance;
  const visibleWidth = visibleHeight * aspect;

  // Subtract ball radius so the ball SURFACE (not just its centre) stays
  // inside the view, then apply the marginRatio safety pad on top.
  const halfX = Math.max(0.5, ((visibleWidth / 2) - ballRadiusPad) * marginRatio);
  const halfY = Math.max(0.5, ((visibleHeight / 2) - ballRadiusPad) * marginRatio);
  const halfZ = depth / 2;

  return {
    fov,
    aspect,
    isPortrait,
    visibleWidth,
    visibleHeight,
    bounds: {
      x: [-halfX, halfX],
      y: [-halfY, halfY],
      z: [-halfZ, halfZ],
    },
  };
}

/**
 * Smoothly interpolate between landscape and portrait FOV based on aspect.
 * Exported so tests / scene.js can verify the curve in isolation.
 */
export function pickFov(aspect, baseFov = DEFAULT_BASE_FOV, portraitFov = DEFAULT_PORTRAIT_FOV) {
  if (!Number.isFinite(aspect) || aspect >= PORTRAIT_PIVOT) return baseFov;
  if (aspect <= PORTRAIT_FULL) return portraitFov;
  const t = (PORTRAIT_PIVOT - aspect) / (PORTRAIT_PIVOT - PORTRAIT_FULL);
  return baseFov + (portraitFov - baseFov) * t;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export {
  DEFAULT_BASE_FOV,
  DEFAULT_PORTRAIT_FOV,
  DEFAULT_CAMERA_DISTANCE,
  DEFAULT_MARGIN_RATIO,
  DEFAULT_DEPTH,
  DEFAULT_BALL_RADIUS_PAD,
  PORTRAIT_PIVOT,
  PORTRAIT_FULL,
};

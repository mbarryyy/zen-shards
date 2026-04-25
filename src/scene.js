// Three.js scene scaffold — renderer, camera, lighting, raycaster, and a
// per-frame ticker. Designed to be created once and handed off to the game
// loop module.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { computeViewportFit, DEFAULT_CAMERA_DISTANCE } from './viewport-fit.js';

// Scene rendered transparent so the CSS gradient background shows through.
// Fog tint matches the bottom of the gradient for cohesion.
const FOG_TINT = 0xc2d2e0;

/**
 * Build the renderer, scene, camera, and lights. Returns a controller object
 * with `start`, `stop`, `add`, `remove`, `pickAt`, and `onResize` methods.
 *
 * @param {HTMLElement} mount  element the renderer canvas is appended to
 */
export function createScene(mount) {
  if (!mount) throw new Error('createScene requires a mount element');

  const scene = new THREE.Scene();
  scene.background = null; // transparent — CSS gradient shows through
  scene.fog = new THREE.Fog(FOG_TINT, 14, 32);

  // Phase M2: pull FOV + visible-volume bounds from a deterministic helper
  // so the same numbers feed the position generator and the camera. On
  // portrait phones this widens the FOV (45° → up to ~65°) so the scene
  // reads instead of cropping out half the balls.
  //
  // HUD chrome reserves vertical space:
  //   top ≈ nav (56) + pills row (top:80) + lives (top:158) + hint (top:128)
  //         → ~190px max; round up to 200 for safety
  //   bottom ≈ calm gauge (22 + ~50) + level pill ~ 100px
  // Balls won't spawn inside these strips so HUD never overlaps a ball.
  const cameraDistance = DEFAULT_CAMERA_DISTANCE;
  const HUD_INSET_TOP_PX = 200;
  const HUD_INSET_BOTTOM_PX = 100;
  let fit = computeViewportFit({
    width: mount.clientWidth,
    height: mount.clientHeight,
    cameraDistance,
    insetTopPx: HUD_INSET_TOP_PX,
    insetBottomPx: HUD_INSET_BOTTOM_PX,
  });

  const camera = new THREE.PerspectiveCamera(fit.fov, fit.aspect, 0.1, 100);
  camera.position.set(0, 0, cameraDistance);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0); // fully transparent
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  mount.appendChild(renderer.domElement);

  // --- lighting ---------------------------------------------------------
  // Daylight wash: soft sky hemi, warm key, cool rim. Tuned so the glass balls
  // catch highlights against the light gradient background without washing out.
  const hemi = new THREE.HemisphereLight(0xeaf2fa, 0xb6c4d2, 0.95);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff6e0, 1.2);
  key.position.set(4, 6, 5);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xb8d0e8, 0.55);
  rim.position.set(-5, -2, -3);
  scene.add(rim);

  const fillA = new THREE.PointLight(0xffffff, 0.45, 30);
  fillA.position.set(-4, 3, 4);
  scene.add(fillA);

  const fillB = new THREE.PointLight(0xc8d8e8, 0.35, 25);
  fillB.position.set(5, -2, 3);
  scene.add(fillB);

  // RoomEnvironment gives glass crisp procedural reflections out of the box.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envTarget.texture;
  pmrem.dispose();

  // --- picking ----------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pickables = []; // Object3Ds eligible for Raycaster checks
  const pointer = new THREE.Vector2();

  function pickAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // Filter to visible meshes only — Three.js Raycaster ignores .visible by
    // default, so shattered balls (visible=false) would still register hits
    // and block clicks on live balls behind them.
    const live = pickables.filter((m) => m.visible);
    const hits = raycaster.intersectObjects(live, false);
    return hits.length > 0 ? hits[0] : null;
  }

  function add(obj) {
    scene.add(obj);
    if (obj.isMesh) pickables.push(obj);
  }

  function remove(obj) {
    scene.remove(obj);
    const i = pickables.indexOf(obj);
    if (i !== -1) pickables.splice(i, 1);
  }

  function clearPickables() {
    pickables.length = 0;
  }

  // --- main loop --------------------------------------------------------
  let running = false;
  let rafId = null;
  let lastTime = 0;
  let elapsed = 0;
  const tickListeners = new Set();

  function tick(nowMs) {
    if (!running) return;
    const now = nowMs / 1000;
    const dt = lastTime === 0 ? 0 : now - lastTime;
    lastTime = now;
    elapsed += dt;

    for (const fn of tickListeners) {
      try {
        fn(dt, elapsed);
      } catch (err) {
        console.error('tick listener threw:', err);
      }
    }

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    lastTime = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function onTick(fn) {
    tickListeners.add(fn);
    return () => tickListeners.delete(fn);
  }

  function onResize() {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    fit = computeViewportFit({
      width: w,
      height: h,
      cameraDistance,
      insetTopPx: HUD_INSET_TOP_PX,
      insetBottomPx: HUD_INSET_BOTTOM_PX,
    });
    camera.aspect = fit.aspect;
    camera.fov = fit.fov;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  // Audit §14 flagged that iOS Safari toolbar collapse + tab-backgrounded
  // rotates can miss `resize`. Subscribe to orientationchange too so the
  // camera/bounds resync after a rotation even if `resize` was swallowed.
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  /**
   * Current viewport fit (FOV + visible-volume bounds). Returned freshly
   * each call so spawnRound can place balls inside the live frustum even
   * after a resize / rotation. Phase M2.
   */
  function getViewportFit() {
    return fit;
  }

  /**
   * Tear down the scene completely — stops the loop, disposes the renderer,
   * removes the canvas from the DOM, releases env-map textures, and unhooks
   * the resize listener. Called by the Play view on unmount so route changes
   * don't leak GPU memory.
   */
  function dispose() {
    stop();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    tickListeners.clear();
    pickables.length = 0;

    // Release scene-owned objects.
    if (scene.environment) {
      scene.environment.dispose?.();
      scene.environment = null;
    }
    scene.fog = null;
    // Walk the graph and dispose any remaining geometry/material — anything
    // the game forgot to remove explicitly. Cheap insurance against leaks.
    scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose?.();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
        else mat?.dispose?.();
      }
    });

    renderer.dispose();
    renderer.forceContextLoss?.();
    if (renderer.domElement?.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  return {
    scene,
    camera,
    renderer,
    add,
    remove,
    clearPickables,
    pickAt,
    start,
    stop,
    onTick,
    onResize,
    getViewportFit,
    dispose,
    get elapsed() {
      return elapsed;
    },
  };
}

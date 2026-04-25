// Tiny synchronous event emitter — keeps game/ui modules decoupled.
// Listeners are called in registration order; throws inside listeners are
// caught and logged so one broken HUD piece can't kill the game loop.

export class Emitter {
  constructor() {
    this._listeners = new Map(); // event → Set<fn>
  }

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter] listener for "${event}" threw:`, err);
      }
    }
  }

  removeAll(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
  }
}

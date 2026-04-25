// Tests for src/events.js — tiny synchronous Emitter.

import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../src/events.js';

describe('Emitter.on / emit', () => {
  it('invokes a registered listener with emitted args', () => {
    const e = new Emitter();
    const fn = vi.fn();
    e.on('hello', fn);
    e.emit('hello', 1, 'two', { three: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1, 'two', { three: 3 });
  });

  it('emit on an event with no listeners is a no-op', () => {
    const e = new Emitter();
    expect(() => e.emit('nobody')).not.toThrow();
  });

  it('invokes listeners in registration order', () => {
    const e = new Emitter();
    const calls = [];
    e.on('x', () => calls.push('a'));
    e.on('x', () => calls.push('b'));
    e.on('x', () => calls.push('c'));
    e.emit('x');
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('rejects non-function listeners with TypeError', () => {
    const e = new Emitter();
    expect(() => e.on('x', null)).toThrow(TypeError);
    expect(() => e.on('x', 42)).toThrow(TypeError);
    expect(() => e.on('x', 'fn')).toThrow(TypeError);
  });

  it('does NOT call the same listener twice if registered twice (Set semantics)', () => {
    const e = new Emitter();
    const fn = vi.fn();
    e.on('x', fn);
    e.on('x', fn);
    e.emit('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('Emitter.off + unsubscribe', () => {
  it('off(event, fn) removes a specific listener', () => {
    const e = new Emitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on('x', a);
    e.on('x', b);
    e.off('x', a);
    e.emit('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('on() returns an unsubscribe function', () => {
    const e = new Emitter();
    const fn = vi.fn();
    const unsub = e.on('x', fn);
    expect(typeof unsub).toBe('function');
    unsub();
    e.emit('x');
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribe twice is safe', () => {
    const e = new Emitter();
    const unsub = e.on('x', () => {});
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });

  it('off on an unknown event is a no-op', () => {
    const e = new Emitter();
    expect(() => e.off('ghost', () => {})).not.toThrow();
  });
});

describe('Emitter listener error isolation', () => {
  it('a throwing listener does not block subsequent listeners', () => {
    const e = new Emitter();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    e.on('x', () => { throw new Error('boom'); });
    e.on('x', after);
    expect(() => e.emit('x', 'arg')).not.toThrow();
    expect(after).toHaveBeenCalledWith('arg');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a throwing listener does not skip a third listener', () => {
    const e = new Emitter();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = [];
    e.on('x', () => calls.push('first'));
    e.on('x', () => { throw new Error('mid'); });
    e.on('x', () => calls.push('third'));
    e.emit('x');
    expect(calls).toEqual(['first', 'third']);
    errSpy.mockRestore();
  });
});

describe('Emitter.removeAll', () => {
  it('removeAll(event) clears listeners for that event only', () => {
    const e = new Emitter();
    const x = vi.fn();
    const y = vi.fn();
    e.on('x', x);
    e.on('y', y);
    e.removeAll('x');
    e.emit('x');
    e.emit('y');
    expect(x).not.toHaveBeenCalled();
    expect(y).toHaveBeenCalledTimes(1);
  });

  it('removeAll() with no args clears every event', () => {
    const e = new Emitter();
    const x = vi.fn();
    const y = vi.fn();
    e.on('x', x);
    e.on('y', y);
    e.removeAll();
    e.emit('x');
    e.emit('y');
    expect(x).not.toHaveBeenCalled();
    expect(y).not.toHaveBeenCalled();
  });

  it('removeAll on an unknown event is a no-op', () => {
    const e = new Emitter();
    expect(() => e.removeAll('ghost')).not.toThrow();
  });
});

describe('Emitter event name isolation', () => {
  it('different events do not cross-talk', () => {
    const e = new Emitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on('alpha', a);
    e.on('beta', b);
    e.emit('alpha', 1);
    expect(a).toHaveBeenCalledWith(1);
    expect(b).not.toHaveBeenCalled();
  });
});

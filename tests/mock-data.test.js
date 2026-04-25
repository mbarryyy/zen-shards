// Tests for src/mock-data.js — Phase 9 mock auth + leaderboard data layer.
//
// jsdom provides localStorage, so we exercise the real persistence path.
// Each test resets state via _resetMockData() + a localStorage scrub so
// suites are order-independent.
//
// Coverage:
//   - signIn: happy path, email normalisation, trim, rejects empty/whitespace
//   - signOut: clears user, returns null
//   - currentUser: null when not signed in, persisted user when signed in
//   - getLeaderboard: ≥12 seed entries on fresh store, sorted score desc,
//     returned array is a copy (mutation-safe), tier objects come from
//     ZEN_TIERS (Seedling/Marker/Leaf/Blossom — not stub vocabulary)
//   - addScore: inserts + persists, defaults name to currentUser then
//     'Wanderer', defaults tier from calmIndex, clamps numeric fields,
//     records `at` timestamp, leaderboard re-sort still puts highest first
//   - bestForCurrentUser: null when signed out, highest-score user entry
//     when signed in, null when no entries match the user's name
//   - totalRoundsForCurrentUser: 0 when signed out, sums across entries
//   - _resetMockData: restores seed, clears user
//   - Persistence across "page reload" via vi.resetModules() → user + new
//     scores still readable from a fresh module import
//   - Storage corruption: malformed JSON in zen.scores → graceful fallback

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  signIn,
  signOut,
  currentUser,
  getLeaderboard,
  addScore,
  bestForCurrentUser,
  totalRoundsForCurrentUser,
  _resetMockData,
} from '../src/mock-data.js';
import { tierForCalmIndex, ZEN_TIERS } from '../src/calm-index.js';

const STORAGE_KEYS = ['zen.user', 'zen.scores'];

beforeEach(() => {
  // Wipe everything between tests so state can't bleed across.
  for (const k of STORAGE_KEYS) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  _resetMockData();
});

// ─── signIn ────────────────────────────────────────────────────────────────

describe('signIn', () => {
  it('returns a user with lower-cased email + capitalised local-part name', () => {
    const u = signIn('Alice@Example.com');
    expect(u.email).toBe('alice@example.com');
    expect(u.name).toBe('Alice');
    expect(typeof u.signedInAt).toBe('number');
    expect(u.signedInAt).toBeLessThanOrEqual(Date.now());
  });

  it('trims surrounding whitespace before normalising', () => {
    const u = signIn('   bob@x.io   ');
    expect(u.email).toBe('bob@x.io');
    expect(u.name).toBe('Bob');
  });

  it('throws when called with empty string', () => {
    expect(() => signIn('')).toThrow(/signIn requires an email/i);
  });

  it('throws when called with whitespace-only string', () => {
    expect(() => signIn('    ')).toThrow(/signIn requires an email/i);
    expect(() => signIn('\t\n')).toThrow(/signIn requires an email/i);
  });

  it('throws when called with no argument', () => {
    expect(() => signIn()).toThrow(/signIn requires an email/i);
  });

  it('throws when called with null/undefined explicitly', () => {
    expect(() => signIn(null)).toThrow(/signIn requires an email/i);
    expect(() => signIn(undefined)).toThrow(/signIn requires an email/i);
  });

  it('persists the user to localStorage["zen.user"]', () => {
    signIn('zoe@example.com');
    const raw = localStorage.getItem('zen.user');
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw);
    expect(stored.email).toBe('zoe@example.com');
    expect(stored.name).toBe('Zoe');
  });

  it('signing in again replaces the previous user (no multi-user storage)', () => {
    signIn('first@example.com');
    signIn('second@example.com');
    expect(currentUser().email).toBe('second@example.com');
    expect(currentUser().name).toBe('Second');
  });

  it('falls back to "Wanderer" when the local-part is empty', () => {
    // "@x.io" → local-part is empty string, falls back to Wanderer.
    const u = signIn('@x.io');
    expect(u.name).toBe('Wanderer');
  });
});

// ─── signOut ───────────────────────────────────────────────────────────────

describe('signOut', () => {
  it('returns null and clears currentUser()', () => {
    signIn('out@example.com');
    expect(currentUser()).not.toBeNull();
    expect(signOut()).toBeNull();
    expect(currentUser()).toBeNull();
  });

  it('removes the localStorage["zen.user"] key', () => {
    signIn('out@example.com');
    expect(localStorage.getItem('zen.user')).toBeTruthy();
    signOut();
    expect(localStorage.getItem('zen.user')).toBeNull();
  });

  it('is safe to call when no user is signed in', () => {
    expect(() => signOut()).not.toThrow();
    expect(signOut()).toBeNull();
  });

  it('does NOT touch the leaderboard scores', () => {
    signIn('out@example.com');
    const before = getLeaderboard().length;
    signOut();
    expect(getLeaderboard()).toHaveLength(before);
  });
});

// ─── currentUser ───────────────────────────────────────────────────────────

describe('currentUser', () => {
  it('returns null when no signIn has happened', () => {
    expect(currentUser()).toBeNull();
  });

  it('returns the persisted user after signIn', () => {
    const u = signIn('curr@example.com');
    expect(currentUser()).toEqual(u);
  });
});

// ─── getLeaderboard ────────────────────────────────────────────────────────

describe('getLeaderboard', () => {
  it('returns the seed (≥12 entries) on a fresh store', () => {
    const list = getLeaderboard();
    expect(list.length).toBeGreaterThanOrEqual(12);
  });

  it('returns entries sorted by score descending', () => {
    const list = getLeaderboard();
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].score).toBeGreaterThanOrEqual(list[i].score);
    }
  });

  it('returns a fresh array each call — mutation safety', () => {
    const a = getLeaderboard();
    const b = getLeaderboard();
    expect(a).not.toBe(b); // different references
    a.push({ name: 'Mutator', score: 99999, calmIndex: 100, round: 99 });
    a[0].score = 0;
    // b is a separate array; mutating a should not change a fresh fetch.
    const c = getLeaderboard();
    expect(c.length).toBe(b.length);
    expect(c.find((e) => e.name === 'Mutator')).toBeUndefined();
    // The original first-place entry should still be at score-desc top.
    expect(c[0].score).toBeGreaterThan(0);
  });

  it('seed tiers come from the canonical ZEN_TIERS taxonomy', () => {
    const validNames = ZEN_TIERS.map((t) => t.name);
    for (const entry of getLeaderboard()) {
      expect(entry.tier).toBeDefined();
      expect(validNames).toContain(entry.tier.name);
    }
  });

  it('every seed entry has the expected schema', () => {
    for (const e of getLeaderboard()) {
      expect(typeof e.name).toBe('string');
      expect(e.name.length).toBeGreaterThan(0);
      expect(typeof e.score).toBe('number');
      expect(typeof e.calmIndex).toBe('number');
      expect(typeof e.round).toBe('number');
      expect(e.tier).toBeDefined();
      expect(typeof e.tier.name).toBe('string');
      expect(typeof e.tier.emoji).toBe('string');
    }
  });

  it('reflects entries added via addScore', () => {
    const before = getLeaderboard().length;
    addScore({ score: 100, calmIndex: 50, round: 4, name: 'Test' });
    const after = getLeaderboard();
    expect(after.length).toBe(before + 1);
    expect(after.some((e) => e.name === 'Test' && e.score === 100)).toBe(true);
  });
});

// ─── addScore ──────────────────────────────────────────────────────────────

describe('addScore', () => {
  it('inserts and returns the entry with correct fields', () => {
    const e = addScore({ score: 555, calmIndex: 72, round: 8, name: 'Echo' });
    expect(e.name).toBe('Echo');
    expect(e.score).toBe(555);
    expect(e.calmIndex).toBe(72);
    expect(e.round).toBe(8);
    expect(e.tier).toBeDefined();
    expect(typeof e.at).toBe('number');
    expect(e.at).toBeLessThanOrEqual(Date.now());
  });

  it('persists across getLeaderboard() calls', () => {
    addScore({ score: 777, calmIndex: 80, round: 9, name: 'Persist' });
    const list = getLeaderboard();
    expect(list.some((e) => e.name === 'Persist' && e.score === 777)).toBe(true);
  });

  it('persists to localStorage["zen.scores"]', () => {
    addScore({ score: 333, calmIndex: 50, round: 5, name: 'Storage' });
    const raw = JSON.parse(localStorage.getItem('zen.scores'));
    expect(raw.some((e) => e.name === 'Storage' && e.score === 333)).toBe(true);
  });

  it('defaults name to currentUser().name when name omitted', () => {
    signIn('default@example.com');
    const e = addScore({ score: 100, calmIndex: 50, round: 4 });
    expect(e.name).toBe('Default'); // capitalised local-part
  });

  it('falls back to "Wanderer" when no name and no signed-in user', () => {
    const e = addScore({ score: 100, calmIndex: 50, round: 4 });
    expect(e.name).toBe('Wanderer');
  });

  it('treats whitespace-only name as "missing" and falls back', () => {
    signIn('whitespace@example.com');
    const e = addScore({ score: 1, calmIndex: 1, round: 1, name: '   ' });
    expect(e.name).toBe('Whitespace');
  });

  it('explicit name wins over signed-in user name', () => {
    signIn('owner@example.com');
    const e = addScore({ score: 1, calmIndex: 1, round: 1, name: 'Override' });
    expect(e.name).toBe('Override');
  });

  it('defaults tier from calmIndex when tier omitted', () => {
    const e = addScore({ score: 100, calmIndex: 90, round: 5, name: 'Tiered' });
    expect(e.tier).toEqual(tierForCalmIndex(90));
    expect(e.tier.name).toBe('Blossom');
  });

  it('honours an explicit tier override', () => {
    const custom = { name: 'Custom', emoji: '⭐' };
    const e = addScore({
      score: 1,
      calmIndex: 50,
      round: 1,
      name: 'X',
      tier: custom,
    });
    expect(e.tier).toEqual(custom);
  });

  it('clamps score to a non-negative integer', () => {
    expect(addScore({ score: -50, calmIndex: 50, round: 1, name: 'A' }).score).toBe(0);
    expect(addScore({ score: 100.7, calmIndex: 50, round: 1, name: 'B' }).score).toBe(101);
    expect(addScore({ score: NaN, calmIndex: 50, round: 1, name: 'C' }).score).toBe(0);
  });

  it('clamps calmIndex to [0, 100] integer', () => {
    expect(addScore({ score: 1, calmIndex: -10, round: 1, name: 'A' }).calmIndex).toBe(0);
    expect(addScore({ score: 1, calmIndex: 999, round: 1, name: 'B' }).calmIndex).toBe(100);
    expect(addScore({ score: 1, calmIndex: 73.6, round: 1, name: 'C' }).calmIndex).toBe(74);
    expect(addScore({ score: 1, calmIndex: NaN, round: 1, name: 'D' }).calmIndex).toBe(0);
  });

  it('clamps round to a non-negative integer', () => {
    expect(addScore({ score: 1, calmIndex: 1, round: -5, name: 'A' }).round).toBe(0);
    expect(addScore({ score: 1, calmIndex: 1, round: 7.4, name: 'B' }).round).toBe(7);
    expect(addScore({ score: 1, calmIndex: 1, round: NaN, name: 'C' }).round).toBe(0);
  });

  it('handles being called with no args (all fields default)', () => {
    expect(() => addScore()).not.toThrow();
    const e = addScore();
    expect(e.score).toBe(0);
    expect(e.calmIndex).toBe(0);
    expect(e.round).toBe(0);
    expect(e.name).toBe('Wanderer');
  });

  it('high score lands at top of getLeaderboard()', () => {
    addScore({ score: 99999, calmIndex: 100, round: 99, name: 'Apex' });
    const top = getLeaderboard()[0];
    expect(top.name).toBe('Apex');
    expect(top.score).toBe(99999);
  });

  it('two consecutive addScore calls both appear (no overwrite)', () => {
    const before = getLeaderboard().length;
    addScore({ score: 10, calmIndex: 10, round: 1, name: 'AA' });
    addScore({ score: 20, calmIndex: 20, round: 2, name: 'AA' });
    const list = getLeaderboard();
    expect(list.length).toBe(before + 2);
    const mine = list.filter((e) => e.name === 'AA');
    expect(mine).toHaveLength(2);
  });
});

// ─── bestForCurrentUser ────────────────────────────────────────────────────

describe('bestForCurrentUser', () => {
  it('returns null when no user is signed in', () => {
    expect(bestForCurrentUser()).toBeNull();
  });

  it('returns null when signed in but no entries match the user', () => {
    signIn('nobody@example.com');
    expect(bestForCurrentUser()).toBeNull();
  });

  it('returns the highest-score entry for the signed-in user', () => {
    signIn('player@example.com');
    addScore({ score: 100, calmIndex: 50, round: 3 });
    addScore({ score: 800, calmIndex: 70, round: 8 });
    addScore({ score: 400, calmIndex: 60, round: 5 });
    const best = bestForCurrentUser();
    expect(best).not.toBeNull();
    expect(best.name).toBe('Player');
    expect(best.score).toBe(800);
  });

  it('does not return entries belonging to other users', () => {
    addScore({ score: 9999, calmIndex: 100, round: 99, name: 'Stranger' });
    signIn('me@example.com');
    addScore({ score: 50, calmIndex: 30, round: 2 });
    const best = bestForCurrentUser();
    expect(best.name).toBe('Me');
    expect(best.score).toBe(50);
  });
});

// ─── totalRoundsForCurrentUser ─────────────────────────────────────────────

describe('totalRoundsForCurrentUser', () => {
  it('returns 0 when signed out', () => {
    expect(totalRoundsForCurrentUser()).toBe(0);
  });

  it('returns 0 when signed in but no entries match', () => {
    signIn('zero@example.com');
    expect(totalRoundsForCurrentUser()).toBe(0);
  });

  it('sums round across all of the user\'s entries', () => {
    signIn('runner@example.com');
    addScore({ score: 1, calmIndex: 1, round: 5 });
    addScore({ score: 2, calmIndex: 1, round: 8 });
    addScore({ score: 3, calmIndex: 1, round: 12 });
    expect(totalRoundsForCurrentUser()).toBe(25);
  });

  it('ignores entries belonging to other users', () => {
    addScore({ score: 1, calmIndex: 1, round: 100, name: 'Other' });
    signIn('me@example.com');
    addScore({ score: 1, calmIndex: 1, round: 3 });
    addScore({ score: 1, calmIndex: 1, round: 4 });
    expect(totalRoundsForCurrentUser()).toBe(7);
  });
});

// ─── _resetMockData ────────────────────────────────────────────────────────

describe('_resetMockData', () => {
  it('removes the signed-in user', () => {
    signIn('reset@example.com');
    _resetMockData();
    expect(currentUser()).toBeNull();
  });

  it('restores the seed leaderboard (drops user-added entries)', () => {
    addScore({ score: 99999, calmIndex: 100, round: 99, name: 'WillBeWiped' });
    _resetMockData();
    const list = getLeaderboard();
    expect(list.some((e) => e.name === 'WillBeWiped')).toBe(false);
    // Seed length restored.
    expect(list.length).toBeGreaterThanOrEqual(12);
  });

  it('after reset, getLeaderboard tier objects come from ZEN_TIERS', () => {
    _resetMockData();
    const validNames = ZEN_TIERS.map((t) => t.name);
    for (const e of getLeaderboard()) {
      expect(validNames).toContain(e.tier.name);
    }
  });
});

// ─── Persistence across "page reload" (module re-import) ───────────────────

describe('persistence across module re-import (simulated reload)', () => {
  it('signIn persists — fresh module import sees the same user', async () => {
    // Sign in via the already-imported module instance.
    signIn('persist@example.com');
    expect(currentUser().email).toBe('persist@example.com');

    // Drop the module cache so next import boots fresh — analogous to a
    // page reload reading from localStorage on first init.
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    const u = fresh.currentUser();
    expect(u).not.toBeNull();
    expect(u.email).toBe('persist@example.com');
  });

  it('addScore persists — fresh module import sees the new entry', async () => {
    addScore({ score: 4242, calmIndex: 80, round: 10, name: 'Survivor' });
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    const list = fresh.getLeaderboard();
    expect(list.some((e) => e.name === 'Survivor' && e.score === 4242)).toBe(true);
  });

  it('signOut persists across reload', async () => {
    signIn('out@example.com');
    signOut();
    vi.resetModules();
    const fresh = await import('../src/mock-data.js');
    expect(fresh.currentUser()).toBeNull();
  });
});

// ─── Storage corruption / fault tolerance ──────────────────────────────────

describe('storage corruption tolerance', () => {
  it('malformed JSON in zen.user → currentUser returns null (not throw)', () => {
    localStorage.setItem('zen.user', '{not json');
    expect(() => currentUser()).not.toThrow();
    expect(currentUser()).toBeNull();
  });

  it('malformed JSON in zen.scores → getLeaderboard falls back to seed', () => {
    localStorage.setItem('zen.scores', '{ not json at all');
    expect(() => getLeaderboard()).not.toThrow();
    const list = getLeaderboard();
    expect(list.length).toBeGreaterThanOrEqual(12);
  });

  it('addScore survives read-side corruption by writing a fresh list', () => {
    localStorage.setItem('zen.scores', '{ totally corrupted');
    expect(() =>
      addScore({ score: 1, calmIndex: 1, round: 1, name: 'Resilient' }),
    ).not.toThrow();
    // After the write, getLeaderboard should now return parseable data
    // (the seed-based fallback list with the new entry appended).
    const list = getLeaderboard();
    expect(list.some((e) => e.name === 'Resilient')).toBe(true);
  });
});

// ─── Sort stability + addScore ordering ────────────────────────────────────

describe('leaderboard sort stability', () => {
  it('multiple entries with the SAME score keep relative order they were added', () => {
    _resetMockData();
    // Wipe seed first so we control the entire list.
    localStorage.setItem('zen.scores', JSON.stringify([]));
    addScore({ score: 100, calmIndex: 50, round: 1, name: 'First' });
    addScore({ score: 100, calmIndex: 50, round: 1, name: 'Second' });
    addScore({ score: 100, calmIndex: 50, round: 1, name: 'Third' });
    const tied = getLeaderboard().filter((e) => e.score === 100);
    expect(tied.map((e) => e.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('higher score always outranks a tied or lower one regardless of insert order', () => {
    _resetMockData();
    localStorage.setItem('zen.scores', JSON.stringify([]));
    addScore({ score: 100, calmIndex: 1, round: 1, name: 'Mid' });
    addScore({ score: 50, calmIndex: 1, round: 1, name: 'Low' });
    addScore({ score: 200, calmIndex: 1, round: 1, name: 'High' });
    const list = getLeaderboard();
    expect(list[0].name).toBe('High');
    expect(list[1].name).toBe('Mid');
    expect(list[2].name).toBe('Low');
  });
});

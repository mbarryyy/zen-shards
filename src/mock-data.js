// Mock auth + leaderboard data layer — pure data, no DOM.
//
// Phase 9 (dev-lead, task #3). Replaces the import-stub ui-3d-designer dropped
// in for Phase 10. Same surface, real localStorage persistence, seed entries
// keyed to the real ZEN_TIERS taxonomy from calm-index.js so leaderboard
// renders match the in-game tier emoji + name verbatim.
//
// Public API:
//   signIn(email)            → user            (writes to localStorage)
//   signOut()                → null
//   currentUser()            → user | null
//   getLeaderboard()         → entries sorted score desc
//   addScore({ score, calmIndex, tier?, round, name? }) → inserted entry
//   bestForCurrentUser()     → highest-score entry for the signed-in user
//   totalRoundsForCurrentUser() → sum of `round` across the user's entries
//   _resetMockData()         → test seam — wipes user + reseeds leaderboard
//
// Persistence model: localStorage keys `zen.user` (single user object) and
// `zen.scores` (array of leaderboard entries). On first import we auto-seed
// the scores key so a fresh browser has a populated leaderboard.

import { tierForCalmIndex } from './calm-index.js';

const STORAGE = {
  user: 'zen.user',
  scores: 'zen.scores',
};

// Seed leaderboard — 12 plausible mock players, scores 220→2380, tier objects
// sourced from ZEN_TIERS so a freshly-seeded board reads identical to one
// populated entirely from real game-overs.
const SEED = [
  { name: 'Wren',  score: 2380, calmIndex: 92, tier: tierForCalmIndex(92), round: 14 },
  { name: 'Hana',  score: 2120, calmIndex: 88, tier: tierForCalmIndex(88), round: 13 },
  { name: 'Kai',   score: 1890, calmIndex: 81, tier: tierForCalmIndex(81), round: 12 },
  { name: 'Mira',  score: 1640, calmIndex: 76, tier: tierForCalmIndex(76), round: 11 },
  { name: 'Sora',  score: 1410, calmIndex: 70, tier: tierForCalmIndex(70), round: 10 },
  { name: 'Eden',  score: 1180, calmIndex: 64, tier: tierForCalmIndex(64), round:  9 },
  { name: 'Iris',  score:  980, calmIndex: 58, tier: tierForCalmIndex(58), round:  8 },
  { name: 'Onyx',  score:  820, calmIndex: 52, tier: tierForCalmIndex(52), round:  7 },
  { name: 'Pax',   score:  640, calmIndex: 45, tier: tierForCalmIndex(45), round:  6 },
  { name: 'Lyra',  score:  490, calmIndex: 38, tier: tierForCalmIndex(38), round:  5 },
  { name: 'Tessa', score:  340, calmIndex: 30, tier: tierForCalmIndex(30), round:  4 },
  { name: 'Vale',  score:  220, calmIndex: 22, tier: tierForCalmIndex(22), round:  3 },
];

function read(key, fallback) {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, val) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* quota / private mode — best effort */
  }
}

function ensureSeed() {
  const stored = read(STORAGE.scores, null);
  if (!stored || !Array.isArray(stored) || stored.length === 0) {
    write(STORAGE.scores, SEED);
  }
}
ensureSeed();

function nameFromEmail(email) {
  if (!email || typeof email !== 'string') return 'Wanderer';
  const local = email.split('@')[0] || 'Wanderer';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * "Sign in" with just an email — mock auth, no password, no validation
 * beyond a non-empty trimmed string. Returns the persisted user.
 *
 * @throws {Error} when the email is empty/whitespace.
 */
export function signIn(email) {
  const normalised = String(email || '').trim().toLowerCase();
  if (!normalised) throw new Error('signIn requires an email');
  const user = {
    email: normalised,
    name: nameFromEmail(normalised),
    signedInAt: Date.now(),
  };
  write(STORAGE.user, user);
  return user;
}

export function signOut() {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(STORAGE.user); } catch { /* ignore */ }
  }
  return null;
}

export function currentUser() {
  return read(STORAGE.user, null);
}

export function getLeaderboard() {
  const list = read(STORAGE.scores, SEED.slice());
  return [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Push a score to the leaderboard. Anonymous users land as "Wanderer"
 * unless an explicit `name` is supplied. Tier defaults to whatever
 * tierForCalmIndex maps the supplied calmIndex to — keeps the leaderboard
 * coherent even when callers forget to pass tier.
 *
 * @param {object}   entry
 * @param {number}   entry.score
 * @param {number}   entry.calmIndex
 * @param {{name:string,emoji:string}} [entry.tier]
 * @param {number}   [entry.round]
 * @param {string}   [entry.name]   override the signed-in user's name
 * @returns {object} the inserted entry
 */
export function addScore({ score, calmIndex, tier, round, name } = {}) {
  const user = currentUser();
  const calmNum = Number(calmIndex) || 0;
  const entry = {
    name: (typeof name === 'string' && name.trim()) || user?.name || 'Wanderer',
    score: Math.max(0, Math.round(Number(score) || 0)),
    calmIndex: Math.max(0, Math.min(100, Math.round(calmNum))),
    tier: tier ?? tierForCalmIndex(calmNum),
    round: Math.max(0, Math.round(Number(round) || 0)),
    at: Date.now(),
  };
  const list = read(STORAGE.scores, SEED.slice());
  list.push(entry);
  write(STORAGE.scores, list);
  return entry;
}

/**
 * Best-score helper used by the profile view.
 * Returns the highest-score entry for the current user, or null.
 */
export function bestForCurrentUser() {
  const user = currentUser();
  if (!user) return null;
  const mine = getLeaderboard().filter((e) => e.name === user.name);
  return mine[0] ?? null;
}

/** Total rounds played by the current user (sum across entries). */
export function totalRoundsForCurrentUser() {
  const user = currentUser();
  if (!user) return 0;
  return getLeaderboard()
    .filter((e) => e.name === user.name)
    .reduce((sum, e) => sum + (e.round ?? 0), 0);
}

// Test seam — clears all stored mock data (used by qa-tester).
export function _resetMockData() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE.user);
    localStorage.removeItem(STORAGE.scores);
  } catch { /* ignore */ }
  ensureSeed();
}

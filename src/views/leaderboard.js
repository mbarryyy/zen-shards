// Leaderboard view — top 10, no pagination, clean table.
// Each row: rank · name · score · tier emoji.

import { getLeaderboard, currentUser } from '../mock-data.js';

let cleanup = null;

export function mount(container) {
  const top = getLeaderboard().slice(0, 10);
  const me = currentUser();

  const rows = top
    .map((entry, i) => {
      const rank = i + 1;
      const isMe = me && entry.name === me.name;
      const tierEmoji = entry.tier?.emoji ?? '';
      const tierName = entry.tier?.name ?? '';
      return `
        <li class="leaderboard__row${isMe ? ' leaderboard__row--me' : ''}"
            aria-label="Rank ${rank}, ${escapeHtml(entry.name)}, score ${entry.score}, ${tierName}">
          <span class="leaderboard__rank" aria-hidden="true">${rank.toString().padStart(2, '0')}</span>
          <span class="leaderboard__name">${escapeHtml(entry.name)}${isMe ? ' <em>· you</em>' : ''}</span>
          <span class="leaderboard__score">${entry.score}</span>
          <span class="leaderboard__tier" title="${escapeHtml(tierName)}" aria-hidden="true">${tierEmoji}</span>
        </li>
      `;
    })
    .join('');

  container.innerHTML = `
    <section class="leaderboard glass-card" aria-labelledby="lb-title">
      <header class="leaderboard__header">
        <h1 id="lb-title">Leaderboard</h1>
        <p class="leaderboard__subtitle">Top stillness this season</p>
      </header>
      ${
        top.length === 0
          ? `<p class="leaderboard__empty">No scores yet. Play a round to begin.</p>`
          : `<ol class="leaderboard__list" aria-label="Top players">${rows}</ol>`
      }
    </section>
  `;

  cleanup = () => {};
}

export function unmount() {
  cleanup?.();
  cleanup = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

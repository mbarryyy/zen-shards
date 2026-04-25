# Zen Shards — Mobile Audit (Phase M1)

Owner: **ui-3d-designer**
Reviewed surface: `index.html` (all CSS) + `src/views/*.js` + `src/ui.js`
Target widths: **320 / 375 / 414 / 768** (portrait phones → small tablet)
Branches downstream: M2 (scene/balls — dev-lead), M3 (HUD — me), M4 (app shell — me), M5 (QA — qa-tester)

This is the working checklist. Any issue here either gets a fix in M2/M3/M4 or an explicit `WONTFIX (rationale)` note. QA verifies against this list in M5.

---

## 0. Global / viewport-level

- [ ] **Viewport meta missing `viewport-fit=cover`.** Without it, `env(safe-area-inset-*)` returns 0 on notched iOS — every safe-area fix below silently no-ops. Update `<meta name="viewport">` first.
- [ ] **No safe-area-inset usage anywhere.** On iPhone X+ portrait the notch obscures the top nav (`top:0`) and HUD pill row (`top:80px` — obscured by status bar on shorter phones); home indicator overlaps the calm bar (`bottom:22px`). Landscape: side bezel inset is ignored.
- [ ] **Body has no `overflow-x: hidden` safety.** `html, body { overflow: hidden }` is set globally on the page-container shells, but transforms + `translateX(-50%)` on the HUD top row can introduce sub-pixel overflow that triggers iOS rubber-band on the root. Add `overflow-x: hidden` on `body` defensively.
- [ ] **Only one breakpoint exists (`max-width: 540px`).** Spec calls for ≤480 (phone portrait), ≤600 (phone landscape / small tablet), ≤768 (tablet). The single 540 cutoff means 320 and 414 share rules and 768 gets desktop layout (broken landing/leaderboard).
- [ ] **No `clamp()` font scaling on headlines.** Landing title, auth/leaderboard/profile h1s use fixed sizes that need a media-query stairstep instead of fluid scaling.
- [ ] **`prefers-reduced-motion` is wired** (✓ keep). No fix needed, just verify all new mobile CSS continues to honor it.

---

## 1. HUD top pills — `.hud-top` / `.hud-pill`

- [ ] **Pills overflow at ≤375px.** 3 pills × (8px × 16px padding + ~60px content) + 2 × 12px gaps ≈ **300–340px** rendered width. Combined with `translateX(-50%)` centering this clips on 320px viewports and looks crowded on 375px.
- [ ] **`top: 80px` collides with status bar / notch on iPhone SE / iPhone 13 mini portrait.** Should reduce to ~14px above safe-area on ≤480px.
- [ ] **No flex-wrap.** If a future pill is added or "Streak: 100" widens past available space, pills will overflow horizontally rather than wrap.
- [ ] **Pill font 13px / label 10px.** Per spec → drop to 11px / 9px on ≤480px and tighten padding to 6px 12px, gap 8px.

## 2. HUD lives — `.hud-lives`

- [ ] **`top: 158px` is hardcoded.** When pill row shrinks on mobile, the lives strip is left floating with a big gap below the pills. Should follow the pill row's bottom edge.
- [ ] **Gap 12px between dots — fine on all widths**, but spec asks for 10px on ≤480px for tighter cluster.
- [ ] **Dots are 10×10px non-interactive** — meets visibility, no touch concern.

## 3. HUD phase hint — `.hud-hint`

- [ ] **`top: 128px` hardcoded** — same coupling problem as lives; if pills shrink the hint floats far below.
- [ ] **`letter-spacing: 0.32em` at font-size 11px** makes "Memorise · Recall · Repeat" wider than 320px viewport. Spec: drop to 10px and tighten letter-spacing to ~0.22em on ≤480px.

## 4. HUD calm bar — `.hud-calm`

- [ ] **Total rendered width ~220–240px** (emoji 18px + 10gap + bar 140px + 10gap + value 22px + 10gap + label "CALM INDEX" ~70px + 28px padding). On 320px landscape this collides with the bottom-right level pill.
- [ ] **`left: 22px / bottom: 22px`** ignores home-indicator inset on notched phones — bar sits *under* the gesture area.
- [ ] **Spec rules:** bar 140 → 100px on ≤480px; on ≤360px collapse to **emoji + numeric value only** (hide bar + label).
- [ ] **Calm label font 9px** is below comfortable mobile read size — acceptable as decorative but verify legibility at native pixel density.

## 5. HUD level — `.hud-level`

- [ ] **`right: 22px / bottom: 26px`** + calm bar at left 22px → on 320px portrait the two collide visually (~340px combined). Hide on ≤480px (it duplicates the Round pill, already `aria-hidden`).
- [ ] **Same safe-area-inset issue** as calm bar.

## 6. Game-Over modal — `.hud-gameover` / `.hud-gameover__panel`

- [ ] **`min-width: 320px` on the panel + `padding: 36px 48px`** = 416px minimum content box. On a 320px viewport the panel **literally cannot fit** and will clip at the edges. Switch to `max-width: 92vw` and drop padding to 22–24px on ≤480px.
- [ ] **No internal scroll fallback.** With the Lives Used row added in Phase 11 the stats list can be tall; if landscape on a small phone clips the panel vertically the buttons become unreachable. Add `max-height: 88vh; overflow-y: auto` inside the panel.
- [ ] **Action buttons too small for touch.** `.hud-gameover__btn` padding `10px 26px` + font 12px ≈ **34–36px tall** — below WCAG 2.5.5 44px target. Bump to `12px 22px` minimum on mobile + ensure `min-height: 44px`.
- [ ] **Buttons wrap (flex-wrap ✓)** but on 320px three buttons in one row spill to 3 lines with weird centering. Stack column or full-width on ≤480px.
- [ ] **Title `font-size: 22px / letter-spacing: 0.32em`** = "STILLNESS" rendered ≈ 200px wide — fits, but tight. OK.

## 7. Top nav — `.app-nav`

- [ ] **`padding: 14px 28px`** + logo (~110px) + 3 link pills (~210px) + user badge (~60–180px depending on email length) → easily 400–500px wide. **Overflows below 414px**, links may wrap to second row or get clipped.
- [ ] **Existing 540px breakpoint reduces padding to 10px 16px** but that's not enough — links still won't fit at 320px with the logo and user name visible.
- [ ] **Link touch targets too small.** `padding: 6px 14px` + font 11px ≈ **26–28px tall** — failing WCAG. Increase to ≥44px (use min-height + center-align).
- [ ] **`.app-nav__signin` button** also ~28px tall — same WCAG miss.
- [ ] **Long usernames/emails in `.app-nav__user`** have no truncation. A user signed in as "alongname@longemaildomain.com" pushes the layout. Apply `max-width` + `text-overflow: ellipsis` on ≤600px.
- [ ] **No mobile menu pattern.** Spec says "links collapse to compact" — interpret as: hide `.app-nav__user-name` on ≤480px (keep avatar dot only) and tighten link padding while keeping touch targets compliant via min-height.
- [ ] **Nav background `rgba(255,255,255,0.42)` + blur** is fine, but on iOS Safari with safe-area the nav needs `padding-top: env(safe-area-inset-top)` so it doesn't slip under the notch.

## 8. Landing — `.landing` / `.landing__title` / `.landing__cta`

- [ ] **Title `font-size: 56px / letter-spacing: 0.36em`** = "ZEN SHARDS" ≈ 480px rendered. **Massive overflow on every mobile width.**
- [ ] **Existing 540px breakpoint** drops to 38px / 0.28em → still ~280px wide on 320px viewport, marginal. Use `clamp(2rem, 8vw, 4rem)` per spec, with letter-spacing also clamped.
- [ ] **`.landing__cta` is `flex-wrap: wrap`** — buttons wrap but each `.zen-btn` retains `min-width: 132px`. On 320px two buttons = 264 + 14gap = 278 → fits one per row. Spec: stack column with full-width buttons ≥48px tall on ≤600px.
- [ ] **`.zen-btn` height ~40px** (padding 12px + font 12px line-height) — borderline below 44px. Bump min-height to 48px on mobile.
- [ ] **`gap: 56px`** between brand block and CTAs is generous on desktop, wasteful on phone — drop to 32px on ≤480px.
- [ ] **`.landing__mark` 92×92px decorative orb cluster** — fine on phone.
- [ ] **Tagline letter-spacing 0.34em** — could wrap weirdly on 320px; verify "MEMORISE. RECALL. BLOOM." doesn't break.

## 9. Auth — `.auth` / `.auth__form`

- [ ] **`.auth__input { font-size: 14px }`** triggers **iOS Safari auto-zoom on focus** (anything <16px). Bump to 16px on mobile; users hate the zoom-in jolt.
- [ ] **`.glass-card` padding `44px 48px`** at 320px → only 224px content area. Existing 540px rule reduces to `28px 22px` (✓ keep, but extend).
- [ ] **Form inputs span the card width** (✓ via flex column). No fix needed structurally.
- [ ] **`.zen-btn` "Continue"** ~40px tall — bump to 48px min-height per spec.
- [ ] **Auth title `22px / 0.3em`** — fits but tight on 320; consider clamp.
- [ ] **`max-width: 420px`** is fine on tablet; spec says 360px on tablet+ — slight tightening.

## 10. Leaderboard — `.leaderboard__row` / `.leaderboard__list`

- [ ] **Grid `32px 1fr auto 28px` with 12px gaps + 16px row padding.** At 320px: 32 + 28 + 36(gaps) + 32(row pad) = 128px reserved → 192px for name+score. Long names (e.g. "Aurora Ridgewell · YOU" + 9-digit score) push the score column out of frame.
- [ ] **No card layout for narrow.** Spec: ≤600px convert table → vertical card list with rank+name top row and score+tier bottom row.
- [ ] **`.leaderboard__row` height ~40px (padding 10px 16px + 13px font)** — non-interactive, no touch target requirement, but if hover state ever becomes a click target, bump.
- [ ] **`.leaderboard__header h1` 22px / 0.3em** = "LEADERBOARD" ≈ 250px wide → overflows at 320.
- [ ] **Subtitle "TOP STILLNESS THIS SEASON" letter-spacing 0.22em** — wraps awkwardly on 320; OK on 375+.
- [ ] **`.leaderboard__name em` ("· you" badge)** has no special handling on narrow — it inflates the name cell and pushes score. Move into rank line on ≤600px card layout.

## 11. Profile — `.profile__stats`

- [ ] **Stats grid `repeat(3, 1fr)`** at 320px → each cell ~95px wide → "BEST SCORE" label (font 9px, letter-spacing 0.22em) wraps to 2 lines and "Calm Index" tier label crashes the layout.
- [ ] **Existing 540px breakpoint already collapses to 1-col** (✓ partial fix). Spec asks 2-col → 1-col on ≤480px (intermediate 2-col on tablet/landscape phone). Implement the 2-col tier at 481–768px or accept 1-col below 540px (current behavior).
- [ ] **Profile h1 26px / 0.22em** — at 320px "JIAWEI YANG" + letter-spacing fits, but a 12+ char name will overflow. Use clamp.
- [ ] **`.profile__email` 12px** — readable, but long emails have no ellipsis → can clip. Add `word-break` or truncation.
- [ ] **`.profile__actions` flex-wrap** ✓ — buttons stack OK; same 44px height issue as elsewhere.
- [ ] **Stat `dt` font-size 9px** — borderline tiny on mobile; fine if antialiased on retina.

## 12. Touch targets summary (WCAG 2.5.5 — ≥44×44px)

| Element | Current | Status |
|---|---|---|
| `.zen-btn` | ~40×var | ⚠ borderline |
| `.hud-gameover__btn` | ~36×var | ❌ fail |
| `.app-nav__links a` | ~28×var | ❌ fail |
| `.app-nav__signin` | ~28×var | ❌ fail |
| `.auth__input` | ~42×full | ⚠ borderline + iOS zoom |
| `.landing__cta` button | ~40×132 | ⚠ borderline |
| Lives dots | 10×10 | ✓ non-interactive |
| Canvas (whole-screen pick) | full viewport | ✓ |

All `❌` and `⚠` rows fixed in M3/M4 by enforcing `min-height: 44px` (48px on primary CTAs).

## 13. Breath ambient layer — `#breath-ambient`

- [ ] **Behaves correctly across viewports** — `position: fixed; inset: 0` adapts. No fix.
- [ ] **`mix-blend-mode: multiply`** with the radial-gradient pulse is GPU-light; verify on low-end Android (qa-tester to spot-check). No code change expected.

## 14. Game scene / canvas / ball positions (out of scope for me — flag for M2)

> These belong to **dev-lead** in Phase M2 — listed here so they're not lost.

- [ ] Ball position bounds `x:[-5,5], y:[-3,3], z:[-2,2]` assume ~16:9 aspect. Portrait phone aspect ≈ 9:19.5 → balls in `x:±5` clip outside the visible frustum on narrow widths.
- [ ] `createScene()` camera FOV / z-distance likely tuned for desktop — needs aspect-aware tuning so balls stay reachable on portrait.
- [ ] Pointer-pick uses raw `clientX/Y` against the canvas — assumes canvas fills its container (✓ via `play__canvas { inset: 0 }`); no pointer-event fix needed at the CSS layer.
- [ ] **Resize/orientation handling** (flagged by qa-tester): `scene.js` `onResize` listens on `window` `resize` only. iOS Safari toolbar collapse fires resize, but a tab-inactive rotate (rotate while another tab is foregrounded, then return) may not. Subscribe additionally to `visibilitychange` and `orientationchange`, recomputing camera aspect + renderer size on each. Test by rotating the device while the play tab is backgrounded.

---

## Fix-ownership map

| Section | Phase | Owner |
|---|---|---|
| 0. Global (viewport meta, safe-area, breakpoints, clamp) | M3 + M4 | ui-3d-designer |
| 1–6. HUD pills/lives/hint/calm/level/game-over | **M3** | ui-3d-designer |
| 7. Top nav | **M4** | ui-3d-designer |
| 8. Landing | **M4** | ui-3d-designer |
| 9. Auth | **M4** | ui-3d-designer |
| 10. Leaderboard | **M4** | ui-3d-designer |
| 11. Profile | **M4** | ui-3d-designer |
| 12. Touch targets | M3 + M4 | ui-3d-designer |
| 13. Breath layer | none | — |
| 14. Scene/balls | **M2** | dev-lead |

---

## Verification grid (qa-tester reference for M5)

For each fixed item, qa-tester verifies at:

- **320×568** (iPhone SE 1st gen — smallest realistic portrait)
- **375×667** (iPhone SE 2/3, iPhone 13 mini)
- **414×896** (iPhone 11 Pro Max, iPhone XR)
- **768×1024** (iPad portrait)
- **landscape** of 375 and 414 (for HUD/canvas behavior)
- **with notch simulation** (Safari Develop → User Agent → iPhone 14 Pro)
- **with reduced-motion** toggled on

Pass criteria per item:
1. No horizontal scroll at any tested width.
2. All interactive elements ≥44×44px.
3. Text readable without zoom (≥11px body, ≥16px form inputs).
4. Layout doesn't overlap critical chrome (HUD does not cover canvas pickable area, nav does not hide page content).
5. Safe-area insets respected on notched simulation.

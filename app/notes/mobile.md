# Mobile notes: phones in portrait and landscape

Builds on the 1024 px panel breakpoint and the adaptive fov of the desktop layout, and on sessions.md (Sessions tab, permission
cards). Desktop (≥ 1024 px, fine pointer) is unchanged.

## Files

- **New**
  - `src/components/layout/layoutMode.ts`: the three layouts as media queries, `currentLayoutMode()` and
    `useLayoutMode()` (`useSyncExternalStore` on two `matchMedia` lists; leaf components only).
- **Changed**
  - `src/app/globals.css`: the `phl` and `sheet` custom variants, the coarse-pointer rules (16 px form controls,
    44 px `.btn`), and the `.free-area` size container that hides `.camera-bar` when the world slot is short.
  - `src/app/layout.tsx`: `interactiveWidget: "resizes-content"`.
  - `AppShell.tsx`: safe-area gutters on every side, the landscape grid, insets per layout, the drag pause and
    `aaw:sheet-settled`, the permission layer under the sheet.
  - `TopBar.tsx`: one row on phones (title, short mode line, status, run toggle, New task, menu).
  - `SimulationControls.tsx`: `CompactSimControls` and its menu; the desktop row shares its state hook.
  - `NavRail.tsx`: a 52 px vertical icon rail on landscape phones; a tap raises a peeking sheet.
  - `SidePanel.tsx`: the draggable bottom sheet (three snap points) and the landscape column.
  - `CameraBar.tsx`: one button with an upward menu on landscape phones.
  - `SessionsPanel.tsx`: the composer grows with its text below 1024 px, a short placeholder, and focus takes the
    sheet to full; the chat header drops its cwd line on landscape phones.
  - `PermissionStack.tsx`, `ui.tsx` (`Segmented` gains `lg`; touch sizes on `Segmented` and `Toggle`),
    `backendCaps.ts` (`shortModeLine`).

## Breakpoints

| Layout | Query | Shell |
|---|---|---|
| desktop | `min-width: 1024px` (Tailwind `lg`) | rail, top bar, right column (unchanged) |
| landscape phone (`phl`) | `(orientation: landscape) and (max-height: 500px) and (max-width: 1023.98px)` | rail \| top bar over world \| panel |
| sheet (`sheet`) | everything else below 1024 px | top bar, world, bottom sheet, bottom tab bar |

- The top bar is one row below 768 px and on landscape phones. Tablets in portrait (768–1023 px) keep the
  Phase 6 full row, which wraps.
- Touch sizing keys off `(pointer: coarse)`, not width, so a touch tablet in the desktop layout also gets 44 px
  buttons, and a narrow desktop window does not.
- `phl` and `sheet` are `@custom-variant`s in globals.css; Tailwind emits them after `md`/`lg`, so they win
  over `md:` classes (checked in the compiled CSS). `layoutMode.ts` mirrors the same queries for behaviour.

## Decisions

- **Landscape phones: a grid, not a second component tree.** The main column becomes
  `grid-cols-[minmax(0,1fr)_clamp(300px,44vw,380px)]` with two rows; the row wrapper is `display: contents`,
  so the top bar and free area stack in column 1 and the panel spans both rows in column 2. The rail moves to
  the left (`order-first`), as on desktop. The insets are measured as on desktop (left = rail, right = panel,
  top = top bar), so the camera fit frames the office in the world column.
- **Top bar on phones.** Title, a short mode line (`shortModeLine`, full text in the tooltip), a status pill
  (dot only below 420 px and on landscape phones; the label stays for screen readers), the run toggle, New task
  (only when the backend accepts tasks) and a menu. The menu holds speed (a full-width 44 px segmented
  control), sound, notifications (live), reset/clear with its confirm, and Run demo / Load sprint (simulation
  only). It closes on outside press, Esc, or after an action.
- **Bottom sheet.**
  - Snap points: *peek* = the header (handle and title, 61 px); *half* = 46 dvh (56 dvh on Sessions);
    *full* = all the space between the top bar and the tab bar (688 px at 390×844, about 82 dvh). Full stops at
    the top bar instead of 90 dvh, so status, pause and the menu stay reachable.
  - The whole header is the handle (a 60 px target). Tap: peek → half, half → peek, full → half. The chevron:
    → full, and full → half. Arrow keys on the handle step through the snaps. A drag follows the finger; release
    goes to the nearest snap, or to the next one in the direction of a flick (> 0.45 px/ms).
  - Opening a task, an agent, a session or any tab raises a peeking sheet to half. Focusing the Sessions
    composer goes to full (the keyboard takes the other half). The body is `inert` while peeking.
  - **Off React's render path.** The height is `style.height` on the node, written per pointer move; React
    renders `SidePanel` only when the snap changes, and `SidePanel` does not parent the Canvas. AppShell's
    inset measure skips while `data-dragging` is set and runs on `aaw:sheet-settled`, then follows the
    ResizeObserver through the 260 ms height transition, so the camera refits once per settle, not per move.
  - `prefers-reduced-motion`: the height transition is off (`motion-reduce:transition-none`, plus the global
    reduced-motion rule).
- **Camera bar.** Portrait: the row above the sheet, with 44 px buttons on touch. It hides through a container
  query when the free area is under 76 px tall (sheet at full, or mid-drag), with no React render. Landscape
  phones: one button at the bottom left of the world, opening the presets upward, so it never meets the top bar.
- **Permission cards.** Desktop and landscape: unchanged, over the free area. Under the sheet the layer hangs from
  the top of the free area with a `100dvh − 10rem` height instead of the free area's, so the cards stay visible
  and tappable over a full sheet; it is `z-10` above the sheet.
- **Forms.** Unlayered `@media (pointer: coarse)` rule: inputs, textareas and selects are 16 px (iOS zooms the
  page on focus below that). Unlayered CSS beats Tailwind's layered utilities, so no `!important` is needed.
- **Safe areas.** The shell pads `max(8px, env(safe-area-inset-*))` on all four sides below 1024 px (landscape
  notch included); desktop keeps 12 px. `viewport-fit=cover` was already set.
- **Keyboard.** `interactiveWidget: "resizes-content"` shrinks the layout viewport; the sheet recomputes its
  snap heights on `resize`.
- **Rotation.** No component above the Canvas reads the layout: AppShell is CSS-only, and the leaves
  (`SidePanel`, `TopBar` via CSS, `CameraBar` via CSS, `Composer`) re-render on the `matchMedia` change. The
  sheet clears its inline height outside the sheet layout.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test` (engine, sound, sessions) and `npm run e2e` (which runs
  `npm run build`; 1440×900 desktop smoke test) all pass.
- Screenshots: `/tmp/aaw-mob/before/` (HEAD) and `/tmp/aaw-mob/after/`. They were taken with `cdp.mjs` and
  `MOBILE=1` (touch, `pointer: coarse`) except at 1440×900, from `/tmp` copies on `next dev --webpack`
  (3230 simulation; 3231 websocket against `npm run server -- --source claude-code --control --port 8799`, with
  `bridge/real-session-fail-fix-pass.jsonl` replayed). Sizes: 390×844, 375×667, 844×390, 667×375, 768×1024,
  1024×768 and 1440×900. Each size has `sim-ov-*` (Overview, demo running), `sim-task-*` (T-001 open) and
  `live-chat-*` (Sessions chat with the composer).
- **Desktop unchanged.** Pixel diff of before/after `sim-task-1440x900-18s.png`: the top bar, rail, camera bar
  and panel header are identical (tolerance 40/255). The only difference is 8 px of the status dot's pulse.
- **Landscape.** Before: the world was invisible and the camera bar sat on the top bar's controls
  (`before/sim-ov-844x390`, `before/sim-ov-667x375`), and the chat showed one line (`before/live-chat-844x390`).
  After: rail | world | panel, the office framed in the world column, and about 10 lines of chat with the composer
  (`after/sim-task-844x390`, `after/sim-task-667x375`, `after/live-chat-844x390`, `after/live-chat-667x375`).
  Camera menu open: `after/rot-20s.png`.
- **Portrait.** One-row top bar and a taller world (`after/sim-task-390x844` vs `before/…`). Sheet snaps:
  `after/snap-18s.png` (peek, 61 px), `after/snap-21s.png` (half after a tap on the handle, 388 px) and
  `after/snap-15s.png` (full, 688 px, camera bar hidden). These were driven by a real drag
  (`drag=195,400,195,40` → full; `drag=195,90,195,820` → peek). Controls menu: `after/menu-13.5s.png`.
  Composer focused by a click → sheet full, chat readable, textarea 16 px: `after/compose-17s.png`.
- **Permission cards** (a fake ask injected through a store handle added only to the /tmp copy, so no real
  Claude run): over a full sheet, with `elementFromPoint` at Allow's centre returning Allow and the button
  44 px tall (`after/perm-full-15s.png`), and over the world column in landscape (`after/perm-l-14s.png`).
- **Rotation** 390×844 → 844×390 → 390×844 (`cdp2.mjs` with `Emulation.setDeviceMetricsOverride`
  mid-run): the same `<canvas>` element throughout, one canvas, `scrollWidth === innerWidth`. The insets went
  `{top 62, left 60, right 379, bottom 0}` in landscape and `{top 66, bottom 462}` back in portrait. The sheet's
  inline height was cleared in landscape and restored (388 px) in portrait (`after/rot-18s`, `after/rot-24s`).
- **Reduced motion** (`RM=1`): the sheet's computed `transition-duration` is 1e-05 s and a tap lands on peek
  immediately (`after/rm-13s.png`).
- Console: no errors in any run; only the known upstream `THREE.Clock` warning.
- Tablets: 768×1024 keeps the wrapped full top bar, now with the draggable sheet. At 1024×768 (touch), the
  44 px buttons make the top bar about 12 px taller, and the camera bar now fits instead of clipping
  "Collaboration".

## Known gaps

- Checked in Chrome's device emulation only, not on real iOS/Android hardware. Safe-area insets, iOS
  focus zoom and `interactive-widget` (Chrome 108+; Safari ignores it and overlays the keyboard) need a device.
- At 667×375 the title truncates ("AI Agent …") to keep the status, run, New task and menu buttons.
- Mid-drag the camera does not reframe (by design); it refits on release, through the 260 ms settle.
- A permission card over a full sheet is translucent (`.surface`), so the sheet text shows faintly through it.
- The Next.js dev indicator ("N") overlaps the bottom-left rail/tab item in dev only.

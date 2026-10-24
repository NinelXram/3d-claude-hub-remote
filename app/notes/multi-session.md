# Multi-session notes: several Claude Code sessions at once

Before this change, every hook from every session called `holdAt` / `switchTo` on the same six robots, so with two
sessions running the robots flickered between them. The robots stand for kinds of action (read → Iris, edit → Kai…),
not for agents, so now **one focused session drives them** and every other session still counts everywhere else.

## Files

- **Engine (examples/phase1-engine)**
  - `src/live/LiveAgentBackend.ts`: per-session state (`LiveSession`: cwd/project, title, status, last activity,
    task, holder, and a *stage* map of every robot it holds and where). Robot motion goes through session-aware
    wrappers (`hold`, `unhold`, `emoteFor`, `actFor`, `linkFor`) that only touch controllers for the focused session.
    `autoFocus`, `setFocus` (re-staging), `prune`, `focusSession(id | null)`, and `snapshot().live`.
  - `src/integrations/AgentBackend.ts`: `WorldSnapshot.live?` (`LiveWorldState`, `LiveSessionSummary`), the
    `focusSession` command and the optional `AgentBackend.focusSession?`. `WebSocketAgentBackend.focusSession`.
    Both files copied verbatim to `app/src/integrations`.
  - `src/tasks/taskTypes.ts` (both copies, identical): optional `Task.origin = { sessionId, project }`.
  - `server/worldServer.ts`: `focusSession` in the world command switch (no token needed on loopback, like the
    other world commands; remote pages need the token for everything, as before).
  - `scripts/live-test.ts`: 10 new checks (see Verification).
- **App**
  - New `components/layout/SessionSwitcher.tsx` (`SessionSwitcher` bar/compact, `useLiveSessions`).
  - `TopBar.tsx`: the bar switcher after the title on ≥ 768 px; on portrait and landscape phones the compact
    switcher replaces the short mode line (the mode line stays in its tooltip and Settings → Backend).
  - `state/useWorldStore.ts`: `live` mirrored; it is part of the significant signature, and the same object is
    kept while its signature is unchanged so the switcher does not re-render with progress.
  - `integrations/backendClient.ts`: `commands.focusSession`.
  - `audio/attention.ts`: `sessionOf`, session/project on `Attention`, `attentionTitle`, `attentionRank`;
    `clearsAttention` ignores other sessions' activity; `permissionEvent` takes the session's title/project.
  - `audio/useSoundEffects.ts`: one attention entry per session; the title shows the most urgent, newest first,
    with "(+N)" for the rest.
  - `sessions/sessionUi.tsx`: `SessionDot`, `ProjectChip` (stable hue per project), `useMultiSession`.
  - `ActivityFeed.tsx`, `TaskCard.tsx`, `PermissionStack.tsx`: project chips.
  - `SessionsPanel.tsx`: search + project filter chips, "Follow in 3D" on rows and in the chat header.
  - `world/Workstations.tsx`: the mission-control wall shows the followed session and "+N other sessions".
  - `scripts/sound-test.ts` (+4 checks), `scripts/sessions-test.ts` (+1 check).

## Decisions

- **One time base for focus**: the backend's wall clock (`opts.now`), not the sim clock, because the live clock stops
  while the view is paused but sessions keep running. Tests drive both from one simulated time.
- **Status per session** is set from the hook *before* focus is decided, so a session that takes focus plays the
  hook out in full (handoff arc included). running: prompt or tool hook · waiting: PermissionRequest/Notification ·
  idle: Stop/StopFailure (and a fresh SessionStart) · ended: SessionEnd. Tool hooks within 2 s of an ask do not end
  the wait (parallel calls); when a wait ends, Orion leaves the hub unless Orion holds the session.
- **Auto focus** (default): no focus → the most active session (waiting, then running, then idle; newest within).
  Focus leaves a session only when it has been idle for ≥ 8 s (`FOCUS_IDLE_MS`, time since its last hook, turn ended
  or not), and only for a session that is running or waiting. An *ended* focused session hands over at once (to an
  idle one too). A session starting to wait (PermissionRequest/Notification) takes focus at once. A *waiting* focused
  session keeps focus however busy the others are. Checked on every hook and every tick (cheap: ≤ 12 sessions).
- **Pinned**: holds through other sessions' asks and activity, until you pick another session or Auto; if the pinned
  session drops out of the list, focus falls back to Auto. Choosing Auto jumps straight to the most active session
  (no hysteresis), since that is what the click asks for. Pinning a session the world has no hooks from is refused
  with a reason ("No hooks from that session…").
- **Re-staging**: on focus change each robot the new session holds goes to its stage (location, status, activity);
  every other robot's queue is cleared and it walks home on the next tick instead of after the 2.5 s pause. Arcs in
  flight are dropped (they belonged to the other story). No feed event is emitted for a focus change; the switcher
  and the wall show it.
- **Non-focused sessions** keep tasks, phases, feed events and sounds. They never create links or move robots.
  Every hook-caused event carries `metadata.session`, `metadata.project` and `metadata.sessionTitle`; tasks carry
  `origin`. The existing `task.created → session` mapping still works.
- **Snapshot `live`**: always present for the live source; sessions newest first, ended ones dropped after 3 min,
  any session silent for 1 h dropped, at most 12.
- **Attention**: the bell plays for any session's ask (unchanged cue rules). The tab title names the project
  ("⏳ Permission needed · infra · 3D Claude Hub Remote") and the notification body starts "project · title:". Only the
  same session's activity clears its entry; a waiting entry outranks another session's "Turn ended".
- **Chips only when they help**: feed rows and task cards show the project chip when more than one session is in
  view (`useMultiSession`). On live task cards the chip takes the place of the always-"medium" priority tag.
- **Mobile**: no new rows. Portrait and landscape phones put the switcher on the title's second line (where the
  short mode line was); the menu is the same list at `min(380px, 100vw − 24px)`, with 44 px rows on coarse pointers.

## Verification

- Engine: `npx tsc --noEmit`; `npm test`, `test:ws`, `test:live` (54 checks), `test:install`, `test:sound`,
  `test:sessions` all pass. New live checks, built by merging the `bridge/*.jsonl` recordings with rewritten
  `session_id`/`cwd` and time offsets:
  - two interleaved sessions: auto focus never leaves the first while it works, and **the robots' positions, statuses
    and activities at every one of its hooks are identical to replaying it alone** (no flicker); the other session's
    events and task still arrive tagged with its project; the snapshot lists both;
  - hysteresis: B's hooks 4 s after A's turn ended do not take focus; focus moves within 0.1 s of A being idle 8 s;
    then returns to A at once when B ends;
  - re-staging on that switch (B's robot to its station, everyone else heading home), and on a pin (after 8 s B's
    robot is at its station holding B's activity, A's robot is home);
  - a PermissionRequest steals focus at once (Orion heads to the hub), keeps it while waiting, and focus returns
    when that session ends; the warning carries session, title and project;
  - a pin holds through another session's ask; unknown ids are refused; Auto jumps to the most active; ended
    sessions leave the snapshot after 3 min;
  - `focusSession` over WebSocket without the sessions token (token scope "sessions").
- App: `npm run typecheck`, `npm run lint`, `npm test` (engine, sound +4, sessions +1), `npm run build`,
  `npm run e2e` (1 passed, 1.1 min) all pass. Evaluator: 14/14 (demo 72.9 s, sprint 328.7 s, 7/8).
- Browser: `/tmp` copy on `next dev --webpack -p 3240`, server `--source claude-code --control --port 8796`, three
  concurrent replays at 0.6× (sample-session as shop-api; fail-fix-pass as `billing`, +4 s; permission as `infra`,
  +12 s). Read back from the page: focus stayed on shop-api while billing and infra ran; when infra asked, focus was
  infra (auto) and the title "⏳ Permission needed · infra · 3D Claude Hub Remote"; with shop-api pinned, infra's later
  ask did not move focus but still set the title. Console: only the known `THREE.Clock` warning.
  Screenshots in `/tmp/aaw-multi-shots/`:
  - `d-31s.png` desktop switcher menu (infra waiting has focus, +2 badge, chips per project);
  - `e-30s.png` desktop, world following shop-api while billing runs; `wall-crop.png` the wall ("FOLLOWING: Add rate
    limiting… · shop-api", "+1 other session (1 running)");
  - `e-68s.png` pinned shop-api, Activity feed with project chips from all three sessions;
  - `p-32s.png` portrait 390×844 menu; `p-58s.png` portrait following infra while it waits (amber dot, +2);
  - `l-32s.png` landscape 844×390 menu;
  - `s-42s.png` Sessions tab with search, project chips ("billing" selected) and the Follow column.
- Everything started was stopped (ports 3240 and 8796 free), the /tmp app copy was deleted, `app/AGENTS.md` removed.
  Ports 3210 and 8787 were never touched.

## Known gaps

- Screenshots were taken with four headless Chromes in parallel, so the first run's marks drifted; the second
  desktop run (`e-*`) is on time. Checked in device emulation only.
- The Sessions list comes from the session hub, which also lists older sessions it found on disk (39 here), so the
  project chips there can outnumber the sessions the world knows. "Follow" is disabled for those until a hook arrives.
- Two sessions in the same folder share a project chip; the tooltip shows the session title.
- A waiting focused session keeps focus indefinitely in Auto, even if you never answer; pick another session to move.
- Two sessions that start waiting in turn take focus from each other each time (newest ask wins).
- Session status in the switcher comes from hooks; the hub's own status (Sessions tab) is computed separately and can
  differ briefly (e.g. the hub marks only terminal sessions as waiting).
- The bundled viewer (`examples/phase1-engine/viewer`) does not show the switcher; it still works with the
  focused-session robots.
- On a test server on another port, web-started sessions still post hooks to 8787 (see sessions.md), so they do not
  appear in the world's session list there.

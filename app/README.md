# 3D Claude Hub Remote: the app

The web app of [3D Claude Hub Remote](../README.md) (start there for setup and the safety notes). A 3D office in the browser where six AI agents collaborate to ship software tasks: Orion (Orchestrator), Piper (Product Manager), Iris (Researcher), Kai (Software Engineer), Quinn (QA Engineer) and Rex (Code Reviewer). The world shows the state of a multi-agent system. Every walk, gesture, screen glow, speech bubble, sound and message arc comes from backend state and a fixed set of structured events.

**Run on its own (`npm run dev`), nothing here is AI.** The backend is then a deterministic local simulation. No LLM is called, no code is written, and every output is a canned template. The top bar, the task dialog, Settings and the demo callout all say so. You can swap in a real orchestrator over WebSocket without touching the 3D layer or the UI; see [Connecting a real backend](#connecting-a-real-backend).

## Run it

Requires Node ≥ 22.6.

```bash
npm install
npm run dev
```

- `npm run dev`: http://localhost:3000

Press **Run demo**. One task, "Build a user authentication API with JWT support", goes through the whole team:

1. Orion delegates it.
2. Piper plans it.
3. Iris researches it.
4. Kai builds it.
5. Quinn fails build #1.
6. Kai fixes it, and Quinn passes build #2.
7. Rex approves it.
8. Orion announces it.

This takes about 73 simulated seconds at 1×. Use 4× in the top bar to watch it in about 18 s. The first click or key press turns sound on, because browsers block audio until then.

A production build: `npm run build && npm start`.

### Controls

| Key / control | What it does |
|---|---|
| Space | Start, pause or resume |
| N | New task dialog (simulation only) |
| B | Load the 8-task sprint (simulation only) |
| M | Mute or unmute sound effects |
| Esc | Clear the selection or follow, and close the dialog |
| Click a robot or desk | Open its panel and focus the camera. **Follow** keeps the camera on it |
| Drag, scroll | Orbit and zoom. A drag never clears the selection |
| Camera bar | Overview, Ops Hub, Research, Development and Collaboration presets |

Settings has rendering quality (High quality or Performance; the app falls back to Performance on its own if frames are slow), overlays (walking paths, speech bubbles), sound, and the backend status with its env vars.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:sound
npm run test:sessions
npm run e2e
```

- `npm run typecheck`: tsc --noEmit, strict
- `npm run lint`: eslint src (flat config, eslint-config-next 16)
- `npm test`: engine checks (scripts/simulate.ts), then the sound checks (scripts/sound-test.ts), then the sessions checks (scripts/sessions-test.ts)
- `npm run test:sound`: the sound and "Claude needs you" checks on their own
- `npm run test:sessions`: the Sessions client against an in-memory fake server (list, open, upsert, fork, new session, permission asks, reconnect), plus the chat text helpers
- `npm run e2e`: Playwright smoke test against a production build

- **`npm test`** runs plain Node (`--experimental-strip-types`) with no test framework, and exits 1 on any ✗. The engine checks cover:
  - the state machine and routing;
  - the full demo: phase order, `iteration === 2`, at least 7 agent-to-agent messages, under 100 sim s;
  - exact determinism (same seed ⇒ identical event sequence);
  - pause, resume, stop and reset, and per-agent pause/block;
  - concurrency and priority;
  - the backlog and the 8-task sprint.
- **The sound checks** cover:
  - which event plays which cue in the demo;
  - the quiet live mode, against events recorded from three real Claude Code sessions (`scripts/fixtures/live-sessions.json`);
  - throttling, and that history replayed on connect stays silent;
  - that `play()` is a no-op before a gesture;
  - per-mode settings persistence;
  - the tab-title attention signal.
- **`npm run e2e`** builds the app, serves it with `next start` on port 3150, and drives system Google Chrome (`channel: "chrome"`, so no browser download). It does the following:
  1. loads the page and checks that no AudioContext exists yet;
  2. sets 4× (the click unlocks audio and starts the hum) and runs the demo;
  3. pauses (progress holds, the hum stops) and resumes;
  4. waits for **Completed** to go from 0 to 1, and checks that cues were played;
  5. resets with the two-step confirm;
  6. fails on any console error. It ignores R3F's `THREE.Clock` deprecation *warning*, which comes from upstream.

  Screenshots are saved as `test-results/smoke-*.png`. Options:
  - `E2E_PORT=…` changes the port;
  - `E2E_SKIP_BUILD=1` reuses an existing `.next` build;
  - `PW_CHROMIUM=1` uses Playwright's bundled Chromium instead of Chrome (run `npx playwright install chromium` first).

## Architecture

```
                    commands (start, pause, submitTask…)          ┌─────────────────────────────────┐
  UI components ──► integrations/backendClient.commands ────────► │ AgentBackend (contract)         │
                                                                  │  • MockAgentBackend             │
                                                                  │      └ SimulationEngine (30 Hz) │
                                                                  │  • WebSocketAgentBackend        │
                                                                  │      └ any server, protocol v1  │
                                                                  └──────┬──────────────┬───────────┘
                                                            events       │              │ snapshots (30 Hz mock,
                                                       (AgentEvent)      │              │  ≤10 Hz over WebSocket)
                     ┌───────────────────────────────────────────────────┤              │
                     ▼                                                   ▼              ▼
          audio/useSoundEffects                       state/useWorldStore.pushEvents / applySnapshot
          SoundEngine.play(cue)                                │                     │
          tab title / notification (live)                      │ every snapshot      │ throttled mirror (≤ 1 per 160 ms,
                                                               ▼                     ▼  immediately on status/phase change)
                                                     liveWorld (mutable)      Zustand store
                                                               │                     │
                                                    read in useFrame,         HTML UI: TopBar, SidePanel,
                                                    never causes a render     ActivityFeed, TaskDialog,
                                                               ▼              Settings
                                                    3D world (R3F): office, desks,
                                                    robots, trails, arcs, labelAnchors ─► DOM speech bubbles
```

- **Rendering never mutates simulation state.** The 3D layer and the HTML UI only read. Every command goes through `commands` to the backend.
- **The engine** (`src/simulation`, `src/tasks`, `src/events`, non-React `src/agents/*.ts`) is pure TypeScript with explicit `.ts` imports, so Node runs it in tests. It has a seeded RNG, a pure workflow state machine, per-agent job queues, and action queues (move, work, talk, emote, wait, call). All timings live in `simulationConfig.ts`.
- **The store** keeps two speeds apart:
  - `liveWorld` is written on every snapshot and read by `useFrame`.
  - The Zustand mirror re-renders React only when a status, phase or agent/task signature changes, or at most every 160 ms for progress. Positions alone never re-render React.
- **The 3D world** (`src/world`, `src/agents/AgentCharacter.tsx`):
  - Shared geometry and material pools.
  - Instanced robots, furniture and skyline.
  - One shadow-casting light and no post-processing.
  - Canvas-generated textures; there are no binary assets anywhere.
  - Speech bubbles are DOM elements positioned from projected `labelAnchors`. drei `<Html>` is not used (pitfall 1).
- **Sound** (`src/audio`): every cue is synthesised with Web Audio (oscillators and filtered noise), going through a master gain, then a compressor, then the output.
  - `cueFor(event, mode)` is pure.
  - There is a per-type throttle: 120 ms, or 160 ms for footsteps; messages are throttled per speaker.
  - The ambient hum (low-passed noise plus a 58 Hz sine) plays while the world runs.
  - Settings are saved in `localStorage["aaw.sound.v1"]`, one entry per mode (`{simulation, live}`), and mirrored in the store.

### Folder map

| Folder | Contents |
|---|---|
| `src/simulation` | `SimulationEngine`, `WorkflowStateMachine`, `TaskScheduler`, `EventBus` + RNG, `simulationConfig`, `worldLayout` (positions, `route()` via the corridor), `workContent` (canned subtasks, findings, tests) |
| `src/agents` | the registry, `AgentController` (action queue, walking), `AgentAnimator` (procedural poses), `AgentCharacter.tsx` (instanced robot meshes) |
| `src/tasks` | task types, `DEMO_TASK`, the 18-task backlog and `SPRINT_TASKS` |
| `src/events` | the event vocabulary and pure selectors |
| `src/integrations` | `AgentBackend` (contract and protocol v1 types), the mock and WebSocket backends, `backendClient` (selection by env, the token, plus `commands`) and `sessionClient` (the sessions extension) |
| `src/state` | `useWorldStore`, `liveWorld` and `useSessionStore` (sessions, transcript, permission asks) |
| `src/world` | canvas, environment, workstations, agents layer, lighting, camera, interaction, textures, pools, label overlay |
| `src/audio` | `soundEngine.ts`, `attention.ts` ("Claude needs you"), `useSoundEffects.ts` |
| `src/components` | layout (AppShell, NavRail, TopBar, LoadingScreen), panels, sessions (SessionsPanel, PermissionStack), controls, activity feed, UI atoms |
| `scripts` | `simulate.ts`, `sound-test.ts`, fixtures |
| `e2e` | `smoke.spec.ts` |

## The workflow

```
queued ─picked_up─▶ intake ─delegated─▶ planning ─plan_ready─▶ research ─findings_published─▶ implementation
implementation ─submitted─▶ testing ─tests_passed─▶ review ─approved─▶ done
testing ─tests_failed─▶ implementation        review ─changes_requested─▶ implementation        any ─abort─▶ failed
```

- Each phase has an owner: intake is Orion, planning Piper, research Iris, implementation Kai, testing Quinn and review Rex. After `done`, Orion finalizes.
- Each agent works **one job at a time** from its own priority queue: priority, then age, then submission order. A running job is never preempted.
- Up to 2 tasks are in flight at once. Ambient wandering is dropped the moment real work is waiting.
- Rework sends the task back to Kai, with `iteration + 1`. A task that fails its third attempt ends `failed`.
- Random outcomes never fail the last attempt, so only scripted tasks can end `failed`.
- Pausing an agent blocks every task assigned to it, including tasks waiting in its queue.

## Demo and backlog

- **Run demo** (`DEMO_TASK`) is scripted: QA fails build #1 and review approves build #2. It is repeatable to the tick, and takes about 72.9 sim s at 1×.
- **Load sprint** (B) queues 8 tasks at once, including:
  - two criticals ("Patch session token leak in password-reset flow" and "Fix memory leak in the image-processing worker");
  - the scripted hot-fix, which ships on iteration 3;
  - the scripted migration, which fails after 3 iterations;
  - a low-priority export task that visibly waits.
- **New task** (N) offers suggestions and **Surprise me** (a random pick from the 18-task backlog). You can type any title; `workContent.ts` matches it against domain templates (auth, payments, search, realtime, migrations…) and falls back to a generic template.

## Sound

- **Simulation:** every step of the story has a cue.
  - Messages ping at the speaker's own pitch; you can tell Orion from Kai without looking.
  - A plan is an arpeggio, research a filtered sweep, and building a burst of keyboard clicks.
  - A failed test buzzes and a pass chimes. A shipped task gets a fanfare and a failed one a thud.
  - Pause, resume and reset have their own cues, and arrivals with a task make a footstep.
  - Ambient wandering is silent.
  - A low office hum plays while the world runs.
- **Live backends** (anything that reports `simulated: false`) are quiet on purpose. Only these make a sound:
  - a test failing (buzz) or passing (chime);
  - the turn ending (fanfare) or stopping (thud);
  - Orion's "Needs your permission…" / "Claude Code needs you…" warning, which rings a distinct two-tone bell.

  Handoffs between robots never ping, and the hum is off by default.
- Each mode keeps its own saved settings. Events older than 15 s, such as history the server replays when you connect, never make a sound.
- **Mute:** the speaker button in the top bar, `M`, or Settings → Sound (Sound effects, Ambient office hum, Volume).
- **"Claude needs you"** (live only):
  - The tab title changes to "⏳ Permission needed", "⏳ Needs you", "✓ Turn ended" or "✗ Stopped".
  - It clears when Claude starts working again; "Turn ended" also clears when you come back to the tab.
  - **Notify me** (the bell in the top bar, or Settings → Sound) also sends a desktop notification, but only while the tab is hidden.

## Connecting a real backend

The UI talks to any server that speaks **WebSocket protocol v1** (`src/integrations/AgentBackend.ts`).

**Handshake.** The client sends `hello` (with `protocolVersion: 1` and an optional `token`). The server answers `welcome` (with `label` and `simulated`), sends a full `snapshot`, then replays its recent events.

**Messages.**
- The client sends `command` messages with an id.
- The server sends `event`, `snapshot` (at most 10 Hz) and `ack` messages.
- Close code 4400 means a version mismatch and 4401 a bad token. Both are shown in Settings → Backend.

**Reconnects** use exponential backoff from 0.5 s up to 10 s, with jitter.

When the server says `simulated: false`, the UI changes:
- the subtitle reads "<label> · read-only mirror" ("<label> · mirror + control" when the server accepts prompts);
- speed is replaced by "Real time";
- Run demo, Load sprint, New task and agent pause are disabled, with tooltips that say why;
- Reset becomes "Clear".

Copy [`.env.example`](.env.example) to `.env.local`:

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_AGENT_BACKEND` | Unset or `mock` uses the local simulation. `websocket` uses a server |
| `NEXT_PUBLIC_AGENT_WS_URL` | e.g. `ws://127.0.0.1:8787` (the default when unset) |
| `NEXT_PUBLIC_AGENT_WS_TOKEN` | Optional. Sent in `hello`, never in the WebSocket URL. A `#token=…` (or `?token=…`) in the page URL takes precedence (see [Sessions](#sessions-read-and-reply-to-claude-code-from-the-browser)) |

These values are inlined at build time, so restart `npm run dev` or rebuild after changing them.

### Live mirror of your Claude Code sessions

This repository includes a world server and a Claude Code hooks bridge in `examples/phase1-engine`. With them, the six robots act out what Claude Code is really doing:
- Iris reads and searches;
- Kai edits;
- Quinn runs tests;
- Rex looks at diffs;
- Orion waits on you.

From the repository root:

```bash
cd examples/phase1-engine && npm install
npm run bridge -- install
npm run server -- --source claude-code
```

- `npm run bridge -- install`: once: adds async hooks to ~/.claude/settings.json (backed up first)
- `npm run server -- --source claude-code`: the live world server on ws://127.0.0.1:8787, hooks on POST /hook

Then, in this app:

```bash
NEXT_PUBLIC_AGENT_BACKEND=websocket NEXT_PUBLIC_AGENT_WS_URL=ws://127.0.0.1:8787 npm run dev
```

Start a **new** Claude Code session; hooks apply from the next session. Some more commands:
- `npm run bridge -- status` shows whether the hooks are installed.
- `npm run bridge -- uninstall` restores your settings exactly.
- `--scope project --project <dir>` limits the hooks to one project.

The hooks are `async` and silent, so Claude Code never waits for them, and they exit quietly when the server is not running.

**Several sessions at once.** One session drives the robots: the top bar says "Following: <title> · <project>". Auto (the default) follows the most active session, switching only after the followed one has been idle for 8 s or has ended; a session that starts waiting for you takes over at once. Pick a session in that menu, or **Follow in 3D** in the Sessions tab, to pin it. Other sessions still fill the feed and task list (with a project chip), play their sounds, and ring the bell with their project in the tab title. See [notes/multi-session.md](notes/multi-session.md).

**No Claude session at hand?** Replay a recorded one into the server (from `examples/phase1-engine`):

```bash
npm run replay -- bridge/real-session-permission.jsonl
npm run replay -- bridge/real-session-fail-fix-pass.jsonl
```

- `npm run replay -- bridge/real-session-permission.jsonl`: permission prompts, then the turn ends
- `npm run replay -- bridge/real-session-fail-fix-pass.jsonl`: a test fails, gets fixed, passes

**Server options:**
- `--control` turns on [Sessions](#sessions-read-and-reply-to-claude-code-from-the-browser): read transcripts, send prompts and answer permission asks from the app. It needs a token (`--token`, or one kept in `~/.aaw/token`).
- `--port <n>` serves on another port. Point `NEXT_PUBLIC_AGENT_WS_URL` at it, and set `AAW_HOOK_URL=http://127.0.0.1:<n>/hook` for the forwarder.
- `--token <secret>` requires `NEXT_PUBLIC_AGENT_WS_TOKEN` in the app and `AAW_TOKEN` for the forwarder.
- `--hide-prompts` hides prompt titles.
- `--trust-tailscale <login[,login]>` also listens on `127.0.0.1:<--tailscale-port>` (default `--port` + 1) for `tailscale serve` to forward to. There, a connection whose `Tailscale-User-Login` is one of these logins counts as holding the token. tailscale serve overwrites that header, so it is trusted on that port only. Other tunnels use the main port, where a forged header means nothing. `npm run up -- --trust-tailscale` detects your login.
- `--record file.jsonl` records payloads for replay. These files contain your prompts verbatim; do not commit them.
- `npm run server` (with no `--source`) serves the same simulation over WebSocket. The UI then still says "Simulation mode".

### Sessions: read and reply to Claude Code from the browser

With a live server started with `--control`, the app gains a **Sessions** tab (in the nav rail, or the bottom bar on phones; it never appears in simulation mode):

```bash
cd examples/phase1-engine && npm run server -- --source claude-code --control
```

The server prints an app link like `http://localhost:3000/#token=…` (to a terminal only, never to a log). The app reads the token from `#token=` (or `?token=` in older links), keeps it in `sessionStorage` (so reloads in that tab work), and removes it from the address bar with `history.replaceState`. Without one in the URL it falls back to `NEXT_PUBLIC_AGENT_WS_TOKEN`.

- **List:** every session the server has seen, newest first, with its status (running, waiting, idle, ended), its owner (Terminal or Web), the folder and the last activity.
- **Chat view:** your prompts, Claude's replies (fenced code in monospace) and each tool call as a collapsible row with its result (red when it failed). It follows new output while you are at the bottom. Images attached to a prompt (here or pasted in the terminal) show as thumbnails; click one for full size. The server sends only references with the conversation and each image's bytes when it is shown. An image in Claude's reply that points at another site shows as a button and loads only when you click it, because loading it tells that site you are reading.
- **Videos:** a link or image in Claude's reply that points at a video on the session's machine (`.mp4`, `.m4v`, `.webm`, `.mov`; a path relative to the session's folder, absolute, or `file://`) shows a **Play video** button. Pressing it asks the server over the WebSocket (`sessionFile`, so the token or your Tailscale login applies). The server only allows video files that really live inside that session's folder (links and junctions are resolved), and answers with a 30-minute ticket URL, `GET /session-file/<ticket>`, which the player streams with Range requests so seeking works on a phone. The token never goes in a URL.
- **Composer:** Enter sends, Shift+Enter adds a line. Attach images by pasting them (a screenshot with Ctrl+V / Cmd+V), dropping them on the composer, or the image button: up to 8 per prompt, PNG, JPEG, GIF or WebP. Anything larger than 2000 px or 5 MB, or of another type, is shrunk and sent as JPEG; a prompt may be images only. A session still open in a terminal is continued in a **fork**, so the terminal session is never touched; an ended or web-started one continues in place. **Stop** interrupts a turn started here.
- **New session:** a working directory (an absolute path on the server's machine) and the first prompt, with images if you like.
- **Permission asks** from sessions run here appear as cards over the world on every tab, with **Allow** and **Deny**. There is no keyboard shortcut and nothing is focused by default, so a stray Enter never approves a tool. An ask rings the attention bell and sets "⏳ Permission needed" in the tab title until it is answered.
- **Tasks → Open session** jumps from a task in the 3D world to its session.

Without `--control` the Sessions tab only says how to turn it on. Prompts sent from here run real Claude Code with your login, so they cost what a terminal prompt costs.

### Writing your own backend

Implement the protocol, or implement `AgentBackend` in TypeScript, and emit the event vocabulary in `src/events/eventTypes.ts`. Things to get right:
- An event with `targetAgentId` and type `agent.message` or `task.assigned` is drawn as a message arc.
- `CommLink`s in the snapshot drive the arcs' lifetime.
- Agent `status` drives poses and desk glow; `path` drives the walking trails.
- `simulated: false` switches the UI to read-only mirror mode and the quiet sound mode.

## Dev URL flags

These are for headless checks and profiling; normal use needs none of them. Each one only does what a click could do, or only exposes data.

| Flag | Effect |
|---|---|
| `?autodemo` / `?autodemo=4` | Run the demo once the scene is ready, optionally at a speed |
| `?autosprint` / `?autosprint=2` | Load the sprint once ready |
| `?tab=overview\|agents\|tasks\|activity\|sessions\|settings` | Open a side-panel tab (`sessions` needs a live backend) |
| `?select=T-001` / `?select=kai` | Select a task or an agent once it exists |
| `?dialog` | Open the New task dialog |
| `?stats` | Publish renderer counters on `window.__aawStats` and the store on `window.__aawStore` |
| `?perf` | Count React renders and time CPU per frame; logs averages every 5 s and publishes `window.__aawPerf` |
| `?noagents` | Hide the robots, to compare draw calls |
| `?quality=high\|low` | Force a rendering tier. This is a user-facing override, not just a dev flag |

`<html>` also carries `data-audio` (`none` / `suspended` / `running`), `data-sound-played` (the number of cues played) and `data-ambient`, so automated checks can confirm sound without hearing it.

## Pitfalls (learned the hard way)

1. **drei `<Html>` with React 19 StrictMode** throws on every double-mount. Speech bubbles use projected anchors and a DOM overlay instead.
2. **Never remount the Canvas** (for example `key={quality}`). `shadows` and `dpr` are reactive, and the quality tier is read from the store.
3. **three r186 removed `PCFSoftShadowMap`.** Use `PCFShadowMap` with `shadow.radius`.
4. **Node runs the engine in tests.** Keep engine folders free of React, three, Next and `@/` imports, and use explicit `.ts` extensions.
5. **Audio needs a gesture.** The AudioContext is created on the first pointerdown or keydown, and `play()` is silent before that. A context created in a click reports "suspended" for a moment; cues in that first second are still scheduled, so the click that ran the demo is heard.
6. **Tab sleep.** The mock backend clamps each real step to 0.1 s, so agents don't teleport after the tab was hidden.
7. **No 30 Hz React renders.** Snapshots go to `liveWorld`, and the mirror is throttled.
8. **Floating UI covers the world.** Camera presets fit the free area between the panels (view offset, distance, and a wider fov on phones).
9. **Click vs orbit.** There is a 5 px tolerance, so a drag never clears the selection.
10. **Node strips types; it does not compile them.** `erasableSyntaxOnly` and `verbatimModuleSyntax` make `enum`, `namespace`, parameter properties and untyped type imports into typecheck errors.
11. **Routing to where you already stand** must return an empty path, or Kai walks a pointless loop before the rework.
12. **Contention.** Use the per-agent job queue exactly. Ad-hoc "wait if busy" logic deadlocks.

There are also some quirks specific to this build:
- `next dev` writes an `AGENTS.md` into this folder. It is safe to delete.
- R3F 9.8 logs a `THREE.Clock` deprecation **warning** on every page. It comes from upstream and is harmless.
- drei's `PerformanceMonitor` `flipflops` + `onFallback` would drop fast machines to low quality, so the canvas counts consecutive declines instead.

## Opening it through a tunnel or from another device

`ws://127.0.0.1:8787` means the visitor's own device when the page is opened elsewhere, and an `https` page cannot
open `ws://` at all. Run the world server with `--proxy-app` (and `--app-port` set to this app's port): it serves the
app's pages too, so forwarding the single port 8787 carries both the page and its WebSocket from one origin. The app
notices it is not on the machine its configured URL points at and connects back to its own origin. Remote pages
always need the token (`#token=`, or paste it in the Sessions tab), and so does any connection that arrives through a proxy or tunnel. Keep tunnels private.

## Daily use: run the production build

`npm run dev` is for working on the app (dev indicator, unminified code, StrictMode double effects, hot reload).
For everyday use against the live server:

```bash
npm run build:live
npm run start:live
```

- `build:live` bakes `NEXT_PUBLIC_AGENT_BACKEND=websocket` and `ws://127.0.0.1:8787` into the bundle (`NEXT_PUBLIC_*` are read at build time, so changing them needs a rebuild).
- `start:live` serves it on port 3210; `PORT=4000 npm run start:live` for another port.
- Rebuild after pulling changes.

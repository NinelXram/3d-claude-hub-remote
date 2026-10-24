# Sessions notes: read, prompt and approve Claude Code from the web UI

The server side (`examples/phase1-engine/server/sessions/*`) and the protocol types were given; nothing outside
`app/` was changed.

## Files

- **New**
  - `src/state/useSessionStore.ts`: capabilities, the session list, the open session's items (`upsertById`), pending permission asks, and the task → session map.
  - `src/integrations/sessionClient.ts`: `wireSessions(backend)` (messages, connection and events into the store) and `sessionCommands` (open, close, send, start, respondPermission, interrupt).
  - `src/components/sessions/SessionsPanel.tsx` (list, chat, composer, New session), `PermissionStack.tsx`, `sessionUi.tsx` (status chip, owner tag, relative time), `sessionText.ts` (pure fence and inline-code splitting).
  - `scripts/sessions-test.ts` (`npm run test:sessions`, chained into `npm test`, 27 checks).
- **Changed**
  - `backendClient.ts`: `resolveToken()`, `getTokenSource()`, `wireSessions`, and `commandTimeoutMs: 95_000`.
  - `useWorldStore.ts` / `devFlags.ts`: `PanelTab` gains `sessions`.
  - `NavRail.tsx`: Sessions item (live only), with an amber count of pending asks.
  - `SidePanel.tsx`: the Sessions body owns its scrolling; the phone sheet is 55 dvh on that tab.
  - `AppShell.tsx`: mounts `PermissionStack` over the free area.
  - `TaskDetails.tsx`: an **Open session** button.
  - `audio/attention.ts`: `permissionEvent()`. `useSoundEffects.ts`: rings for and titles web permission asks.
  - `backendCaps.ts`: "mirror + control" subtitle. `Panels.tsx`: the token source line in Settings → Backend.
  - `README.md`, `.env.example`, `package.json` (`test:sessions`).

## Design choices

- **A separate store.** Transcript items can stream quickly. Nothing in the 3D layer, or in what it renders, subscribes to `useSessionStore`, so session traffic can never re-render a `useFrame` path. `useWorldStore` only gained a tab id.
- **The token.** `#token=` (or `?token=` from older links; see `tokenUrl.ts`) wins and is moved into `sessionStorage["aaw.token"]`; then `history.replaceState` removes it, keeping other params and the rest of the hash. Then comes a kept token, then `NEXT_PUBLIC_AGENT_WS_TOKEN`. It is resolved once, when the backend is created. `sessionStorage` is per tab, so a new tab needs the link again; that is deliberate for a credential.
- **Command timeout 95 s.** A `sendPrompt` that starts or forks a session acks only when Claude Code reports its session id, and the server waits up to 90 s for that. The default 10 s would reject a slow start that then succeeds. World commands ack at once, so the longer timeout changes nothing for them.
- **Opening a brand-new session.** Its transcript is often not on disk when the ack arrives, and `openSession` then fails with "not available yet". The client keeps `openId` set and retries every 1.5 s, for up to about a minute. Meanwhile items already stream in, because the server subscribes the connection that started the session. A fork's new id is opened the same way, in place of the original.
- **Reconnects.** On every `welcome` the client drops the asks it held, because the server re-sends those still pending right after. It also re-opens the session on screen, since the server forgets subscriptions when a socket closes.
- **Leaving.** Back calls `closeSession`, and so does leaving the tab. That close is deferred 100 ms, so React StrictMode's mount, unmount and remount does not close it.
- **Item order** is arrival order, and an upsert replaces in place. A tool row gains its result without moving.
- **Rendering.** Everything from the server is a React text node; there is no `dangerouslySetInnerHTML` anywhere. Prose keeps whitespace (`pre-wrap`). ```` ``` ```` fences become `<pre>` in monospace, `inline code` spans become `<code>`, and an unclosed fence (still streaming) runs to the end.
- **Status colours.** Running is cyan with a pulse, waiting is amber with a pulse, idle is green ("your turn") and ended is grey.
- **Permission cards.** They float over the world's free area on every tab and on phones, and cover the camera bar while present. At most 3 show, then "+N more". There is no shortcut and no autofocus; Deny comes before Allow. A card shows the tool, the session (a link to open it), Claude's title when there is one, the summary, an expandable input, and an inline error. It goes on `permissionResolved`, on a successful answer, or on "no longer pending".
- **Bell and title.** A new ask is dressed as Orion's "Needs your permission…" warning (`permissionEvent`), so the unchanged `cueFor` rings the attention bell and `attentionOf` sets "⏳ Permission needed" (and the optional desktop notification). The title clears when the last ask resolves. While asks are pending, other sessions' activity no longer clears that title.
- **Composer.** Enter sends; Shift+Enter adds a line, and an IME composition's Enter does not send. The textarea is disabled while sending, and the ack's error is shown inline.
  - The fork hint shows for a terminal session that has not ended.
  - **Stop** shows for a web session that is running or waiting.
  - The composer is hidden without `capabilities.control`.
- **New session** is prefilled with the cwd of the most recently active session. It checks for an absolute path on the client; the server checks again and its error is shown.

## Verification

- `npm run typecheck`, `npm run lint` and `npm test` pass: engine, 25 sound checks and 27 sessions checks.
- `npm run e2e` passes (1.2 min) and includes `npm run build`, so simulation mode is unaffected and the Sessions tab is hidden there.
- **Real run.** The server ran with `--source claude-code --control --token aawtest123 --port 8797`, and `next dev -p 3160` with the websocket env. CDP was in real time, with JS marks clicking the real buttons. Screenshots are in `/tmp/aaw-sess/shots/`.
  1. `/?token=aawtest123&tab=sessions` loaded. The address bar became `/?tab=sessions`, and `sessionStorage` held the token.
  2. New session in `/tmp/aaw-live-target`, with "Run npm test and tell me in one sentence whether it passes. Do not change files."
  3. The Bash card appeared, the title became "⏳ Permission needed · AI Agent World", and `document.activeElement` was `BODY` (`d1-15s.png`, desktop).
  4. Allow was clicked. The card went, the title cleared, and the output arrived: "No, `npm test` fails: 1 of 2 tests passes…" (`d1-22s.png`, with the tool row expanded).
  5. The follow-up "Which test fails?…" was sent with a synthetic Enter, in the same session with no fork. The answer arrived (`d1-25.6s.png`: Running, Stop).
  6. Back led to the list (`d1-29s.png`).
- **Terminal sessions.** `bridge/real-session-fail-fix-pass.jsonl` was replayed into 8797, and one hand-made `UserPromptSubmit` hook marked another real transcript as running in a terminal.
  - Tasks → T-001 showed **Open session** (`d2-10s.png`).
  - Clicking it opened the ended terminal transcript (`d2-13s.png`).
  - The running terminal session showed the fork hint and a red failed tool row (`d2-17s.png`).
- **Mobile, 520×900, touch.** The permission card stays over the world on the Sessions tab (`m2-13s.png`) and on Overview (`m2-15s.png`). After Deny, Claude replied "The command was denied…" and the tool row turned red (`m2-20s.png`).
- **Read-only.** The server was restarted without `--control`, and the Sessions tab showed one line (`ro2-9s.png`, cropped as `ro2-crop.png`).
- The only console output was the known upstream `THREE.Clock` warning.
- **Real Claude prompts: 5, all short.**
  - The test run (1 approved Bash).
  - The follow-up.
  - `node --version`, which Claude Code allows without asking, so no card appeared.
  - "Run npm test once more" (denied).
- Everything started was stopped: ports 3160 and 8797 are free and `app/AGENTS.md` was deleted. Port 8787 was never touched.

## Known gaps

- **Hooks still go to 8787.** Sessions started from the web UI run the real `claude` with your hooks, and those hooks post to whatever `AAW_HOOK_URL` says (8787 by default). On a test server on another port the robots therefore do not act out web sessions. Under the normal setup (one server on 8787) they do.
- **Markdown** beyond fences and inline code (bold, lists, links) is shown as plain text. This is on purpose: there is no HTML rendering, and no parser was added.
- **No pagination or virtualisation.** The server caps text sizes, but a very long transcript renders every item.
- **Permission asks exist only for sessions run from this page.** Terminal sessions still ask in their terminal. That is the server's design; the world still shows Orion's warning for them.
- **Token scope.** A URL token lives in `sessionStorage`, so opening the app in a new tab without the link falls back to the env token or none. A wrong token shows the 4401 error in Settings → Backend, and the Sessions tab then says "Not connected".
- **Relative times** tick every 10 s in the list only.

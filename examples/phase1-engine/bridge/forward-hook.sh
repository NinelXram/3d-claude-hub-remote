#!/bin/sh
# Claude Code command hook: forward the hook's JSON (stdin) to the 3D Claude Hub Remote server.
# Prints nothing and always exits 0, so it can never block, alter or inject anything into the session.
# Configure with "async": true so Claude never waits for it (see bridge/README.md).
# The server wants a token when --control is on: AAW_TOKEN, else the one it keeps in ~/.aaw/token.
URL="${AAW_HOOK_URL:-http://127.0.0.1:8787/hook}"
TOKEN="${AAW_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -r "$HOME/.aaw/token" ]; then
  TOKEN=$(head -n 1 "$HOME/.aaw/token" 2>/dev/null | tr -d '\r\n')
fi
if [ -n "$TOKEN" ]; then
  curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" --data-binary @- "$URL" >/dev/null 2>&1
else
  curl -s --max-time 2 -X POST -H 'Content-Type: application/json' --data-binary @- "$URL" >/dev/null 2>&1
fi
exit 0

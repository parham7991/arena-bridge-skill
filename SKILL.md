---
name: arena-bridge
description: >
  Logs into arena.ai with email/password and runs real Arena Agent sessions via a
  local OpenAI-compatible bridge. Enables multi-agent team-leader workflows
  (spawn several Agent chats in parallel, collect their outputs, merge results).
---

# arena-bridge — Arena Agent Bridge Skill

## What this is

A self-contained bridge that lets **any Arena agent** do two things:

1. **Log into arena.ai with an email + password** (real session, real cookies,
   stored encrypted — AES-256-GCM, file permission `0600`).
2. **Run real Arena Agent Mode chats programmatically** through a local
   OpenAI-compatible HTTP API — including **multiple agents in parallel**
   (each with its own persistent session via `x-codex-session-id`).

It is 100% standalone: **no server, no external gateway, no third-party
infrastructure required.** It runs on the machine where the agent lives.

## What it is NOT

- It contains **no project-specific secrets, tokens, server credentials or
  business data**. Login credentials are provided by you at install time
  (or via environment variables) and are stored encrypted locally.
- It does **not** upload anything anywhere; it only talks to `arena.ai`.

---

## Quick start (one command)

```bash
# Clone this skill and run the installer
git clone https://github.com/parham7991/arena-bridge-skill.git
cd arena-bridge-skill
bash install.sh --email you@example.com --password 'your-password'
```

The installer will:
1. Check Node.js (>= 18).
2. `npm install playwright` and `npx playwright install chromium`
   (+ system deps when sudo is available).
3. Create `~/.arena-bridge/` with an auto-generated encryption key and a
   bridge API key.
4. Perform the real `arena.ai` email/password login and store the session
   encrypted.
5. Start the bridge server and wait for `/health` to report `ok:true`.

Result:

```
http://127.0.0.1:20140/health                → {"ok":true,...}
http://127.0.0.1:20140/v1/chat/completions   → OpenAI-compatible
```

## Manual install (what the agent should run, step by step)

```bash
cd <skill-dir>

# 1) deps
node --version                # need >= 18
npm install playwright --no-audit --no-fund
npx playwright install chromium
# optional: sudo npx playwright install-deps chromium

# 2) login (email/password) — stored encrypted under ~/.arena-bridge/
node bin/login.mjs --email you@example.com --password 'your-password'
# or: ARENA_PASSWORD=... node bin/login.mjs --email you@example.com

# 3) start the bridge
node src/index.mjs &          # or: bash run.sh
sleep 4
curl -s http://127.0.0.1:20140/health
```

## Using the bridge

### Single chat (plain)

```bash
curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer <ARENA_AGENT_BRIDGE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent","stream":false,
       "messages":[{"role":"user","content":"Salam! Be 2 kalame bego ke kar mikoni."}]}'
```

### Team leader: several agents in parallel

Each agent = its own **session** (a real Arena Agent chat) identified by the
`x-codex-session-id` header. Sessions persist across calls (they are stored in
`~/.arena-bridge/sessions.json`, TTL 12h by default), so each agent keeps its
own memory.

```bash
# Agent 1 (analyst)
curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -H "x-codex-session-id: agent-analyst-01" \
  -d '{"model":"agent","stream":false,"messages":[{"role":"user","content":"Mission card: ..."}]}'

# Agent 2 (coder) — same time, different session
curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -H "x-codex-session-id: agent-coder-01" \
  -d '{"model":"agent","stream":false,"messages":[{"role":"user","content":"Mission card: ..."}]}'
```

### Tools

OpenAI-style `tools` are supported (`Bash`, `Read`, `Write`, `Edit`, `Glob`,
`Grep`, `WebSearch`, `WebFetch`, `AskUserQuestion`). The model is instructed to
emit literal `<tool>{"name":"...","arguments":{...}}</tool>` blocks, which the
bridge converts into `tool_calls` in the OpenAI response. Then you execute them
and send the result back as a `tool` message on the same session.

### Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` `/ready` | health/status |
| GET | `/metrics` | Prometheus counters |
| GET | `/v1/models` `/models` | model list (`agent`) |
| POST | `/recaptcha` | fresh reCAPTCHA v3 token |
| POST | `/v1/chat/completions` `/chat/completions` | chat (stream + non-stream) |

### Helper scripts

```bash
node bin/login.mjs --email e --password p      # login (once)
node bin/new-agent.mjs prompt.txt              # create a brand-new agent chat with a seed prompt
node bin/attach-session.mjs <session-id> file  # append a prompt to an existing chat
node bin/verify-session.mjs <session-id>       # check account + session state
node bin/verify-session.mjs <id> --probe "msg" # send a message and read the reply
```

---

## Configuration (environment / `~/.arena-bridge/.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATA_DIR` | `~/.arena-bridge` | where credentials/sessions live |
| `HOST` | `127.0.0.1` | bind host |
| `PORT` | `20140` | bind port |
| `ARENA_AGENT_BRIDGE_KEY` | generated by install.sh | Bearer key required on chat calls |
| `ARENA_AGENT_CHROME` | auto | chromium executable path |
| `ARENA_AGENT_PROXY` | empty | optional proxy (`socks5://...`) — leave empty for direct |
| `ARENA_SESSION_TTL_MS` | 43200000 (12h) | session persistence TTL |
| `ARENA_RATE_LIMIT_RPM` | 100 | per-client rate limit |
| `ARENA_MAX_TOOL_CALLS` | 8 | max parallel tool calls per turn |
| `ARENA_RECAPTCHA_SITE_KEY` | arena site key | reCAPTCHA v3 site key |
| `STORAGE_ENCRYPTION_KEY` | auto-generated | AES-256-GCM key for credentials |

## Troubleshooting

- **`locator.waitFor: Timeout` on the composer** → the target chat may show the
  "Was this task successful?" modal. The bridge auto-clicks **Keep working /
  ادامه کار**. If it still fails, open the chat once in a normal browser.
- **Cookie expiry** → sessions last about an hour. The bridge auto-refreshes
  while running (it re-logs-in using the stored encrypted password). If the
  process was restarted after a long downtime, run `bin/login.mjs` again.
- **Login `429` / "just a moment"** → rate-limited/Cloudflare; the bridge retries
  with backoff. Avoid hammering; keep `RPM` low (10 is fine for logins).
- **reCAPTCHA token empty** → tokens are cached ~110s and refreshed lazily; if
  it fails, call `POST /recaptcha` to force a fresh one.
- **Port in use** → set a different `PORT`.
- **Playwright missing chromium** → `npx playwright install chromium` (+ deps).

## Security notes

- Password + cookies are encrypted with AES-256-GCM (`credentials.json`, mode
  `0600`). Password is never printed.
- The bridge key (`ARENA_AGENT_BRIDGE_KEY`) should be a long random hex
  (`openssl rand -hex 24`).
- Bind to `127.0.0.1` unless you deliberately proxy it; never expose port 20140
  publicly without auth.
- The bridge never echoes secrets into any output or file.

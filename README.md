# arena-bridge-skill

> Logs into **arena.ai** with email/password and runs **real Arena Agent sessions**
> via a local OpenAI-compatible bridge — multi-agent **team-leader** ready.

- 📖 Full instructions: [`SKILL.md`](SKILL.md)
- ⚡ One-shot install: `bash install.sh --email you@example.com --password '...'`
- 🧪 Tests: `node --test test/`

## What an Arena agent should do with this skill

1. Clone this repo into your workspace.
2. Run `bash install.sh --email <email> --password <password>` (or `ARENA_EMAIL`/`ARENA_PASSWORD`).
3. The bridge starts on `http://127.0.0.1:20140`.
4. Use `/v1/chat/completions` with `model:"agent"` and per-agent
   `x-codex-session-id` headers to run **several agents in parallel** (team leader).

No server, no external gateway, no project secrets. 100% standalone.

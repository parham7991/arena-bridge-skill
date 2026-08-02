# 🚀 Copy-Paste Arena Prompts

Two ways to install everything — pick whichever you like:

## Option A — fastest (recommended): copy-paste prompt

1. Open the raw prompt file:
   - **Connect only:** https://raw.githubusercontent.com/parham7991/arena-account-bridge/main/prompts/arena-install-prompt.md
   - **Team Leader (bridge + team):** https://raw.githubusercontent.com/parham7991/arena-team-agent/main/prompts/arena-team-prompt.md
2. **Copy the whole text.**
3. Paste it into any **Arena chat (Agent Mode)** and send.
4. The agent will: install the skill(s), ask you for your email/password once,
   log into your **own** arena.ai account, start the bridge on
   `127.0.0.1:20140` (with WARP to avoid Cloudflare), pass the self-test, and
   report **READY** — fully automatic.

## Option B — classic: clone & run

```bash
# connect
git clone https://github.com/parham7991/arena-account-bridge.git && cd arena-account-bridge
bash install.sh --warp --email you@example.com --password '...'

# team (installs bridge as prerequisite too)
git clone https://github.com/parham7991/arena-team-agent.git && cd arena-team-agent
bash install.sh --email you@example.com --password '...'
```

## Option C — one-liner (no git)

```bash
curl -fsSL https://raw.githubusercontent.com/parham7991/arena-account-bridge/main/bootstrap.sh | \
  ARENA_EMAIL=you@example.com ARENA_PASSWORD='...' bash
```

---

## چه چیزی بعد از READY داری؟

| بعد از نصب | داری |
|---|---|
| arena-account-bridge | پل OpenAI-compatible روی `127.0.0.1:20140` + لاگین اکانت خودت + WARP + سلف‌تست |
| arena-team-agent | خودِ چت = تیم‌لیدر + ۱۳ نقش پیش‌فرض + MEMBER_SKILL + اسپاون عضو + کارنامه + گیت کیفیت |

## نکات امنیتی

- ایمیل/پسورد فقط یک بار از تو گرفته می‌شود و **رمز شده** ذخیره می‌شود
  (`~/.arena-bridge/credentials.json`, 0600).
- فقط حسابِ خودِ تو خودکار می‌شود؛ محدود و rate-limited.
- اگر ایجنتِ چت به دلایل سیاستی نصب نکرد، از او بخواه حداقل یک ممیزی امنیتی
  بدهد و دستورهای نصب دستی را بگوید.

#!/usr/bin/env bash
# bootstrap.sh — ONE-LINE installer for the arena-bridge skill (no git needed).
#   curl -fsSL https://raw.githubusercontent.com/parham7991/arena-bridge-skill/main/bootstrap.sh | bash
#   (pass --email/--password/--no-login after the pipe via env: ARENA_EMAIL / ARENA_PASSWORD)
set -euo pipefail

REPO="parham7991/arena-bridge-skill"
BRANCH="${BRANCH:-main}"
TMP="$(mktemp -d)"

echo "==> Downloading $REPO ($BRANCH)..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/skill.tgz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/skill.tgz" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
else
  echo "ERROR: need curl or wget" >&2; exit 1
fi

mkdir -p "$TMP/x"
tar xzf "$TMP/skill.tgz" -C "$TMP/x"
SKILL_DIR="$(find "$TMP/x" -maxdepth 1 -type d -name 'arena-bridge-skill-*' | head -1)"
if [[ -z "$SKILL_DIR" ]]; then echo "ERROR: extract failed" >&2; exit 1; fi

echo "==> Running install.sh"
cd "$SKILL_DIR"
bash install.sh "$@"

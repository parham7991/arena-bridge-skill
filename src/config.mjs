// config.mjs — environment parsing + fail-fast validation (standalone, neutral).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadDotEnv(envPath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

export function loadConfig(env = {}, { requireBridgeKey = true } = {}) {
  const dataDir = env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  const port = Number(env.PORT || 20140);
  const host = env.HOST || "127.0.0.1";
  const bridgeKey = env.ARENA_AGENT_BRIDGE_KEY || "";
  if (requireBridgeKey && !bridgeKey) {
    throw new Error(
      "ARENA_AGENT_BRIDGE_KEY is required. Run install.sh (it auto-generates one) or set it in the environment / DATA_DIR/.env."
    );
  }
  const proxyRaw = env.ARENA_AGENT_PROXY;
  const proxy =
    proxyRaw === undefined || proxyRaw === "" || proxyRaw === "none" ? "" : proxyRaw;
  const config = {
    dataDir,
    envPath: path.join(dataDir, ".env"),
    sessionFile: path.join(dataDir, "sessions.json"),
    credentialsFile: path.join(dataDir, "credentials.json"),
    profileFile: path.join(dataDir, "profile.json"),
    // optional one-time migration from an omni-route style sqlite vault (opt-in)
    omniDbPath: env.ARENA_OMNI_DB || "",
    omniRoot: env.OMNI_ROOT || "",
    host,
    port,
    bridgeKey,
    chromePath: env.ARENA_AGENT_CHROME || "",
    proxy,
    recaptchaSiteKey:
      env.ARENA_RECAPTCHA_SITE_KEY || "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0",
    sessionTtlMs: Number(env.ARENA_SESSION_TTL_MS || 12 * 60 * 60 * 1000),
    refreshMarginSec: Number(env.ARENA_REFRESH_MARGIN_SEC || 1200),
    recaptchaTtlMs: Number(env.ARENA_RECAPTCHA_TTL_MS || 110_000),
    rateLimitRpm: Number(env.ARENA_RATE_LIMIT_RPM || 100),
    maxToolCalls: Number(env.ARENA_MAX_TOOL_CALLS || 8),
    maxQueue: Number(env.ARENA_MAX_QUEUE || 8),
    migrateFromOmni: String(env.ARENA_MIGRATE_FROM_OMNI ?? "0") === "1",
    profile: loadProfile(path.join(dataDir, "profile.json")),
  };
  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}`);
  }
  return config;
}

function loadProfile(profileFile) {
  const defaults = {
    enabled: true,
    ownerName: "",
    language: "fa",
    autonomy: "high",
    codingStyle: "production-grade, clean, modular, secure",
    defaultStack: "Follow the repository; ask only if the stack is genuinely ambiguous",
    responseStyle: "concise progress, precise final summary",
    customInstructions: "",
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    return { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return defaults;
  }
}

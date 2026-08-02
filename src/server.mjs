// server.mjs — OpenAI-compatible HTTP surface (drop-in for the omni bridge):
//   GET  /health /ready /metrics /v1/models /models
//   POST /v1/chat/completions /chat/completions  (stream + non-stream)
//   POST /recaptcha
// Includes Bearer auth, rate limiting, request-size limits and precise errors.
import http from "node:http";
import crypto from "node:crypto";
import { log } from "./util.mjs";

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(Object.assign(error, { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** Validate the OpenAI request shape; return error string or null. */
export function validateCompletion(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "messages must be a non-empty array";
  for (const m of body.messages) {
    if (!m || typeof m !== "object") return "each message must be an object";
    if (!["system", "developer", "user", "assistant", "tool"].includes(m.role))
      return `unsupported role: ${m.role}`;
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "tools must be an array";
  if (body.max_tokens !== undefined && typeof body.max_tokens !== "number") return "max_tokens must be a number";
  if (body.temperature !== undefined && typeof body.temperature !== "number") return "temperature must be a number";
  return null;
}

export class RateLimiter {
  constructor(rpm) {
    this.rpm = Math.max(1, rpm);
    this.windows = new Map();
  }
  allow(key, now = Date.now()) {
    const winMs = 60_000;
    const entry = this.windows.get(key) || { count: 0, start: now };
    if (now - entry.start > winMs) {
      entry.count = 0;
      entry.start = now;
    }
    entry.count += 1;
    this.windows.set(key, entry);
    return { allowed: entry.count <= this.rpm, retryAfter: Math.ceil((winMs - (now - entry.start)) / 1000) || 1 };
  }
}

export function createServer({ bridge, config }) {
  const limiter = new RateLimiter(config.rateLimitRpm);
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const clientKey = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?") + "|" +
      String(req.headers.authorization || "").slice(0, 24);

    if (url.pathname === "/health" || url.pathname === "/ready") return json(res, 200, bridge.healthPayload());
    if (url.pathname === "/metrics") {
      const body = bridge.prometheusMetrics();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4",
        "Content-Length": Buffer.byteLength(body),
      });
      return res.end(body);
    }
    if (req.method === "POST" && url.pathname === "/recaptcha") {
      const credential = bridge.credentials.primary();
      try {
        const token = await bridge.recaptcha.get(credential?.cookieHeader, true);
        return json(res, 200, { token, action: "chat_submit" });
      } catch (error) {
        return json(
          res,
          503,
          { error: { message: "Fresh Arena reCAPTCHA token unavailable", type: "recaptcha_broker_error" } },
          { "Retry-After": "5" }
        );
      }
    }
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return json(res, 200, { object: "list", data: [{ id: "agent", object: "model", created: 0, owned_by: "arena-agent" }] });
    }
    if (req.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
      return json(res, 404, { error: { message: "Not found" } });
    }

    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!config.bridgeKey || auth !== config.bridgeKey) {
      return json(res, 401, { error: { message: "Invalid bridge key" } });
    }
    const rate = limiter.allow(clientKey);
    if (!rate.allowed) {
      return json(res, 429, { error: { message: "Rate limit exceeded", type: "rate_limited" } }, { "Retry-After": String(rate.retryAfter) });
    }

    const requestId = crypto.randomUUID();
    const startedAtReq = Date.now();
    bridge.runtime.requests += 1;
    const responseHeaders = {
      "X-Arena-Bridge-Version": "5.0.0",
      "X-Arena-Bridge-Request-Id": requestId,
    };
    try {
      const body = await readBody(req);
      const validationError = validateCompletion(body);
      if (validationError) {
        bridge.runtime.errors += 1;
        return json(res, 400, { error: { message: validationError, type: "invalid_request_error", request_id: requestId } }, responseHeaders);
      }
      log.info("server", "chat completion request", { requestId, messages: body.messages.length, stream: body.stream === true });
      const payload = await bridge.runAgent(body, req.headers);
      const elapsed = Date.now() - startedAtReq;
      bridge.runtime.completed += 1;
      bridge.runtime.lastLatencyMs = elapsed;
      bridge.runtime.totalLatencyMs += elapsed;
      bridge.runtime.lastSuccessAt = new Date().toISOString();
      const hasToolCalls = Array.isArray(payload?.choices?.[0]?.message?.tool_calls);
      if (hasToolCalls) bridge.runtime.toolResponses += 1;
      else bridge.runtime.textResponses += 1;
      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive",
          ...responseHeaders,
        });
        const reader = bridge.completionStream(payload).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        return res.end();
      }
      return json(res, 200, payload, responseHeaders);
    } catch (error) {
      bridge.runtime.errors += 1;
      bridge.runtime.lastLatencyMs = Date.now() - startedAtReq;
      bridge.runtime.lastErrorAt = new Date().toISOString();
      bridge.runtime.lastErrorType = String(error?.code || error?.name || error?.status || "unknown").slice(0, 80);
      const status = Number(error.status || 502);
      const retrySeconds = Number(error.retryAfter || (status === 429 ? 60 : status === 503 ? 10 : 0));
      const retryAfter = retrySeconds > 0 ? { "Retry-After": String(retrySeconds) } : {};
      log.error("server", "completion failed", {
        requestId,
        status,
        errorType: error?.name || "Error",
        message: error?.message,
      });
      return json(
        res,
        status,
        { error: { message: error instanceof Error ? error.message : String(error), type: "arena_agent_error", request_id: requestId } },
        { ...retryAfter, ...responseHeaders }
      );
    }
  });

  server.requestTimeout = 240_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 128;
  server.startTime = startedAt;

  return server;
}

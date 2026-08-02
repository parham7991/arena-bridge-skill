// bridge.mjs — orchestration core. Runs real Arena Agent sessions via the
// logged-in browser, with a serialized queue, staleness detection, native-tool
// interception, duplicate guards and recovery. API-compatible with v4.1.
import fs from "node:fs";
import { ArenaBrowser } from "./arena-login.mjs";
import { SessionStore } from "./sessions.mjs";
import { formatMessages, sessionKey, latestTurn } from "./format.mjs";
import {
  parseAgentOutput,
  parsePublicToken,
  parseToolCalls,
  parseNativeToolCalls,
  repeatedToolGuard,
} from "./parser.mjs";
import { log, retry } from "./util.mjs";

const encoder = new TextEncoder();

export class Bridge {
  constructor({ config, credentials, recaptcha, startedAt = Date.now() }) {
    this.config = config;
    this.credentials = credentials;
    this.recaptcha = recaptcha;
    this.startedAt = startedAt;
    this.browser = new ArenaBrowser({
      omniRoot: config.omniRoot,
      chromePath: config.chromePath,
      proxy: config.proxy,
    });
    this.sessions = new SessionStore({ filePath: config.sessionFile, ttlMs: config.sessionTtlMs });
    this.runtime = {
      queueDepth: 0,
      activeRequests: 0,
      requests: 0,
      completed: 0,
      errors: 0,
      textResponses: 0,
      toolResponses: 0,
      nativeIntercepts: 0,
      duplicateBlocks: 0,
      recoveryAttempts: 0,
      recoverySuccesses: 0,
      staleReplays: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorType: null,
    };
    this.operationQueue = Promise.resolve();
    this.lastDumps = {};
  }

  async start() {
    // Warm up the browser and validate the credential early (fail fast).
    const credential = this.credentials.primary();
    if (!credential) throw new Error("arena-bridge: no credentials — run bin/login.mjs first");
    await this.browser.getPage(credential.cookieHeader, credential.updatedAt);
    log.info("bridge", "browser ready", {
      account: credential.email,
      cookieExpiry: this.credentials.expirySummary(credential),
    });
  }

  #serialized(fn) {
    if (this.runtime.queueDepth >= this.config.maxQueue) {
      return Promise.reject(
        Object.assign(new Error("Arena bridge queue is full; retry shortly"), {
          status: 503,
          retryAfter: 10,
          code: "bridge_queue_full",
        })
      );
    }
    this.runtime.queueDepth += 1;
    const execute = async () => {
      this.runtime.activeRequests += 1;
      try {
        return await fn();
      } finally {
        this.runtime.activeRequests -= 1;
      }
    };
    const run = this.operationQueue.then(execute, execute);
    this.operationQueue = run.catch(() => undefined);
    return run.finally(() => {
      this.runtime.queueDepth = Math.max(0, this.runtime.queueDepth - 1);
    });
  }

  #credential() {
    return this.credentials.primary();
  }

  async #page() {
    const credential = this.#credential();
    return this.browser.getPage(credential.cookieHeader, credential.updatedAt);
  }

  async createAgentSession(page, prompt) {
    await page.goto("https://arena.ai/agent", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const acceptCookies = page.getByRole("button", { name: "Accept Cookies" });
    if (await acceptCookies.count()) await acceptCookies.click().catch(() => undefined);
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.waitFor({ state: "visible", timeout: 60_000 });
    await editor.fill(prompt);
    const createResponse = page.waitForResponse(
      (response) => response.url().includes("/nextjs-api/stream/create-chat"),
      { timeout: 60_000 }
    );
    await page.locator('button[aria-label="Send message"]').click({ force: true });
    const response = await createResponse;
    const createText = await response.text().catch(() => "");
    if (response.status() !== 200) {
      throw Object.assign(
        new Error(`Arena Agent composer failed: ${response.status()} ${createText.slice(0, 300)}`),
        { status: response.status() }
      );
    }
    const id = JSON.parse(createText).id;
    if (!id) throw new Error("Arena Agent composer returned no session id");
    let token = "";
    for (let attempt = 0; attempt < 8 && !token; attempt++) {
      const html = await page.evaluate(async (id) => (await fetch(`/agent/${id}`)).text(), id);
      token = parsePublicToken(html);
      if (!token) await new Promise((r) => setTimeout(r, 350));
    }
    if (!token) throw new Error("Arena Agent public token not found");
    return { id, token, lastNodeId: null, requiresReview: false, toolsInitialized: false, updatedAt: Date.now() };
  }

  async appendAgentMessage(page, state, prompt) {
    await page.goto(`https://arena.ai/agent/${state.id}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_500);
    const acceptCookies = page.getByRole("button", { name: "Accept Cookies" });
    if (await acceptCookies.count()) await acceptCookies.click().catch(() => undefined);
    // Dismiss the "was this task successful?" / continue modal before editing.
    // Arena's UI labels these in the account language (e.g. "ادامه کار").
    const keepSelectors = [
      'button:has-text("Keep working")',
      'button:has-text("ادامه کار")',
      'button:has-text("ادامه")',
      'button[role="button"]:has-text("Keep working")',
      'button[role="button"]:has-text("ادامه کار")',
      '[role="dialog"] button:has-text("ادامه")',
    ];
    for (const selector of keepSelectors) {
      const keepWorking = page.locator(selector).first();
      if (await keepWorking.count()) {
        await keepWorking.click({ force: true, timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
        break;
      }
    }
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.waitFor({ state: "visible", timeout: 60_000 });
    await editor.fill(prompt);
    const appendResponse = page.waitForResponse(
      (response) => response.url().includes(`/sessions/${state.id}/in/append`),
      { timeout: 60_000 }
    );
    let observedToken = "";
    const tokenListener = (request) => {
      if (request.url().includes(`/sessions/${state.id}/out`)) {
        const auth = request.headers().authorization || "";
        if (/^Bearer /i.test(auth)) observedToken = auth.replace(/^Bearer /i, "");
      }
    };
    page.on("request", tokenListener);
    const freshOutputRequest = page
      .waitForRequest((request) => request.url().includes(`/sessions/${state.id}/out`), { timeout: 12_000 })
      .catch(() => null);
    await page.locator('button[aria-label="Send message"]').click({ force: true });
    const response = await appendResponse;
    const outputRequest = await freshOutputRequest;
    if (outputRequest) {
      const auth = outputRequest.headers().authorization || "";
      if (/^Bearer /i.test(auth)) observedToken = auth.replace(/^Bearer /i, "");
    }
    page.off("request", tokenListener);
    const text = await response.text().catch(() => "");
    if (response.status() !== 200) {
      throw Object.assign(
        new Error(`Arena Agent append failed: ${response.status()} ${text.slice(0, 300)}`),
        { status: response.status() }
      );
    }
    const headerToken = response.headers()["public-access-token"] || "";
    if (headerToken) observedToken = headerToken;
    if (observedToken) state.token = observedToken;
  }

  async refreshAgentToken(page, id) {
    const html = await page.evaluate(async (sessionId) => (await fetch(`/agent/${sessionId}`)).text(), id);
    return parsePublicToken(html);
  }

  async readAgentOutput(page, state) {
    const result = await page.evaluate(
      async ({ id, token, lastEventId }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        let reader;
        try {
          const headers = { Accept: "text/event-stream", Authorization: `Bearer ${token}` };
          if (lastEventId) headers["Last-Event-ID"] = lastEventId;
          const response = await fetch(`/ai-proxy/realtime/v1/sessions/${id}/out`, {
            headers,
            signal: controller.signal,
          });
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let raw = "";
          while (raw.length < 4_000_000) {
            const { done, value } = await reader.read();
            if (done) break;
            raw += decoder.decode(value, { stream: true });
            const lfEnd = raw.lastIndexOf("\n\n");
            const crlfEnd = raw.lastIndexOf("\r\n\r\n");
            const completeEnd = Math.max(lfEnd < 0 ? -1 : lfEnd + 2, crlfEnd < 0 ? -1 : crlfEnd + 4);
            const complete = completeEnd > 0 ? raw.slice(0, completeEnd) : "";
            const hasCompleteTool = /tool-input-(?:available|error)/.test(complete);
            const hasFinish = complete.includes('\\"type\\":\\"finish\\"');
            const hasTurnComplete = complete.includes("turn-complete");
            if (hasCompleteTool || (hasFinish && hasTurnComplete)) break;
          }
          await reader.cancel().catch(() => undefined);
          return { status: response.status, raw };
        } finally {
          clearTimeout(timer);
          await reader?.cancel().catch(() => undefined);
        }
      },
      { id: state.id, token: state.token, lastEventId: state.lastEventId || "" }
    );
    if (result.status !== 200)
      throw Object.assign(new Error(`Arena Agent output failed: ${result.status}`), { status: result.status });
    return result.raw;
  }

  async stopArenaRun(page) {
    for (const selector of [
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
      'button:has-text("Stop generating")',
    ]) {
      const button = page.locator(selector).last();
      if (await button.count()) {
        await button.click({ force: true, timeout: 2_000 }).catch(() => undefined);
        break;
      }
    }
    await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => undefined);
  }

  makeCompletion(model, content, toolCalls, reasoning) {
    const message = { role: "assistant", content: toolCalls ? content || null : content };
    if (toolCalls) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning_content = reasoning;
    return {
      id: `chatcmpl-arena-agent-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  completionStream(payload) {
    const choice = payload.choices[0];
    const message = choice.message;
    const emit = (delta, finish) =>
      `data: ${JSON.stringify({
        id: payload.id,
        object: "chat.completion.chunk",
        created: payload.created,
        model: payload.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    return new ReadableStream({
      start: (controller) => {
        controller.enqueue(encoder.encode(emit({ role: "assistant", content: "" }, null)));
        if (message.reasoning_content)
          controller.enqueue(encoder.encode(emit({ reasoning_content: message.reasoning_content }, null)));
        if (message.tool_calls) {
          const streamedCalls = message.tool_calls.map((call, index) => ({ index, ...call }));
          controller.enqueue(encoder.encode(emit({ content: message.content, tool_calls: streamedCalls }, null)));
        } else if (message.content) {
          controller.enqueue(encoder.encode(emit({ content: message.content }, null)));
        }
        controller.enqueue(encoder.encode(emit({}, choice.finish_reason)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  async recoverFromDuplicate(page, body, basePrompt, guardedResult) {
    this.runtime.recoveryAttempts += 1;
    const recoveryPrompt = [
      basePrompt,
      "DUPLICATE-CALL RECOVERY:",
      guardedResult,
      "Your immediately preceding proposed tool call duplicated a successful operation and was blocked.",
      "Do not emit that same call again. Continue with the next different required tool, or provide the final answer if the task is complete.",
    ].join("\n\n");
    try {
      const recoveryState = await this.createAgentSession(page, recoveryPrompt);
      const raw = await this.readAgentOutput(page, recoveryState);
      this.#dump("last-recovery-sse", raw);
      const parsed = parseAgentOutput(raw);
      const textResult = parseToolCalls(parsed.text, body.tools, this.config.maxToolCalls);
      const nativeCalls = textResult.toolCalls ? null : parseNativeToolCalls(parsed.nativeCalls, body.tools, this.config.maxToolCalls);
      const effectiveCalls = textResult.toolCalls || nativeCalls;
      if (nativeCalls) await this.stopArenaRun(page);
      const repeatedAgain = repeatedToolGuard(body, effectiveCalls);
      if (repeatedAgain) return this.makeCompletion(body.model || "agent", guardedResult, null, parsed.reasoning);
      this.runtime.recoverySuccesses += 1;
      const content = textResult.content || (effectiveCalls ? "" : parsed.text || guardedResult);
      return this.makeCompletion(body.model || "agent", content, effectiveCalls, parsed.reasoning);
    } catch (error) {
      log.warn("bridge", "duplicate recovery failed", { error: error?.message });
      return this.makeCompletion(body.model || "agent", guardedResult, null, "");
    }
  }

  #dump(name, value) {
    try {
      fs.writeFileSync(`/tmp/arena-agent-${name}.txt`, String(value), { mode: 0o600 });
      this.lastDumps[name] = String(value).slice(0, 400);
    } catch {
      /* non-fatal */
    }
  }

  async runAgent(body, headers) {
    return this.#serialized(async () => {
      this.#dump("last-request", JSON.stringify(body));
      const page = await this.#page();
      const key = sessionKey(body, headers);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const stateless = hasTools;
      let state = stateless ? null : this.sessions.get(key);
      const priorNodeId =
        state && Date.now() - Number(state.updatedAt || 0) <= this.config.sessionTtlMs ? state.lastNodeId || null : null;
      const messages = stateless ? body.messages || [] : state ? latestTurn(body.messages) : body.messages || [];
      const includeTools = hasTools && (stateless || state?.toolsInitialized !== true);
      const prompt = formatMessages(messages, includeTools, body.tools, this.config.profile);
      this.#dump("last-prompt", prompt);
      if (!prompt.trim()) throw Object.assign(new Error("Arena Agent prompt is empty"), { status: 400 });

      if (!state || Date.now() - Number(state.updatedAt || 0) > this.config.sessionTtlMs) {
        state = await this.createAgentSession(page, prompt);
      } else {
        if (!page.url().startsWith("https://arena.ai/")) {
          await page.goto(`https://arena.ai/agent/${state.id}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
        }
        try {
          await this.appendAgentMessage(page, state, prompt);
        } catch (error) {
          if (Number(error.status || 0) === 401 || Number(error.status || 0) === 404) {
            state = await this.createAgentSession(
              page,
              formatMessages(body.messages || [], hasTools, body.tools, this.config.profile)
            );
          } else {
            throw error;
          }
        }
      }

      let raw = await this.readAgentOutput(page, state);
      let parsed = parseAgentOutput(raw);
      if (priorNodeId && parsed.lastNodeId === priorNodeId && parsed.nativeCalls.length === 0) {
        if (parsed.token) state.token = parsed.token;
        if (parsed.lastEventId) state.lastEventId = parsed.lastEventId;
        const refreshedToken = await retry(() => this.refreshAgentToken(page, state.id), {
          attempts: 2,
          baseMs: 400,
          maxMs: 1500,
          label: "token-refresh",
        }).catch(() => "");
        if (refreshedToken) state.token = refreshedToken;
        await new Promise((r) => setTimeout(r, 400));
        raw = await this.readAgentOutput(page, state);
        parsed = parseAgentOutput(raw);
        this.runtime.staleReplays += 1;
        log.info("bridge", "skipped stale Arena Agent turn replay");
      }
      this.#dump("last-sse", raw);
      if (parsed.token) state.token = parsed.token;
      if (parsed.lastEventId) state.lastEventId = parsed.lastEventId;

      const textToolResult = parseToolCalls(parsed.text, body.tools, this.config.maxToolCalls);
      const nativeToolCalls = textToolResult.toolCalls
        ? null
        : parseNativeToolCalls(parsed.nativeCalls, body.tools, this.config.maxToolCalls);
      const effectiveToolCalls = textToolResult.toolCalls || nativeToolCalls;
      if (!effectiveToolCalls && parsed.nativeCalls.length > 0) {
        // Arena invoked its own sandbox tool but no external tool matched.
        // Stop the remote run and report clearly instead of "empty response".
        const names = [...new Set(parsed.nativeCalls.map((c) => c.name || "?"))].join(", ");
        await this.stopArenaRun(page).catch(() => undefined);
        this.runtime.nativeIntercepts += parsed.nativeCalls.length;
        const message =
          `(Arena agent attempted sandbox tool(s): ${names} — ` +
          `no external tool was registered for this request, so it was not executed. ` +
          `Re-send with tools defined, or ask the question directly without tool usage.)`;
        log.info("bridge", "unmapped arena native tool call reported", { names });
        return this.makeCompletion(body.model || "agent", message, null, parsed.reasoning);
      }
      const guardedResult = repeatedToolGuard(body, effectiveToolCalls);

      if (nativeToolCalls) {
        this.sessions.delete(key);
        await this.stopArenaRun(page);
        this.runtime.nativeIntercepts += nativeToolCalls.length;
        log.info("bridge", `intercepted ${nativeToolCalls.length} Arena native tool call(s)`, {
          names: nativeToolCalls.map((c) => c.function.name).join(","),
        });
        if (guardedResult) {
          this.runtime.duplicateBlocks += 1;
          return this.recoverFromDuplicate(page, body, prompt, guardedResult);
        }
        return this.makeCompletion(body.model || "agent", "", nativeToolCalls, parsed.reasoning);
      }

      state.lastNodeId = parsed.lastNodeId;
      state.requiresReview = parsed.requiresReview;
      state.toolsInitialized = state.toolsInitialized === true || hasTools;
      state.updatedAt = Date.now();
      if (stateless) this.sessions.delete(key);
      else this.sessions.set(key, state);

      if (guardedResult) {
        this.runtime.duplicateBlocks += 1;
        return this.recoverFromDuplicate(page, body, prompt, guardedResult);
      }
      const content = textToolResult.content || (textToolResult.toolCalls ? "" : parsed.text || "(empty Agent response)");
      return this.makeCompletion(body.model || "agent", content, textToolResult.toolCalls, parsed.reasoning);
    });
  }

  healthPayload() {
    const credential = this.credentials.primary();
    const averageLatencyMs = this.runtime.completed
      ? Math.round(this.runtime.totalLatencyMs / this.runtime.completed)
      : 0;
    return {
      ok: true,
      service: "arena-bridge",
      version: "5.0.0",
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      mode: "stateless-claude-tools",
      sessions: this.sessions.size,
      activeArenaAccounts: this.credentials.accounts.length,
      account: credential ? { email: credential.email, cookieExpiry: this.credentials.expirySummary(credential) } : null,
      refresh: { lastLoginError: this.credentials.lastLoginError },
      recaptcha: this.recaptcha.status(),
      queue: { active: this.runtime.activeRequests, depth: this.runtime.queueDepth, maxDepth: this.config.maxQueue },
      browser: {
        launched: Boolean(this.browser.browser),
        contextReady: Boolean(this.browser.context),
        pageReady: Boolean(this.browser.page && !this.browser.page.isClosed()),
      },
      stats: { ...this.runtime, averageLatencyMs },
    };
  }

  prometheusMetrics() {
    const values = {
      arena_bridge_up: 1,
      arena_bridge_uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      arena_bridge_queue_depth: this.runtime.queueDepth,
      arena_bridge_active_requests: this.runtime.activeRequests,
      arena_bridge_requests_total: this.runtime.requests,
      arena_bridge_completed_total: this.runtime.completed,
      arena_bridge_errors_total: this.runtime.errors,
      arena_bridge_tool_responses_total: this.runtime.toolResponses,
      arena_bridge_text_responses_total: this.runtime.textResponses,
      arena_bridge_native_intercepts_total: this.runtime.nativeIntercepts,
      arena_bridge_duplicate_blocks_total: this.runtime.duplicateBlocks,
      arena_bridge_recovery_attempts_total: this.runtime.recoveryAttempts,
      arena_bridge_recovery_successes_total: this.runtime.recoverySuccesses,
      arena_bridge_stale_replays_total: this.runtime.staleReplays,
      arena_bridge_last_latency_ms: this.runtime.lastLatencyMs,
    };
    return `${Object.entries(values).map(([name, value]) => `${name} ${Number(value) || 0}`).join("\n")}\n`;
  }
}

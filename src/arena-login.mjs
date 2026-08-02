// arena-login.mjs — real email/password login against arena.ai using
// Playwright, plus reCAPTCHA v3 token generation. Fully standalone.
import { createRequire } from "node:module";
import { retry, log, sleep } from "./util.mjs";

const require = createRequire(import.meta.url);

export function resolvePlaywright(omniRoot) {
  const candidates = [];
  if (omniRoot) candidates.push(`${omniRoot}/node_modules/playwright`, `${omniRoot}/node_modules/playwright-core`);
  candidates.push("playwright", "playwright-core");
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod?.chromium) return mod;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Playwright not resolvable (tried: ${candidates.join(", ")}). Run: npm install playwright && npx playwright install chromium`
  );
}

export class ArenaBrowser {
  constructor({ omniRoot = "", chromePath = "", proxy = "", userAgent } = {}) {
    this.pw = resolvePlaywright(omniRoot);
    this.chromePath = chromePath;
    this.proxy = proxy;
    this.userAgent =
      userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
    this.browser = null;
    this.context = null;
    this.page = null;
    this.recaptchaPage = null;
    this.credentialSignature = "";
  }

  async launch() {
    if (this.browser) {
      try {
        return this.browser;
      } catch {
        this.browser = null;
      }
    }
    return retry(
      async () => {
        const args = ["--no-sandbox", "--disable-dev-shm-usage"];
        if (this.proxy) args.push(`--proxy-server=${this.proxy}`);
        const launchOpts = { headless: true, args };
        if (this.chromePath) launchOpts.executablePath = this.chromePath;
        this.browser = await this.pw.chromium.launch(launchOpts);
        return this.browser;
      },
      { attempts: 3, baseMs: 1000, maxMs: 8000, label: "chromium-launch" }
    );
  }

  async getPage(cookieHeader = "", signature = "") {
    const browser = await this.launch();
    if (!this.context || this.credentialSignature !== signature) {
      await this.context?.close().catch(() => undefined);
      this.recaptchaPage = null;
      this.context = await browser.newContext({
        userAgent: this.userAgent,
        viewport: { width: 1440, height: 900 },
        locale: "fa-IR",
      });
      if (cookieHeader) await this.context.addCookies(this.#cookieObjects(cookieHeader));
      this.page = await this.context.newPage();
      this.credentialSignature = signature;
    }
    if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
    return this.page;
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    this.page = null;
    this.recaptchaPage = null;
  }

  #cookieObjects(raw) {
    return String(raw || "")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.includes("="))
      .map((x) => {
        const i = x.indexOf("=");
        return {
          name: x.slice(0, i),
          value: x.slice(i + 1),
          domain: "arena.ai",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "Lax",
        };
      });
  }

  /**
   * Perform an email/password login on arena.ai.
   * Returns { email, cookieHeader, password } on success.
   */
  async login(email, password) {
    const browser = await this.launch();
    const context = await browser.newContext({ userAgent: this.userAgent });
    const page = await context.newPage();
    try {
      let result = null;
      await page.goto("https://arena.ai/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await page.evaluate(
          async ({ email, password }) => {
            const response = await fetch("/nextjs-api/sign-in/email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password }),
            });
            return { status: response.status, text: await response.text() };
          },
          { email, password }
        );
        if (result.status === 200) break;
        if (result.status !== 429 && !/just a moment/i.test(result.text)) break;
        log.warn("arena-login", `login rate-limited/blocked (${result.status}); retrying`, { attempt: attempt + 1 });
        await page.goto("https://arena.ai/", { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
        await sleep(8_000);
      }
      if (result?.status !== 200) {
        const hint = String(result?.text || "").slice(0, 240);
        throw new Error(`Arena login failed (${result?.status}): ${hint}`);
      }
      await page.waitForTimeout(1_500);
      const cookies = await context.cookies("https://arena.ai");
      const auth = cookies.filter((c) => c.name.startsWith("arena-auth-prod-v1"));
      if (auth.length === 0) throw new Error("Arena login returned no auth cookie");
      const cookieHeader = cookies
        .filter((c) => c.domain.endsWith("arena.ai"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      return { email, cookieHeader, password };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /**
   * Generate a fresh reCAPTCHA v3 token (action chat_submit).
   */
  async freshRecaptchaToken(cookieHeader, siteKey) {
    const page = await this.getPage(cookieHeader);
    let target = this.recaptchaPage;
    if (!target || target.isClosed()) target = await this.context.newPage();
    this.recaptchaPage = target;
    if (!target.url().startsWith("https://arena.ai/")) {
      await target.goto("https://arena.ai/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    if (!(await target.evaluate(() => typeof globalThis.grecaptcha?.enterprise?.execute === "function"))) {
      await target.addScriptTag({ url: `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}` });
    }
    await target.waitForFunction(
      () => typeof globalThis.grecaptcha?.enterprise?.execute === "function",
      { timeout: 30_000 }
    );
    const token = await target.evaluate(
      async ({ key }) => globalThis.grecaptcha.enterprise.execute(key, { action: "chat_submit" }),
      { key: siteKey }
    );
    if (typeof token !== "string" || token.length < 80) {
      throw new Error("Fresh Arena reCAPTCHA token was empty or too short");
    }
    return token;
  }
}

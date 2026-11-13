/**
 * Firefox BiDi browser tools for OpenCode.
 *
 * Attaches to an already-running Firefox started with:
 *   firefox --remote-debugging-port 9222
 *
 * Firefox exposes WebDriver BiDi (not CDP), so this plugin speaks BiDi
 * directly. It keeps one session for the lifetime of the plugin and can
 * launch/restart Firefox when needed.
 *
 * Environment:
 *   FIREFOX_BIDI_PORT   default 9222
 *   FIREFOX_BIN         default auto-detected (see firefoxBinary)
 *   FIREFOX_PROFILE     optional -profile argument
 */

import { Plugin } from "@opencode/plugin";
import { existsSync } from "node:fs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.FIREFOX_BIDI_PORT ?? 9222);
const WS_URL = `ws://${HOST}:${PORT}/session`;
const HTTP_URL = `http://${HOST}:${PORT}/`;

type Json = any;

class BidiError extends Error {
  method: string;
  constructor(method: string, message: string) {
    super(message);
    this.method = method;
  }
}

class BidiClient {
  ws: WebSocket;
  nextId = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.type === "error") entry.reject(new BidiError(msg.error ?? "error", msg.message ?? "unknown error"));
      else entry.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const [, entry] of this.pending) entry.reject(new Error("WebSocket closed"));
      this.pending.clear();
    });
  }

  static async connect(timeoutMs = 10000): Promise<BidiClient> {
    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout connecting to ${WS_URL}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Cannot connect to ${WS_URL}`));
      });
    });

    const client = new BidiClient(ws);
    // A WebSocket connection is not attached to an existing session, even when
    // session.status reports ready. Always create one. If Firefox says a
    // session is already active, retry briefly first: a plugin reload may still
    // be releasing the previous session.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await client.send("session.new", { capabilities: { alwaysMatch: {} } });
        return client;
      } catch (error) {
        lastError = error as Error;
        if (!/Maximum number of active sessions|session already started/i.test(lastError.message)) break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    ws.close();
    if (/Maximum number of active sessions|session already started/i.test(lastError?.message ?? "")) {
      throw new Error(
        "Firefox already has an active debugging session (left behind by a disconnected client, e.g. a previous OpenCode run). " +
          "Run firefox_restart to recover — it reopens the current page.",
      );
    }
    throw lastError ?? new Error("Could not start a Firefox BiDi session.");
  }

  get open() {
    return this.ws.readyState === 1;
  }

  send(method: string, params: Json = {}, timeoutMs = 30000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BiDi timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  async close() {
    try {
      await this.send("session.end", {}, 3000);
    } catch {
      /* ignore */
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* runtime state                                                       */
/* ------------------------------------------------------------------ */

let client: BidiClient | null = null;
let connecting: Promise<BidiClient> | null = null;
let preferredContext: string | null = null;

async function httpUp(timeoutMs = 1000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(HTTP_URL, { signal: controller.signal });
    clearTimeout(timer);
    return response.status < 500;
  } catch {
    return false;
  }
}

function firefoxBinary(): string {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const candidates = [
    "/usr/lib/firefox/firefox",
    "/usr/bin/firefox",
    "/snap/bin/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `Firefox binary not found. Set FIREFOX_BIN to the Firefox executable. Tried:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

async function startFirefox(url?: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  const bin = firefoxBinary();
  const args = [`--remote-debugging-port`, String(PORT), "--width", "1600", "--height", "1000"];
  if (process.env.FIREFOX_PROFILE) args.push("-profile", process.env.FIREFOX_PROFILE);
  args.push(url || "about:blank");

  const child = spawn(bin, args, { detached: true, stdio: "ignore", env: process.env });
  child.unref();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await httpUp(500)) return bin;
    await sleep(400);
  }
  throw new Error(`Firefox did not expose port ${PORT} within 25s (binary: ${bin}).`);
}

async function stopFirefox(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const windows = process.platform === "win32";
  const command = windows ? "taskkill" : "pkill";
  const args = windows ? ["/IM", "firefox.exe", "/F"] : ["-x", "firefox"];
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  // wait for the port to disappear
  for (let i = 0; i < 25; i++) {
    if (!(await httpUp(300))) return;
    await sleep(200);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getClient(): Promise<BidiClient> {
  if (client?.open) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!(await httpUp())) await startFirefox();
    const created = await BidiClient.connect();
    client = created;
    return created;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function cmd(method: string, params: Json = {}, timeoutMs = 30000) {
  const bidi = await getClient();
  return bidi.send(method, params, timeoutMs);
}

/* ------------------------------------------------------------------ */
/* page helpers                                                        */
/* ------------------------------------------------------------------ */

function toPlain(value: any): Json {
  if (!value || typeof value !== "object") return value;
  switch (value.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
    case "number":
      return value.value;
    case "array":
      return (value.value ?? []).map(toPlain);
    case "object":
      return Object.fromEntries((value.value ?? []).map(([k, v]: [string, any]) => [k, toPlain(v)]));
    case "node":
      return `[${value.value?.localName ?? "node"}]`;
    case "date":
      return value.value;
    default:
      return value.value ?? null;
  }
}

async function evaluate(context: string, expression: string): Promise<Json> {
  const result: any = await cmd("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (result.type === "exception") {
    const detail = result.exceptionDetails;
    const text =
      detail?.exception?.description ?? detail?.exception?.value ?? detail?.text ?? "JavaScript exception";
    throw new Error(String(text).split("\n")[0]);
  }
  return toPlain(result.result);
}

async function topContext(): Promise<string> {
  if (preferredContext) {
    try {
      await cmd("browsingContext.getTree", { root: preferredContext });
      return preferredContext;
    } catch {
      preferredContext = null;
    }
  }
  const tree: any = await cmd("browsingContext.getTree", {});
  const tabs = (tree.contexts ?? []).filter((c: any) => !c.parent);
  if (!tabs.length) throw new Error("No browser tab is open.");
  preferredContext = tabs[tabs.length - 1].context as string;
  return preferredContext;
}

async function ensureTab(): Promise<string> {
  const tree: any = await cmd("browsingContext.getTree", {});
  const tabs = (tree.contexts ?? []).filter((c: any) => !c.parent);
  if (tabs.length) {
    preferredContext = tabs[tabs.length - 1].context as string;
    return preferredContext;
  }
  const created: any = await cmd("browsingContext.create", { type: "tab", background: false });
  preferredContext = created.context as string;
  return preferredContext;
}

async function navigate(url: string, context?: string): Promise<{ context: string; url: string; title: string }> {
  const ctx = context ?? (await ensureTab());
  try {
    await cmd("browsingContext.navigate", { context: ctx, url, wait: "none" }, 45000);
  } catch (error) {
    if (!/timeout/i.test((error as Error).message)) throw error;
  }
  preferredContext = ctx;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(ctx, "document.readyState");
      if (state === "complete") break;
    } catch {
      /* page may be swapping */
    }
    await sleep(250);
  }
  await sleep(300);
  const info = await evaluate(ctx, "({ url: location.href, title: document.title })");
  return { context: ctx, ...info };
}

const SNAPSHOT_FN = String.raw`(() => {
  const MAX_ELEMENTS = 250;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const testid = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (testid) return "[data-testid=\"" + testid.replace(/"/g, '\\"') + "\"]";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      const tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const index = [...parent.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1;
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = parent;
    }
    return parts.join(" > ");
  };
  const label = (el) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim().slice(0, 90);
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const node = document.getElementById(labelledBy);
      if (node && node.innerText) return clean(node.innerText);
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const id = el.id;
      if (id) {
        const found = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (found) return clean(found.innerText);
      }
      const wrapping = el.closest("label");
      if (wrapping) return clean(wrapping.innerText);
      return clean(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    }
    return clean(el.innerText || el.textContent);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  const candidates = [...document.querySelectorAll(
    'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable="true"],[onclick]'
  )];
  const seen = new Set();
  const elements = [];
  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    if (el.disabled) continue;
    const role = roleOf(el);
    const text = label(el);
    const item = {
      index: elements.length,
      tag: el.tagName.toLowerCase(),
      role,
      text,
      selector: selectorFor(el),
      value: el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ? el.value : undefined,
      type: el.getAttribute("type") || undefined,
      href: el.tagName === "A" ? el.href : undefined,
    };
    elements.push({ index: elements.length, el, item });
  }
  window.__ocFirefox = { elements };
  const bodyText = (document.body ? document.body.innerText : "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(window.scrollY), height: document.body ? document.body.scrollHeight : 0 },
    elements: elements.map((entry) => entry.item),
    text: bodyText,
  };
})()`;

function formatSnapshot(snapshot: any, maxChars: number): string {
  const lines: string[] = [];
  lines.push(`url: ${snapshot.url}`);
  lines.push(`title: ${snapshot.title}`);
  lines.push(`scroll: ${snapshot.scroll?.y ?? 0} / ${snapshot.scroll?.height ?? 0}`);
  lines.push("");
  lines.push("interactive:");
  const elements = snapshot.elements ?? [];
  if (!elements.length) lines.push("  (none)");
  for (const item of elements) {
    let line = `  e${item.index} ${item.role}`;
    if (item.text) line += ` "${item.text}"`;
    if (item.type) line += ` [${item.type}]`;
    if (item.value) line += ` value="${item.value}"`;
    lines.push(line);
  }
  lines.push("");
  lines.push("text:");
  const text = snapshot.text ?? "";
  lines.push(text.length > maxChars ? text.slice(0, maxChars) + `\n…(${text.length - maxChars} chars truncated)` : text);
  return lines.join("\n");
}

const resolveTargetFn = String.raw`(target, prefer) => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const textOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.replace(/\s+/g, " ").trim();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const id = el.id;
      const labelled = id && document.querySelector('label[for="' + CSS.escape(id) + '"]');
      return (el.getAttribute("placeholder") || el.getAttribute("name") ||
        (labelled && labelled.innerText) || "").replace(/\s+/g, " ").trim();
    }
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  };
  const store = window.__ocFirefox;
  if (/^e\d+$/.test(target)) {
    const index = Number(target.slice(1));
    const entry = store && store.elements && store.elements[index];
    if (!entry || !entry.el.isConnected) return { error: "Stale ref " + target + ". Take a new snapshot." };
    return { el: entry.el };
  }
  let el = null;
  try {
    if (target.startsWith("css=")) el = document.querySelector(target.slice(4));
    else if (/^[#.\[]/.test(target)) el = document.querySelector(target);
  } catch {
    el = null;
  }
  if (el && !visible(el)) el = null;
  if (!el) {
    const needle = target.replace(/\s+/g, " ").trim().toLowerCase();
    const all = [...document.querySelectorAll(
      'a[href],button,input,select,textarea,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=combobox],[role=textbox],[role=searchbox],[contenteditable="true"],[aria-label]'
    )].filter((node) => visible(node) && !node.disabled);
    const isField = (node) =>
      node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement || node.isContentEditable ||
      ["combobox", "textbox", "searchbox"].includes(node.getAttribute("role") || "");
    const pool = prefer === "field" ? all.filter(isField) : all;
    const pick = (list) => list.find((node) => textOf(node).toLowerCase() === needle)
      || list.find((node) => textOf(node).toLowerCase().startsWith(needle))
      || list.find((node) => textOf(node).toLowerCase().includes(needle))
      || null;
    el = pick(pool);
  }
  if (!el) return { error: "No visible element matches: " + target };
  return { el };
}`;

async function settle(context: string, extraMs = 500): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      if ((await evaluate(context, "document.readyState")) === "complete") break;
    } catch {
      /* navigation in flight */
    }
    await sleep(150);
  }
  await sleep(extraMs);
}

async function click(target: string): Promise<string> {
  const ctx = await topContext();
  const result: any = await evaluate(
    ctx,
    `(() => {
      const resolve = ${resolveTargetFn};
      const found = resolve(${JSON.stringify(target)}, "click");
      if (found.error) return found;
      const el = found.el;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus && el.focus();
      el.click();
      return { clicked: (el.innerText || el.getAttribute("aria-label") || el.tagName).replace(/\\s+/g, " ").trim().slice(0, 80) };
    })()`,
  );
  if (result?.error) throw new Error(result.error);
  await settle(ctx, 600);
  const info = await evaluate(ctx, "({ url: location.href, title: document.title })");
  return `clicked: ${result.clicked}\nurl: ${info.url}\ntitle: ${info.title}`;
}

async function fill(target: string, value: string, submit: boolean): Promise<string> {
  const ctx = await topContext();
  const result: any = await evaluate(
    ctx,
    `(() => {
      const resolve = ${resolveTargetFn};
      const found = resolve(${JSON.stringify(target)}, "field");
      if (found.error) return found;
      let el = found.el;
      const isField = (node) =>
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement || node.isContentEditable;
      if (!isField(el) && el.querySelector) {
        const nested = el.querySelector('input,textarea,select,[contenteditable="true"]');
        if (nested) el = nested;
      }
      if (!isField(el)) return { error: "Not a form field: " + (el.tagName || "element") };
      el.scrollIntoView({ block: "center" });
      el.focus && el.focus();
      const text = ${JSON.stringify(value)};
      if (el.isContentEditable) {
        el.textContent = text;
      } else if (el instanceof HTMLSelectElement) {
        const option = [...el.options].find((o) => o.value === text || o.text.trim() === text);
        el.value = option ? option.value : text;
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value");
        if (setter && setter.set) setter.set.call(el, text);
        else el.value = text;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, tag: el.tagName.toLowerCase(), value: el.value };
    })()`,
  );
  if (result?.error) throw new Error(result.error);
  await sleep(300);
  if (submit) {
    await press("Enter");
  }
  const info = await evaluate(ctx, "({ url: location.href, value: (document.activeElement && document.activeElement.value) || null })");
  return `filled ${result.tag}${info.value ? ` → "${info.value}"` : ""}${submit ? " (submitted)" : ""}`;
}

const KEYS: Record<string, string> = {
  Enter: "\uE007",
  Tab: "\uE004",
  Escape: "\uE00C",
  Backspace: "\uE003",
  Delete: "\uE017",
  ArrowLeft: "\uE012",
  ArrowUp: "\uE013",
  ArrowRight: "\uE014",
  ArrowDown: "\uE015",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
  Home: "\uE011",
  End: "\uE010",
  Space: " ",
};

async function press(key: string): Promise<string> {
  const ctx = await topContext();
  const value = KEYS[key] ?? (key.length === 1 ? key : null);
  if (value === null) throw new Error(`Unsupported key: ${key}. Try Enter, Tab, Escape, ArrowDown, PageDown.`);
  await cmd("input.performActions", {
    context: ctx,
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value },
          { type: "keyUp", value },
        ],
      },
    ],
  });
  await settle(ctx, 600);
  return `pressed ${key}`;
}

async function screenshot(path: string, fullPage: boolean): Promise<string> {
  const ctx = await topContext();
  const params: any = { context: ctx };
  if (fullPage) {
    const size = await evaluate(
      ctx,
      "({ width: Math.max(document.documentElement.scrollWidth, window.innerWidth), height: Math.max(document.documentElement.scrollHeight, window.innerHeight) })",
    );
    params.clip = { type: "box", x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 12000) };
  }
  const shot: any = await cmd("browsingContext.captureScreenshot", params);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(shot.data, "base64"));
  return path;
}

async function listTabs(): Promise<Array<{ index: number; id: string; url: string; title: string }>> {
  const tree: any = await cmd("browsingContext.getTree", {});
  return (tree.contexts ?? [])
    .filter((c: any) => !c.parent)
    .map((c: any, index: number) => ({ index, id: c.context, url: c.url, title: c.title }));
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export default Plugin.define({
  id: "firefox-bidi",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "firefox",
        description: "Drive the user's Firefox browser over WebDriver BiDi (real profile, existing logins).",
      });

      const add = (tool: Parameters<typeof editor.add>[0]) =>
        editor.add({
          ...tool,
          options: { namespace: "firefox", codemode: true },
        });

      add({
        name: "status",
        description:
          "Check whether Firefox's debugging port is reachable, whether a BiDi session is attached, and list open tabs.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const up = await httpUp();
          if (!up) return { content: `Firefox debugging port ${PORT} is not reachable. Use firefox_start to launch it.` };
          let session = "attached";
          let tabs = "";
          try {
            await getClient();
            const list = await listTabs();
            tabs = list.map((t) => `${t.index}: ${t.title || "(untitled)"} — ${t.url}`).join("\n") || "(no tabs)";
          } catch (error) {
            session = "not attached";
            tabs = (error as Error).message;
          }
          return { content: `port ${PORT}: up\nsession: ${session}\ntabs:\n${tabs}` };
        },
      });

      add({
        name: "start",
        description: "Launch Firefox with remote debugging if it is not already running. Optionally opens a URL.",
        input: {
          type: "object",
          properties: { url: { type: "string", description: "Optional URL to open." } },
          additionalProperties: false,
        },
        execute: async (input) => {
          const { url } = input as { url?: string };
          if (await httpUp()) {
            await getClient();
            return { content: `Firefox already running on port ${PORT}; session attached.` };
          }
          const bin = await startFirefox(url);
          await getClient();
          return { content: `Started ${bin} with remote debugging on port ${PORT}.` };
        },
      });

      add({
        name: "restart",
        description:
          "Kill and relaunch Firefox. Use this to recover from a stale debugging session. The current page URL is reopened.",
        input: {
          type: "object",
          properties: { url: { type: "string", description: "URL to open after restart (defaults to the current page)." } },
          additionalProperties: false,
        },
        execute: async (input) => {
          let reopen = (input as { url?: string }).url;
          if (!reopen) {
            try {
              reopen = await evaluate(await topContext(), "location.href");
            } catch {
              reopen = undefined;
            }
          }
          if (client) {
            try {
              await client.close();
            } catch {
              /* ignore */
            }
            client = null;
          }
          preferredContext = null;
          await stopFirefox();
          const bin = await startFirefox(reopen);
          await getClient();
          return { content: `Restarted Firefox (${bin})${reopen ? ` and reopened ${reopen}` : ""}.` };
        },
      });

      add({
        name: "navigate",
        description:
          "Open a URL in Firefox and wait for the page to load. Uses the current tab unless newTab is true. Returns the final URL and title.",
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute URL to open." },
            newTab: { type: "boolean", description: "Open in a new tab instead of the current one." },
          },
          required: ["url"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const { url: initialUrl, newTab } = input as { url: string; newTab?: boolean };
          let url = initialUrl;
          if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
          let context: string | undefined;
          if (newTab) {
            const created: any = await cmd("browsingContext.create", { type: "tab", background: false });
            context = created.context;
          }
          const info = await navigate(url, context);
          return { content: `url: ${info.url}\ntitle: ${info.title}` };
        },
      });

      add({
        name: "snapshot",
        description:
          "Read the current page: URL, title, a numbered list of interactive elements (e0, e1, …) that click/fill accept, and the visible text. Always take a snapshot before clicking so refs are fresh.",
        input: {
          type: "object",
          properties: {
            maxChars: { type: "number", description: "Max characters of page text to return (default 6000)." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const { maxChars } = input as { maxChars?: number };
          const ctx = await topContext();
          let snapshot = await evaluate(ctx, SNAPSHOT_FN);
          // Pages that are still painting often report an empty body right
          // after a navigation-triggering click. Give them a moment.
          for (let attempt = 0; attempt < 3 && !snapshot.text && !snapshot.elements?.length; attempt++) {
            await sleep(700);
            snapshot = await evaluate(ctx, SNAPSHOT_FN);
          }
          return { content: formatSnapshot(snapshot, maxChars ?? 6000) };
        },
      });

      add({
        name: "click",
        description:
          "Click an element. target accepts a snapshot ref (e12), a CSS selector (css=#submit or #submit), or visible text/aria-label (e.g. \"Accept all\").",
        input: {
          type: "object",
          properties: { target: { type: "string", description: "Ref, CSS selector, or visible text." } },
          required: ["target"],
          additionalProperties: false,
        },
        execute: async (input) => ({ content: await click((input as { target: string }).target) }),
      });

      add({
        name: "fill",
        description:
          "Type into a text field, textarea, or select. target accepts a ref (e3), CSS selector, or label/placeholder text. Sets the value with native events so React/Vue apps see it.",
        input: {
          type: "object",
          properties: {
            target: { type: "string" },
            value: { type: "string" },
            submit: { type: "boolean", description: "Press Enter after filling." },
          },
          required: ["target", "value"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const { target, value, submit } = input as { target: string; value: string; submit?: boolean };
          return { content: await fill(target, value, Boolean(submit)) };
        },
      });

      add({
        name: "press",
        description: "Press a key in the page: Enter, Tab, Escape, ArrowDown, PageDown, Backspace, Space, or a single character.",
        input: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
        execute: async (input) => ({ content: await press((input as { key: string }).key) }),
      });

      add({
        name: "eval",
        description:
          "Evaluate a JavaScript expression in the page and return its value as JSON. Use for extracting data that snapshot truncates, or reading app state.",
        input: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const { expression } = input as { expression: string };
          const value = await evaluate(await topContext(), expression);
          return { content: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
        },
      });

      add({
        name: "bidi",
        description:
          "Escape hatch: send a raw WebDriver BiDi command (e.g. script.addPreloadScript, input.performActions) and return the JSON result.",
        input: {
          type: "object",
          properties: {
            method: { type: "string", description: "BiDi method, e.g. browsingContext.getTree." },
            params: { type: "object", additionalProperties: true },
          },
          required: ["method"],
          additionalProperties: false,
        },
        execute: async ({ method, params }: { method: string; params?: any }) => {
          const result = await cmd(method, params ?? {});
          return { content: JSON.stringify(result, null, 2) };
        },
      });

      add({
        name: "mask_automation",
        description:
          "Install a preload script that hides navigator.webdriver for this session, so bot-protection pages (e.g. airline checkouts) render. Re-apply after a restart.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const result: any = await cmd("script.addPreloadScript", {
            functionDeclaration: `() => {
              try {
                Object.defineProperty(Navigator.prototype, "webdriver", {
                  get: () => false,
                  configurable: true,
                });
              } catch (error) {}
            }`,
          });
          return { content: `installed preload script ${result.script ?? "(unknown id)"}` };
        },
      });

      add({
        name: "screenshot",
        description: "Capture the current page as a PNG and save it to disk. Returns the file path, which can be opened with the read tool.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output path (default /tmp/opencode/firefox-screenshot.png)." },
            fullPage: { type: "boolean", description: "Capture the full scrollable page." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const { path, fullPage } = input as { path?: string; fullPage?: boolean };
          const out = path || "/tmp/opencode/firefox-screenshot.png";
          await screenshot(out, Boolean(fullPage));
          return { content: `saved ${out}` };
        },
      });

      add({
        name: "tabs",
        description: "List open tabs, or switch to / close one by index or context id.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "switch", "close"], description: "Default: list." },
            target: { type: "string", description: "Tab index (0, 1…) or context id, for switch/close." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const { action, target } = input as { action?: string; target?: string };
          const tabs = await listTabs();
          if (!action || action === "list") {
            return { content: tabs.map((t) => `${t.index}: ${t.title || "(untitled)"} — ${t.url}`).join("\n") || "(no tabs)" };
          }
          const found = tabs.find((t) => String(t.index) === String(target) || t.id === target);
          if (!found) throw new Error(`No tab matching ${target}. Tabs: ${tabs.map((t) => t.index).join(", ")}`);
          if (action === "switch") {
            preferredContext = found.id;
            await cmd("browsingContext.activate", { context: found.id });
            return { content: `switched to ${found.index}: ${found.title} — ${found.url}` };
          }
          await cmd("browsingContext.close", { context: found.id });
          if (preferredContext === found.id) preferredContext = null;
          return { content: `closed ${found.index}: ${found.title} — ${found.url}` };
        },
      });
    });

    return async () => {
      if (client) {
        await client.close().catch(() => {});
        client = null;
      }
    };
  },
});

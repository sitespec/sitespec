import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface AuditViewport {
  name: "desktop" | "tablet" | "mobile";
  width: number;
  height: number;
  mobile: boolean;
}

export const AUDIT_VIEWPORTS: Record<AuditViewport["name"], AuditViewport> = {
  desktop: { name: "desktop", width: 1440, height: 1200, mobile: false },
  tablet: { name: "tablet", width: 768, height: 1024, mobile: true },
  mobile: { name: "mobile", width: 375, height: 812, mobile: true }
};

export interface MigrateAuditOptions {
  url: string;
  root?: string;
  output?: string;
  browserPath?: string;
  viewports?: AuditViewport["name"][];
  timeoutMs?: number;
  settleMs?: number;
}

export interface AuditInventoryItem {
  key: string;
  value?: string;
  count: number;
  properties?: Record<string, number>;
  viewports?: Record<string, number>;
  style?: Record<string, string>;
}

export interface AuditDesignInventory {
  elements: { total: number; visible: number; textBearing: number };
  colors: { totalDistinct: number; items: AuditInventoryItem[] };
  typography: { totalDistinct: number; items: AuditInventoryItem[] };
  radii: { totalDistinct: number; items: AuditInventoryItem[] };
  shadows: { totalDistinct: number; items: AuditInventoryItem[] };
  spacing: { totalDistinct: number; items: AuditInventoryItem[] };
  containerWidths: { totalDistinct: number; items: AuditInventoryItem[] };
}

export interface AuditMediaUsage {
  viewport: string;
  selector: string;
  tag: string;
  width: number;
  height: number;
}

export interface AuditMediaItem {
  kind: "image" | "background-image" | "video" | "video-poster" | "inline-svg";
  url?: string;
  external?: boolean;
  alt?: string;
  title?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  srcset?: string;
  sizes?: string;
  loading?: string;
  fetchPriority?: string;
  viewports: string[];
  usages: AuditMediaUsage[];
}

export interface AuditLayoutNode {
  selector: string;
  tag: string;
  heading?: string;
  content?: {
    textLength?: number;
    headings?: number;
    links?: number;
    buttons?: number;
    images?: number;
    videos?: number;
    forms?: number;
    lists?: number;
  };
  structure?: {
    directChildren?: number;
    directChildTags?: string[];
    descendantTags?: Record<string, number>;
  };
  style?: {
    display?: string;
    position?: string;
    color?: string;
    backgroundColor?: string;
    borderRadius?: string;
    paddingTop?: string;
    paddingRight?: string;
    paddingBottom?: string;
    paddingLeft?: string;
    gap?: string;
    gridTemplateColumns?: string;
    flexDirection?: string;
    alignItems?: string;
    justifyContent?: string;
  };
  headingStyle?: {
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textTransform?: string;
  };
  box: { x: number; y: number; width: number; height: number };
}

export type AuditLeafUiKind =
  | "button"
  | "link"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "badge-candidate"
  | "card-candidate";

export interface AuditLeafUiObservation {
  kind: AuditLeafUiKind;
  selector: string;
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  ariaLabel?: string;
  href?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  checked?: boolean;
  segmentId?: string;
  style: {
    display?: string;
    alignItems?: string;
    justifyContent?: string;
    color?: string;
    backgroundColor?: string;
    borderTopWidth?: string;
    borderTopColor?: string;
    borderRadius?: string;
    paddingTop?: string;
    paddingRight?: string;
    paddingBottom?: string;
    paddingLeft?: string;
    gap?: string;
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textDecorationLine?: string;
    boxShadow?: string;
  };
  structure: {
    directChildren: number;
    icons: number;
    images: number;
  };
  box: { x: number; y: number; width: number; height: number };
}


export interface AuditMediaObservation extends Omit<AuditMediaItem, "external" | "viewports" | "usages"> {
  selector: string;
  tag: string;
  width: number;
  height: number;
}

export interface MigrateAuditResult {
  sourceUrl: string;
  finalUrl: string;
  output: string;
  browser: { executable: string; userAgent: string };
  viewports: AuditViewport[];
  files: {
    audit: string;
    page: string;
    dom: string;
    designInventory: string;
    media: string;
    sections: string;
    ui: string;
    layout: string;
    screenshots: string[];
    sectionScreenshots: string[];
    segments?: string;
  };
  summary: {
    sections: number;
    sectionRegionNodes: number;
    manualRegionMatches?: number;
    manualBoundaryGroups?: number;
    media: number;
    uiElements: number;
    layoutNodes: number;
    visibleElements: number;
    colors: number;
    typography: number;
    radii: number;
    screenshots: number;
  };
}

export class MigrateAuditError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateAuditError";
    this.code = code;
    this.details = details;
  }
}

type CdpParams = Record<string, unknown>;

type CdpEventListener = {
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly socket: WebSocket;
  private closing = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const message = JSON.parse(raw) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message ?? `CDP error ${message.error.code ?? "unknown"}`));
          else pending.resolve(message.result);
          return;
        }
        if (!message.method) return;
        const listeners = this.listeners.get(message.method);
        if (!listeners) return;
        for (const listener of [...listeners]) {
          if (!listener.predicate(message.params)) continue;
          clearTimeout(listener.timer);
          listeners.delete(listener);
          listener.resolve(message.params);
        }
        if (listeners.size === 0) this.listeners.delete(message.method);
      } catch {
        // Ignore malformed browser messages; command responses remain authoritative.
      }
    });

    const close = () => {
      if (this.closing) {
        this.pending.clear();
        for (const listeners of this.listeners.values()) for (const listener of listeners) clearTimeout(listener.timer);
        this.listeners.clear();
        return;
      }
      const error = new Error("Chrome DevTools connection closed.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) {
          clearTimeout(listener.timer);
          listener.reject(error);
        }
      }
      this.listeners.clear();
    };
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Timed out connecting to Chrome DevTools.")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Could not connect to Chrome DevTools."));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  send<T = unknown>(method: string, params: CdpParams = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveCommand, rejectCommand) => {
      this.pending.set(id, {
        resolve: value => resolveCommand(value as T),
        reject: rejectCommand
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent<T = unknown>(method: string, timeoutMs: number, predicate: (params: T) => boolean = () => true): Promise<T> {
    return new Promise<T>((resolveEvent, rejectEvent) => {
      const listeners = this.listeners.get(method) ?? new Set<CdpEventListener>();
      const listener: CdpEventListener = {
        predicate: params => predicate(params as T),
        resolve: params => resolveEvent(params as T),
        reject: rejectEvent,
        timer: setTimeout(() => {
          listeners.delete(listener);
          if (listeners.size === 0) this.listeners.delete(method);
          rejectEvent(new Error(`Timed out waiting for ${method}.`));
        }, timeoutMs)
      };
      listeners.add(listener);
      this.listeners.set(method, listeners);
    });
  }

  close(): void {
    this.closing = true;
    for (const listeners of this.listeners.values()) for (const listener of listeners) clearTimeout(listener.timer);
    this.listeners.clear();
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      // Browser process teardown is the final fallback.
    }
  }
}

export interface LaunchedChrome {
  executable: string;
  process: ChildProcess;
  profile: string;
  port: number;
  stderr: () => string;
}

interface PageCapture {
  viewport: AuditViewport;
  finalUrl: string;
  userAgent: string;
  page: Record<string, unknown>;
  dom: string;
  design: AuditDesignInventory;
  media: AuditMediaObservation[];
  layout: AuditLayoutNode[];
  sections: Array<Record<string, unknown> & { auditId: string; label: string; box: { x: number; y: number; width: number; height: number } }>;
  regions: AuditLayoutNode[];
  manualRegions: ManualViewportRegion[];
  ui: AuditLeafUiObservation[];
  screenshot: string;
  sectionScreenshots: Array<{ auditId: string; file: string }>;
}

export interface ManualRootFingerprint {
  tag?: string;
  id?: string;
  classes?: string[];
  heading?: string;
  textHash?: string;
  structureHash?: string;
  ancestry?: Array<{ tag?: string; id?: string; classes?: string[] }>;
}

export interface ManualRootTarget {
  targetId: string;
  segmentId: string;
  rootIndex: number;
  selector: string;
  tag?: string;
  fingerprint?: ManualRootFingerprint;
}

export interface ManualViewportRegion {
  targetId: string;
  segmentId: string;
  rootIndex: number;
  sourceSelector: string;
  matchedSelector: string;
  matchMethod: "selector" | "fingerprint";
  score: number;
  item: AuditLayoutNode;
  boundary?: AuditLayoutNode;
  boundaryConfidence?: number;
}

function safeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MigrateAuditError("MIGRATE_URL_INVALID", `Invalid audit URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MigrateAuditError("MIGRATE_URL_UNSUPPORTED", "migrate audit accepts only http:// and https:// URLs.");
  }
  return url;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "page";
}

export function resolveAuditOutputDirectory(root: string, source: string, output?: string): string {
  if (output) return isAbsolute(output) ? output : resolve(root, output);
  const url = safeUrl(source);
  const host = slug(url.host.replace(/^www\./, ""));
  const route = url.pathname === "/" ? "home" : slug(url.pathname.split("/").filter(Boolean).join("-"));
  return join(resolve(root), ".sitespec", "audit", host, route);
}

export function parseAuditViewports(value: string | undefined): AuditViewport["name"][] {
  if (!value) return ["desktop", "tablet", "mobile"];
  const result = [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
  if (result.length === 0) throw new MigrateAuditError("MIGRATE_VIEWPORTS_EMPTY", "At least one audit viewport is required.");
  for (const name of result) {
    if (!(name in AUDIT_VIEWPORTS)) {
      throw new MigrateAuditError("MIGRATE_VIEWPORT_UNKNOWN", `Unknown viewport ${JSON.stringify(name)}.`, {
        allowed: Object.keys(AUDIT_VIEWPORTS)
      });
    }
  }
  return result as AuditViewport["name"][];
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(name: string): string[] {
  const pathValue = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  return pathValue.split(separator).filter(Boolean).map(directory => join(directory, process.platform === "win32" ? `${name}.exe` : name));
}

export async function findAuditBrowser(explicit?: string): Promise<string> {
  const requested = explicit ?? process.env.SITESPEC_CHROME_PATH;
  if (requested) {
    const absolute = resolve(requested);
    if (await executableExists(absolute)) return absolute;
    throw new MigrateAuditError("MIGRATE_BROWSER_NOT_FOUND", `Chrome/Chromium executable does not exist or is not executable: ${absolute}`, {
      browserPath: absolute
    });
  }

  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium")
    );
  } else if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
    for (const root of roots) {
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
        join(root, "Chromium", "Application", "chrome.exe")
      );
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    );
  }
  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) candidates.push(...pathCandidates(command));

  for (const candidate of [...new Set(candidates)]) {
    if (await executableExists(candidate)) return candidate;
  }

  throw new MigrateAuditError(
    "MIGRATE_BROWSER_NOT_FOUND",
    "No Chrome/Chromium executable was found. Install Google Chrome or Chromium, pass --browser-path, or set SITESPEC_CHROME_PATH.",
    { environmentVariable: "SITESPEC_CHROME_PATH" }
  );
}

export async function launchChrome(executable: string, timeoutMs: number, options: { headless?: boolean; windowSize?: { width: number; height: number } } = {}): Promise<LaunchedChrome> {
  const profile = await mkdtemp(join(tmpdir(), "sitespec-migrate-chrome-"));
  const args = [
    ...(options.headless === false ? [] : ["--headless=new"]),
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-gpu",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-dev-shm-usage",
    "--metrics-recording-only",
    ...(options.windowSize ? [`--window-size=${options.windowSize.width},${options.windowSize.height}`] : []),
    "about:blank"
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");

  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  const activePortFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  let port: number | undefined;
  while (Date.now() - started < Math.min(timeoutMs, 10_000)) {
    if (child.exitCode !== null) break;
    try {
      const value = await readFile(activePortFile, "utf8");
      const parsed = Number(value.split(/\r?\n/)[0]);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        break;
      }
    } catch {
      // Chrome creates DevToolsActivePort asynchronously.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }

  if (!port) {
    try { child.kill("SIGTERM"); } catch { /* no-op */ }
    await rm(profile, { recursive: true, force: true });
    throw new MigrateAuditError("MIGRATE_BROWSER_START_FAILED", "Chrome/Chromium did not expose a DevTools endpoint.", {
      executable,
      stderr: stderr.trim().slice(-4000)
    });
  }

  return { executable, process: child, profile, port, stderr: () => stderr };
}

async function waitForProcessExit(process: ChildProcess, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null) return;
  await new Promise<void>(resolveExit => {
    const timer = setTimeout(resolveExit, timeoutMs);
    process.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

export async function closeChrome(browser: LaunchedChrome): Promise<void> {
  if (browser.process.exitCode === null) {
    try { browser.process.kill("SIGTERM"); } catch { /* no-op */ }
    await waitForProcessExit(browser.process, 1200);
    if (browser.process.exitCode === null) {
      try { browser.process.kill("SIGKILL"); } catch { /* no-op */ }
      await waitForProcessExit(browser.process, 1200);
    }
  }
  try {
    await rm(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Browser profile cleanup must not turn a completed audit into a failed command.
  }
}

export interface DevToolsPageTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export function selectReusablePageTarget(targets: DevToolsPageTarget[]): DevToolsPageTarget | undefined {
  const pages = targets.filter(target => target.type === "page" && Boolean(target.webSocketDebuggerUrl));
  return pages.find(target => target.url === "about:blank") ?? pages[0];
}

export async function createPageClient(port: number, timeoutMs: number): Promise<CdpClient> {
  const connectionTimeout = Math.min(timeoutMs, 10_000);
  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(connectionTimeout)
  });
  if (!listResponse.ok) throw new Error(`Chrome DevTools target listing failed with HTTP ${listResponse.status}.`);
  const targets = await listResponse.json() as DevToolsPageTarget[];
  let target = selectReusablePageTarget(Array.isArray(targets) ? targets : []);

  if (!target) {
    const createResponse = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, {
      method: "PUT",
      signal: AbortSignal.timeout(connectionTimeout)
    });
    if (!createResponse.ok) throw new Error(`Chrome DevTools target creation failed with HTTP ${createResponse.status}.`);
    target = await createResponse.json() as DevToolsPageTarget;
  }

  if (!target.webSocketDebuggerUrl) throw new Error("Chrome DevTools target did not provide a WebSocket URL.");
  return CdpClient.connect(target.webSocketDebuggerUrl, connectionTimeout);
}

export async function evaluate<T>(client: CdpClient, expression: string, awaitPromise = false): Promise<T> {
  const response = await client.send<{
    result?: { value?: T; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: false
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed.");
  }
  return response.result?.value as T;
}

const PAGE_METADATA_EXPRESSION = `(() => {
  const text = (node) => node ? String(node.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || undefined;
  const links = Array.from(document.querySelectorAll('a[href]'));
  const origin = location.origin;
  let internalLinks = 0;
  let externalLinks = 0;
  for (const link of links) {
    try {
      const url = new URL(link.href, location.href);
      if (url.origin === origin) internalLinks += 1;
      else externalLinks += 1;
    } catch {}
  }
  return {
    requestedDocumentUrl: location.href,
    title: document.title,
    lang: document.documentElement.lang || undefined,
    description: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel="canonical"]', 'href'),
    robots: attr('meta[name="robots"]', 'content'),
    viewport: attr('meta[name="viewport"]', 'content'),
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(node => ({
      level: Number(node.tagName.slice(1)),
      text: text(node).slice(0, 300)
    })).filter(item => item.text),
    links: { total: links.length, internal: internalLinks, external: externalLinks },
    forms: document.forms.length,
    scripts: document.scripts.length,
    stylesheets: Array.from(document.styleSheets).length
  };
})()`;

const DESIGN_INVENTORY_EXPRESSION = `(() => {
  const counters = {
    colors: new Map(), typography: new Map(), radii: new Map(), shadows: new Map(), spacing: new Map(), containerWidths: new Map()
  };
  const propertyCounter = (bucket, key, property) => {
    const current = bucket.get(key) || { key, value: key, count: 0, properties: {} };
    current.count += 1;
    current.properties[property] = (current.properties[property] || 0) + 1;
    bucket.set(key, current);
  };
  const simpleCounter = (bucket, key, style) => {
    const current = bucket.get(key) || { key, count: 0, ...(style ? { style } : {}) };
    current.count += 1;
    bucket.set(key, current);
  };
  const ignoredColor = (value) => !value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
  const ignoredSpacing = (value) => !value || value === '0px' || value === 'normal' || value === 'auto';
  const elements = Array.from(document.querySelectorAll('*')).slice(0, 15000);
  let visible = 0;
  let textBearing = 0;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) continue;
    visible += 1;

    for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'fill', 'stroke']) {
      const value = style[property];
      if (!ignoredColor(value) && value !== 'none') propertyCounter(counters.colors, value, property);
    }

    const radius = style.borderRadius;
    if (radius && !/^0(?:px)?(?:\\s+0(?:px)?)*$/.test(radius)) simpleCounter(counters.radii, radius);
    if (style.boxShadow && style.boxShadow !== 'none') simpleCounter(counters.shadows, style.boxShadow);

    for (const property of ['paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','rowGap','columnGap']) {
      const value = style[property];
      if (!ignoredSpacing(value)) propertyCounter(counters.spacing, value, property);
    }

    const hasOwnText = Array.from(element.childNodes).some(node => node.nodeType === 3 && String(node.textContent || '').trim());
    const controlText = ['BUTTON','INPUT','TEXTAREA','SELECT','OPTION'].includes(element.tagName);
    if (hasOwnText || controlText) {
      textBearing += 1;
      const font = {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform
      };
      const key = Object.values(font).join(' | ');
      simpleCounter(counters.typography, key, font);
    }

    if (rect.width >= 280 && rect.width <= innerWidth * 0.98) {
      const leftGap = rect.left;
      const rightGap = innerWidth - rect.right;
      if (Math.abs(leftGap - rightGap) <= 4 || (style.marginLeft === 'auto' && style.marginRight === 'auto')) {
        simpleCounter(counters.containerWidths, String(Math.round(rect.width)) + 'px');
      }
    }
  }

  const toItems = (map, limit = 300) => Array.from(map.values()).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key))).slice(0, limit);
  const group = (map) => ({ totalDistinct: map.size, items: toItems(map) });
  return {
    elements: { total: elements.length, visible, textBearing },
    colors: group(counters.colors),
    typography: group(counters.typography),
    radii: group(counters.radii),
    shadows: group(counters.shadows),
    spacing: group(counters.spacing),
    containerWidths: group(counters.containerWidths)
  };
})()`;

const MEDIA_INVENTORY_EXPRESSION = `(() => {
  const selector = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
      if (classes.length) part += '.' + classes.map(value => CSS.escape(value)).join('.');
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(node => node.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const absolute = (value) => {
    try { return new URL(value, location.href).href; } catch { return value || undefined; }
  };
  const result = [];
  for (const image of Array.from(document.images)) {
    const rect = box(image);
    result.push({
      kind: 'image', url: absolute(image.currentSrc || image.src), alt: image.alt || '', title: image.title || undefined,
      naturalWidth: image.naturalWidth || undefined, naturalHeight: image.naturalHeight || undefined,
      srcset: image.getAttribute('srcset') || undefined, sizes: image.getAttribute('sizes') || undefined,
      loading: image.loading || undefined, fetchPriority: image.fetchPriority || undefined,
      selector: selector(image), tag: 'img', ...rect
    });
  }
  for (const video of Array.from(document.querySelectorAll('video'))) {
    const rect = box(video);
    const src = video.currentSrc || video.src || video.querySelector('source')?.src;
    if (src) result.push({ kind: 'video', url: absolute(src), title: video.title || undefined, selector: selector(video), tag: 'video', ...rect });
    if (video.poster) result.push({ kind: 'video-poster', url: absolute(video.poster), selector: selector(video), tag: 'video', ...rect });
  }
  for (const element of Array.from(document.querySelectorAll('*')).slice(0, 15000)) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const background = getComputedStyle(element).backgroundImage;
    if (!background || background === 'none') continue;
    const matches = [...background.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)];
    for (const match of matches) {
      result.push({ kind: 'background-image', url: absolute(match[1]), selector: selector(element), tag: element.tagName.toLowerCase(), width: Math.round(rect.width), height: Math.round(rect.height) });
    }
  }
  for (const svg of Array.from(document.querySelectorAll('svg')).slice(0, 500)) {
    const rect = box(svg);
    if (rect.width <= 0 || rect.height <= 0) continue;
    result.push({ kind: 'inline-svg', title: svg.querySelector('title')?.textContent?.trim() || svg.getAttribute('aria-label') || undefined, selector: selector(svg), tag: 'svg', ...rect });
  }
  return result.slice(0, 2500);
})()`;

const LAYOUT_INVENTORY_EXPRESSION = `(() => {
  const cssPath = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      if (current.id) { part += '#' + CSS.escape(current.id); parts.unshift(part); break; }
      const classNames = Array.from(current.classList || []).filter(name => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)).slice(0, 2);
      if (classNames.length) part += classNames.map(name => '.' + CSS.escape(name)).join('');
      if (current.parentElement) {
        const same = Array.from(current.parentElement.children).filter(node => node.tagName === current.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (element, style, rect) => rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  const structural = new Set(['header','footer','main','section','article','nav','aside','h1','h2','h3','h4','h5','h6']);
  const blockDisplays = new Set(['block','flex','grid','flow-root','table','list-item']);
  const nodes = [];
  const all = Array.from(document.body.querySelectorAll('*')).slice(0, 18000);
  for (const element of all) {
    const tag = element.tagName.toLowerCase();
    if (['script','style','link','meta','noscript','template'].includes(tag)) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!visible(element, style, rect)) continue;
    const isStructural = structural.has(tag) || element.hasAttribute('data-section') || element.hasAttribute('data-section-id') || element.getAttribute('role') === 'region';
    const isBlockCandidate = blockDisplays.has(style.display) && rect.width >= Math.min(240, innerWidth * 0.22) && rect.height >= 24;
    if (!isStructural && !isBlockCandidate) continue;
    const heading = /^h[1-6]$/.test(tag) ? element : element.querySelector('h1,h2,h3,h4,h5,h6');
    const headingStyle = heading ? getComputedStyle(heading) : undefined;
    const descendants = Array.from(element.querySelectorAll('*')).slice(0, 900);
    const descendantTags = {};
    for (const child of descendants) {
      const childTag = child.tagName.toLowerCase();
      descendantTags[childTag] = (descendantTags[childTag] || 0) + 1;
    }
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    nodes.push({
      selector: cssPath(element),
      tag,
      heading: heading ? String(heading.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) : undefined,
      content: {
        textLength: Math.min(text.length, 100000),
        headings: element.querySelectorAll('h1,h2,h3,h4,h5,h6').length + (/^h[1-6]$/.test(tag) ? 1 : 0),
        links: element.querySelectorAll('a[href]').length,
        buttons: element.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]').length,
        images: element.querySelectorAll('img,svg,picture').length,
        videos: element.querySelectorAll('video').length,
        forms: element.querySelectorAll('form').length,
        lists: element.querySelectorAll('ul,ol').length
      },
      structure: {
        directChildren: element.children.length,
        directChildTags: Array.from(element.children).slice(0, 24).map(node => node.tagName.toLowerCase()),
        descendantTags
      },
      style: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        gap: style.gap,
        gridTemplateColumns: style.gridTemplateColumns,
        flexDirection: style.flexDirection,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent
      },
      headingStyle: headingStyle ? {
        fontFamily: headingStyle.fontFamily,
        fontSize: headingStyle.fontSize,
        fontWeight: headingStyle.fontWeight,
        lineHeight: headingStyle.lineHeight,
        letterSpacing: headingStyle.letterSpacing,
        textTransform: headingStyle.textTransform
      } : undefined,
      box: {
        x: Math.max(0, Math.round(rect.left + scrollX)),
        y: Math.max(0, Math.round(rect.top + scrollY)),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
    if (nodes.length >= 5000) break;
  }
  return nodes;
})()`;

const SECTION_REGION_EXPRESSION = `(() => {
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 24 && rect.height >= 18 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
  };
  const selectorFor = (element) => {
    if (element.id) {
      const byId = '#' + CSS.escape(element.id);
      try { if (document.querySelectorAll(byId).length === 1) return byId; } catch {}
    }
    const parts = [];
    let node = element;
    while (node && node !== document.documentElement && parts.length < 9) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const test = parts.join(' > ');
      try { if (document.querySelectorAll(test).length === 1) return test; } catch {}
      node = parent;
    }
    return parts.join(' > ');
  };
  const result = [];
  for (const element of Array.from(document.querySelectorAll('div,section,header,footer,main,article,nav')).slice(0, 15000)) {
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    result.push({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      style: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        gap: style.gap,
        gridTemplateColumns: style.gridTemplateColumns,
        flexDirection: style.flexDirection,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent
      },
      box: {
        x: Math.round((rect.left + scrollX) * 1000) / 1000,
        y: Math.round((rect.top + scrollY) * 1000) / 1000,
        width: Math.round(rect.width * 1000) / 1000,
        height: Math.round(rect.height * 1000) / 1000
      }
    });
  }
  return result;
})()`;

function jsonForPageExpression(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildManualRegionExpression(targets: ManualRootTarget[]): string {
  return `(() => {
  const TARGETS = ${jsonForPageExpression(targets)};
  const clean = (value, max) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max || 500);
  const fnv = (value) => { let h = 2166136261; for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); };
  const classes = (element) => Array.from(element.classList || []).filter(Boolean).slice(0, 20);
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 24 && rect.height >= 18 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
  };
  const selectorFor = (element) => {
    if (element.id) {
      const byId = '#' + CSS.escape(element.id);
      try { if (document.querySelectorAll(byId).length === 1) return byId; } catch {}
    }
    const parts = [];
    let node = element;
    while (node && node !== document.documentElement && parts.length < 9) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const test = parts.join(' > ');
      try { if (document.querySelectorAll(test).length === 1) return test; } catch {}
      node = parent;
    }
    return parts.join(' > ');
  };
  const headingOf = (element) => {
    const heading = element.matches('h1,h2,h3,h4,h5,h6') ? element : element.querySelector('h1,h2,h3,h4,h5,h6');
    return heading ? clean(heading.textContent, 500) : '';
  };
  const structureOf = (element) => {
    const descendantTags = {};
    for (const node of Array.from(element.querySelectorAll('*')).slice(0, 1200)) {
      const tag = node.tagName.toLowerCase();
      descendantTags[tag] = (descendantTags[tag] || 0) + 1;
    }
    return {
      directChildren: element.children.length,
      directChildTags: Array.from(element.children).slice(0, 24).map(node => node.tagName.toLowerCase()),
      descendantTags
    };
  };
  const ancestryOf = (element) => {
    const ancestry = [];
    let parent = element.parentElement;
    while (parent && parent !== document.documentElement && ancestry.length < 6) {
      ancestry.push({ tag: parent.tagName.toLowerCase(), id: parent.id || undefined, classes: classes(parent).slice(0, 12) });
      parent = parent.parentElement;
    }
    return ancestry;
  };
  const fingerprintOf = (element) => {
    const structure = structureOf(element);
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      classes: classes(element),
      heading: headingOf(element) || undefined,
      textHash: fnv(clean(element.innerText, 5000)),
      structureHash: fnv(JSON.stringify(structure)),
      ancestry: ancestryOf(element)
    };
  };
  const jaccard = (left, right) => {
    const a = new Set(Array.isArray(left) ? left : []);
    const b = new Set(Array.isArray(right) ? right : []);
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const value of a) if (b.has(value)) intersection += 1;
    return intersection / Math.max(1, new Set([...a, ...b]).size);
  };
  const ancestrySimilarity = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) return 0;
    const length = Math.min(left.length, right.length, 6);
    let score = 0;
    for (let index = 0; index < length; index += 1) {
      const a = left[index] || {};
      const b = right[index] || {};
      let item = a.tag && b.tag && a.tag === b.tag ? 0.5 : 0;
      if (a.id && b.id && a.id === b.id) item += 0.35;
      item += 0.15 * jaccard(a.classes, b.classes);
      score += Math.min(1, item);
    }
    return score / length;
  };
  const scoreFingerprint = (target, element) => {
    const expected = target.fingerprint || {};
    const actual = fingerprintOf(element);
    if (expected.tag && actual.tag !== expected.tag) return 0;
    let score = 0.12;
    let weight = 0.12;
    if (expected.id) { weight += 0.35; if (actual.id === expected.id) score += 0.35; }
    if (Array.isArray(expected.classes) && expected.classes.length > 0) { weight += 0.15; score += 0.15 * jaccard(expected.classes, actual.classes); }
    if (expected.heading) { weight += 0.13; if (clean(actual.heading, 500).toLowerCase() === clean(expected.heading, 500).toLowerCase()) score += 0.13; }
    if (expected.textHash) { weight += 0.15; if (actual.textHash === expected.textHash) score += 0.15; }
    if (expected.structureHash) { weight += 0.12; if (actual.structureHash === expected.structureHash) score += 0.12; }
    if (Array.isArray(expected.ancestry) && expected.ancestry.length > 0) { weight += 0.13; score += 0.13 * ancestrySimilarity(expected.ancestry, actual.ancestry); }
    return Math.max(0, Math.min(1, score / Math.max(0.12, weight)));
  };
  const evidenceOf = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const heading = element.matches('h1,h2,h3,h4,h5,h6') ? element : element.querySelector('h1,h2,h3,h4,h5,h6');
    const headingStyle = heading ? getComputedStyle(heading) : undefined;
    const structure = structureOf(element);
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      heading: heading ? clean(heading.textContent, 500) : undefined,
      content: {
        textLength: clean(element.innerText, 12000).length,
        headings: element.querySelectorAll('h1,h2,h3,h4,h5,h6').length + (element.matches('h1,h2,h3,h4,h5,h6') ? 1 : 0),
        links: element.querySelectorAll('a[href]').length,
        buttons: element.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]').length,
        images: element.querySelectorAll('img,picture,svg').length,
        videos: element.querySelectorAll('video').length,
        forms: element.querySelectorAll('form').length,
        lists: element.querySelectorAll('ul,ol').length
      },
      structure,
      style: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        gap: style.gap,
        gridTemplateColumns: style.gridTemplateColumns,
        flexDirection: style.flexDirection,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent
      },
      headingStyle: headingStyle ? {
        fontFamily: headingStyle.fontFamily,
        fontSize: headingStyle.fontSize,
        fontWeight: headingStyle.fontWeight,
        lineHeight: headingStyle.lineHeight,
        letterSpacing: headingStyle.letterSpacing,
        textTransform: headingStyle.textTransform
      } : undefined,
      box: {
        x: Math.round((rect.left + scrollX) * 1000) / 1000,
        y: Math.round((rect.top + scrollY) * 1000) / 1000,
        width: Math.round(rect.width * 1000) / 1000,
        height: Math.round(rect.height * 1000) / 1000
      }
    };
  };
  const all = Array.from(document.querySelectorAll('div,section,header,footer,main,article,nav')).filter(visible).slice(0, 15000);
  const used = new Set();
  const matched = [];
  for (const target of TARGETS) {
    let element;
    let method = 'selector';
    let score = 1;
    try {
      const exact = document.querySelector(target.selector);
      if (exact && visible(exact) && !used.has(exact)) element = exact;
    } catch {}
    if (!element && target.fingerprint) {
      method = 'fingerprint';
      score = 0;
      for (const candidate of all) {
        if (used.has(candidate)) continue;
        const next = scoreFingerprint(target, candidate);
        if (next > score) { score = next; element = candidate; }
      }
      if (score < 0.62) element = undefined;
    }
    if (!element) continue;
    used.add(element);
    matched.push({ target, element, method, score });
  }
  const commonAncestor = (elements) => {
    if (elements.length === 0) return undefined;
    if (elements.length === 1) return elements[0];
    let candidate = elements[0];
    while (candidate) {
      if (elements.every(element => candidate.contains(element))) return candidate;
      candidate = candidate.parentElement;
    }
    return undefined;
  };
  const unionBox = (items) => {
    const left = Math.min(...items.map(item => item.box.x));
    const top = Math.min(...items.map(item => item.box.y));
    const right = Math.max(...items.map(item => item.box.x + item.box.width));
    const bottom = Math.max(...items.map(item => item.box.y + item.box.height));
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const pixel = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(String(value || '').trim());
    return match ? Number(match[1]) : undefined;
  };
  const boundaryScore = (boundary, roots, depth) => {
    const union = unionBox(roots);
    const area = Math.max(1, boundary.box.width * boundary.box.height);
    const unionArea = Math.max(0, union.width * union.height);
    const fit = Math.sqrt(Math.min(1, unionArea / area));
    const top = pixel(boundary.style && boundary.style.paddingTop);
    const bottom = pixel(boundary.style && boundary.style.paddingBottom);
    const topSignal = typeof top === 'number' && top >= 24;
    const bottomSignal = typeof bottom === 'number' && bottom >= 24;
    const paddingSignal = topSignal && bottomSignal
      ? Math.abs(top - bottom) <= 1 ? 1 : 0.65
      : topSignal || bottomSignal ? 0.3 : 0;
    const semanticBoost = boundary.tag === 'section' ? 0.08 : boundary.tag === 'article' ? 0.05 : boundary.tag === 'main' ? 0.02 : 0;
    const score = Math.max(0, Math.min(1, 0.62 * fit + 0.33 * paddingSignal + semanticBoost - Math.min(0.12, depth * 0.03)));
    return Math.round(score * 1000) / 1000;
  };
  const resolveBoundary = (elements) => {
    const common = commonAncestor(elements);
    if (!common || !(common instanceof Element)) return undefined;
    const roots = elements.map(element => evidenceOf(element));
    const candidates = [];
    let element = common;
    let depth = 0;
    while (element && element !== document.documentElement && depth < 6) {
      const boundary = evidenceOf(element);
      candidates.push({ boundary, confidence: boundaryScore(boundary, roots, depth), depth });
      if (element === document.body) break;
      element = element.parentElement;
      depth += 1;
    }
    candidates.sort((left, right) => right.confidence - left.confidence || left.depth - right.depth);
    return candidates[0];
  };
  const boundaries = new Map();
  for (const segmentId of new Set(matched.map(entry => entry.target.segmentId))) {
    const group = matched.filter(entry => entry.target.segmentId === segmentId);
    const expected = TARGETS.filter(target => target.segmentId === segmentId).length;
    if (group.length !== expected || group.length === 0) continue;
    const resolved = resolveBoundary(group.map(entry => entry.element));
    if (resolved) boundaries.set(segmentId, resolved);
  }
  return matched.map(entry => {
    const item = evidenceOf(entry.element);
    const resolvedBoundary = boundaries.get(entry.target.segmentId);
    return {
      targetId: entry.target.targetId,
      segmentId: entry.target.segmentId,
      rootIndex: entry.target.rootIndex,
      sourceSelector: entry.target.selector,
      matchedSelector: item.selector,
      matchMethod: entry.method,
      score: Math.round(entry.score * 1000) / 1000,
      item,
      ...(resolvedBoundary ? { boundary: resolvedBoundary.boundary, boundaryConfidence: resolvedBoundary.confidence } : {})
    };
  });
})()`;
}

const SECTION_INVENTORY_EXPRESSION = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= innerWidth * 0.45 && rect.height >= 80 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const cssPath = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) { part += '#' + CSS.escape(current.id); parts.unshift(part); break; }
      if (current.parentElement) {
        const same = Array.from(current.parentElement.children).filter(node => node.tagName === current.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const candidates = [];
  const push = (element) => {
    if (!element || candidates.includes(element) || !visible(element)) return;
    candidates.push(element);
  };
  for (const element of document.querySelectorAll('header, footer, main > section, main > article, main > [role="region"], body > section, body > [role="region"], [data-section], [data-section-id]')) push(element);
  if (candidates.length < 4) {
    const root = document.querySelector('main') || document.body;
    for (const child of root.children) {
      const rect = child.getBoundingClientRect();
      if (rect.height >= 160 && rect.width >= innerWidth * 0.55) push(child);
    }
  }
  candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const filtered = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) => otherIndex !== index && other.contains(candidate) && ['HEADER','FOOTER'].includes(other.tagName)));
  return filtered.slice(0, 80).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const heading = element.querySelector('h1,h2,h3');
    const aria = element.getAttribute('aria-label');
    const dataName = element.getAttribute('data-section') || element.getAttribute('data-section-id');
    const rawLabel = dataName || aria || heading?.textContent || element.id || element.tagName.toLowerCase();
    const label = String(rawLabel || 'section').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const auditId = 'section-' + String(index + 1).padStart(2, '0');
    const style = getComputedStyle(element);
    const background = style.backgroundColor;
    const headingStyle = heading ? getComputedStyle(heading) : undefined;
    const descendants = Array.from(element.querySelectorAll('*')).slice(0, 2000);
    const descendantTags = {};
    for (const node of descendants) {
      const tag = node.tagName.toLowerCase();
      descendantTags[tag] = (descendantTags[tag] || 0) + 1;
    }
    const text = String(element.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      auditId,
      label,
      tag: element.tagName.toLowerCase(),
      selector: cssPath(element),
      heading: heading ? String(heading.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : undefined,
      background,
      content: {
        textLength: Math.min(text.length, 100000),
        headings: element.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        links: element.querySelectorAll('a[href]').length,
        buttons: element.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]').length,
        images: element.querySelectorAll('img,svg,picture').length,
        videos: element.querySelectorAll('video').length,
        forms: element.querySelectorAll('form').length,
        lists: element.querySelectorAll('ul,ol').length
      },
      structure: {
        directChildren: element.children.length,
        directChildTags: Array.from(element.children).slice(0, 24).map(node => node.tagName.toLowerCase()),
        descendantTags
      },
      style: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        gap: style.gap,
        gridTemplateColumns: style.gridTemplateColumns,
        flexDirection: style.flexDirection,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent
      },
      headingStyle: headingStyle ? {
        fontFamily: headingStyle.fontFamily,
        fontSize: headingStyle.fontSize,
        fontWeight: headingStyle.fontWeight,
        lineHeight: headingStyle.lineHeight,
        letterSpacing: headingStyle.letterSpacing,
        textTransform: headingStyle.textTransform
      } : undefined,
      box: {
        x: Math.max(0, Math.round(rect.left + scrollX)),
        y: Math.max(0, Math.round(rect.top + scrollY)),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  });
})()`;

export function buildLeafUiInventoryExpression(manualRegions: ManualViewportRegion[] = []): string {
  const segmentTargets = manualRegions.map(item => ({ segmentId: item.segmentId, selector: item.matchedSelector })).filter(item => item.segmentId && item.selector);
  return `(() => {
  const segmentTargets = ${JSON.stringify(segmentTargets)};
  const text = (node) => String(node?.textContent || '').replace(/\\s+/g, ' ').trim();
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
  };
  const cssPath = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      if (current.id) { part += '#' + CSS.escape(current.id); parts.unshift(part); break; }
      const stableClasses = Array.from(current.classList || []).filter(value => value && value.length <= 48 && !/^css-/.test(value)).slice(0, 2);
      if (stableClasses.length) part += '.' + stableClasses.map(value => CSS.escape(value)).join('.');
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(node => node.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const px = (value) => { const parsed = Number.parseFloat(String(value || '0')); return Number.isFinite(parsed) ? parsed : 0; };
  const transparent = (value) => !value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || value === 'rgba(0,0,0,0)';
  const segmentNodes = segmentTargets.flatMap(target => {
    try {
      const node = document.querySelector(target.selector);
      if (!node) return [];
      const rect = node.getBoundingClientRect();
      return [{ segmentId: target.segmentId, node, area: Math.max(1, rect.width * rect.height) }];
    } catch { return []; }
  }).sort((a, b) => a.area - b.area);
  const segmentIdFor = (element) => segmentNodes.find(item => item.node === element || item.node.contains(element))?.segmentId;
  const common = (element, kind) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const value = text(element).slice(0, 160);
    return {
      kind,
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || undefined,
      type: element.getAttribute('type') || undefined,
      text: value || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      href: element instanceof HTMLAnchorElement ? element.href || undefined : undefined,
      name: 'name' in element ? element.name || undefined : undefined,
      placeholder: 'placeholder' in element ? element.placeholder || undefined : undefined,
      required: 'required' in element ? Boolean(element.required) : undefined,
      disabled: 'disabled' in element ? Boolean(element.disabled) : undefined,
      checked: 'checked' in element ? Boolean(element.checked) : undefined,
      segmentId: segmentIdFor(element),
      style: {
        display: style.display,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderTopColor: style.borderTopColor,
        borderRadius: style.borderRadius,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        gap: style.gap,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textDecorationLine: style.textDecorationLine,
        boxShadow: style.boxShadow
      },
      structure: {
        directChildren: element.children.length,
        icons: element.querySelectorAll('svg,[class*="icon" i],[data-icon]').length,
        images: element.querySelectorAll('img,picture').length
      },
      box: {
        x: Math.max(0, Math.round(rect.left + scrollX)),
        y: Math.max(0, Math.round(rect.top + scrollY)),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  };
  const observations = [];
  const seen = new Set();
  const push = (element, kind) => {
    if (!visible(element)) return;
    const selector = cssPath(element);
    const key = kind + '|' + selector;
    if (seen.has(key)) return;
    seen.add(key);
    observations.push(common(element, kind));
  };

  for (const element of Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]'))) push(element, 'button');
  for (const element of Array.from(document.querySelectorAll('a[href]'))) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const classText = String(element.className || '') + ' ' + String(element.id || '');
    const buttonLike = element.getAttribute('role') === 'button'
      || /(?:^|[-_\\s])(btn|button|cta)(?:$|[-_\\s])/i.test(classText)
      || ((px(style.paddingLeft) + px(style.paddingRight) >= 12) && (px(style.borderTopWidth) > 0 || !transparent(style.backgroundColor)) && px(style.borderRadius) >= 2);
    push(element, buttonLike ? 'button' : 'link');
  }
  for (const element of Array.from(document.querySelectorAll('input'))) {
    const type = String(element.type || 'text').toLowerCase();
    if (['button','submit','reset','hidden'].includes(type)) continue;
    if (type === 'checkbox' || type === 'radio') push(element, type);
    else push(element, 'input');
  }
  for (const element of Array.from(document.querySelectorAll('textarea'))) push(element, 'textarea');
  for (const element of Array.from(document.querySelectorAll('select'))) push(element, 'select');

  const passive = Array.from(document.querySelectorAll('span,small,label,div')).slice(0, 12000);
  for (const element of passive) {
    if (!visible(element) || element.matches('a,button,input,textarea,select') || element.querySelector('a,button,input,textarea,select')) continue;
    const rect = element.getBoundingClientRect();
    const value = text(element);
    if (!value || value.length > 48 || rect.height < 12 || rect.height > 44 || rect.width > 260) continue;
    const style = getComputedStyle(element);
    const classText = String(element.className || '') + ' ' + String(element.id || '');
    const semanticHint = /(?:^|[-_\\s])(badge|pill|chip|tag)(?:$|[-_\\s])/i.test(classText) || element.hasAttribute('data-badge');
    const visualHint = (px(style.borderRadius) >= Math.min(8, rect.height * 0.25)) && (px(style.borderTopWidth) > 0 || !transparent(style.backgroundColor));
    if (semanticHint || visualHint) push(element, 'badge-candidate');
  }

  const containers = Array.from(document.querySelectorAll('article,li,div')).slice(0, 15000);
  for (const element of containers) {
    if (!visible(element) || element.children.length < 2) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 140 || rect.height < 72 || rect.width > innerWidth * 0.98) continue;
    const style = getComputedStyle(element);
    const classText = String(element.className || '') + ' ' + String(element.id || '');
    const semanticHint = element.tagName === 'ARTICLE' || /(?:^|[-_\\s])(card|tile|panel)(?:$|[-_\\s])/i.test(classText) || element.hasAttribute('data-card');
    const visualHint = px(style.borderTopWidth) > 0 || px(style.borderRadius) >= 6 || (style.boxShadow && style.boxShadow !== 'none');
    const contentHint = Boolean(element.querySelector('h2,h3,h4,h5,h6,img,picture,svg'));
    if ((semanticHint && contentHint) || (visualHint && contentHint && element.children.length <= 16)) push(element, 'card-candidate');
    if (observations.length >= 900) break;
  }

  return observations.slice(0, 900);
})()`;
}

const READY_EXPRESSION = `(async () => {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
  const waitForImages = () => Promise.all(Array.from(document.images).map(image => {
    if (image.complete) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => resolve();
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
      setTimeout(done, 2000);
    });
  }));
  await Promise.race([waitForImages(), new Promise(resolve => setTimeout(resolve, 2500))]);
  return true;
})()`;

function scrollExpression(settleMs: number): string {
  return `(async () => {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const step = Math.max(400, Math.floor(innerHeight * 0.8));
    const maximum = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < maximum; y += step) {
      scrollTo(0, y);
      await delay(70);
    }
    scrollTo(0, 0);
    await delay(${Math.max(0, settleMs)});
    return { width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) };
  })()`;
}

async function capturePng(client: CdpClient, clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const result = await client.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { ...clip, scale: 1 }
  });
  return Buffer.from(result.data, "base64");
}

async function navigate(client: CdpClient, sourceUrl: string, viewport: AuditViewport, timeoutMs: number, settleMs: number): Promise<{ finalUrl: string; status?: number; userAgent: string }> {
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height
  });
  await client.send("Emulation.setTouchEmulationEnabled", viewport.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });

  const currentUserAgent = await evaluate<string>(client, "navigator.userAgent");
  const userAgent = currentUserAgent.replace(/HeadlessChrome\//g, "Chrome/");
  if (userAgent !== currentUserAgent) await client.send("Emulation.setUserAgentOverride", { userAgent });

  const loadPromise = client.waitForEvent("Page.loadEventFired", timeoutMs);
  const documentResponse = client.waitForEvent<{ type?: string; response?: { status?: number; url?: string } }>(
    "Network.responseReceived",
    timeoutMs,
    params => params.type === "Document"
  ).catch(() => undefined);
  const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: sourceUrl });
  if (navigation.errorText) throw new MigrateAuditError("MIGRATE_NAVIGATION_FAILED", navigation.errorText, { url: sourceUrl });
  await loadPromise;
  const response = await documentResponse;
  await evaluate(client, READY_EXPRESSION, true);
  await evaluate(client, scrollExpression(settleMs), true);
  await evaluate(client, READY_EXPRESSION, true);
  const finalUrl = await evaluate<string>(client, "location.href");
  return { finalUrl, status: response?.response?.status, userAgent };
}

function sanitizeSectionName(label: string): string {
  return slug(label).replace(/\.+/g, "-").slice(0, 56) || "section";
}

async function captureViewport(
  browser: LaunchedChrome,
  sourceUrl: string,
  viewport: AuditViewport,
  output: string,
  timeoutMs: number,
  settleMs: number,
  manualTargets: ManualRootTarget[] = []
): Promise<PageCapture> {
  const client = await createPageClient(browser.port, timeoutMs);
  try {
    const navigation = await navigate(client, sourceUrl, viewport, timeoutMs, settleMs);
    const page = await evaluate<Record<string, unknown>>(client, PAGE_METADATA_EXPRESSION);
    page.status = navigation.status;
    page.finalUrl = navigation.finalUrl;
    page.viewport = viewport;

    const design = await evaluate<AuditDesignInventory>(client, DESIGN_INVENTORY_EXPRESSION);
    const media = await evaluate<PageCapture["media"]>(client, MEDIA_INVENTORY_EXPRESSION);
    const layout = viewport.name === "desktop"
      ? await evaluate<PageCapture["layout"]>(client, LAYOUT_INVENTORY_EXPRESSION)
      : [];
    const sections = await evaluate<PageCapture["sections"]>(client, SECTION_INVENTORY_EXPRESSION);
    const regions = await evaluate<PageCapture["regions"]>(client, SECTION_REGION_EXPRESSION);
    const manualRegions = manualTargets.length > 0
      ? await evaluate<PageCapture["manualRegions"]>(client, buildManualRegionExpression(manualTargets))
      : [];
    const ui = await evaluate<PageCapture["ui"]>(client, buildLeafUiInventoryExpression(manualRegions));
    const dom = await evaluate<string>(client, "document.documentElement.outerHTML");

    const metrics = await client.send<{ cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }>("Page.getLayoutMetrics");
    const content = metrics.cssContentSize ?? metrics.contentSize ?? { width: viewport.width, height: viewport.height };
    const fullClip = {
      x: 0,
      y: 0,
      width: Math.max(viewport.width, Math.ceil(content.width)),
      height: Math.max(viewport.height, Math.ceil(content.height))
    };
    const screenshotRelative = `screenshots/${viewport.name}.png`;
    await writeFile(join(output, screenshotRelative), await capturePng(client, fullClip));

    const sectionScreenshots: Array<{ auditId: string; file: string }> = [];
    if (viewport.name === "desktop") {
      let index = 0;
      for (const section of sections) {
        index += 1;
        const { box } = section;
        if (box.width <= 0 || box.height <= 0) continue;
        const clip = {
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          width: Math.max(1, Math.min(box.width, fullClip.width - Math.max(0, box.x))),
          height: Math.max(1, Math.min(box.height, fullClip.height - Math.max(0, box.y)))
        };
        if (clip.width <= 1 || clip.height <= 1) continue;
        const file = `sections/${String(index).padStart(2, "0")}-${sanitizeSectionName(section.label)}.png`;
        try {
          await writeFile(join(output, file), await capturePng(client, clip));
          sectionScreenshots.push({ auditId: section.auditId, file });
        } catch {
          // A section can be too large for the browser screenshot surface; metadata still remains useful.
        }
      }
    }

    return {
      viewport,
      finalUrl: navigation.finalUrl,
      userAgent: navigation.userAgent,
      page,
      dom,
      design,
      media,
      layout,
      sections,
      regions,
      manualRegions,
      ui,
      screenshot: screenshotRelative,
      sectionScreenshots
    };
  } finally {
    client.close();
  }
}

function mergeInventoryItems(viewports: Record<string, AuditDesignInventory>, category: keyof Omit<AuditDesignInventory, "elements">): { totalDistinct: number; items: AuditInventoryItem[] } {
  const merged = new Map<string, AuditInventoryItem>();
  for (const [viewport, inventory] of Object.entries(viewports)) {
    for (const item of inventory[category].items) {
      const current = merged.get(item.key) ?? { ...item, count: 0, properties: {}, viewports: {} };
      current.count += item.count;
      current.viewports ??= {};
      current.viewports[viewport] = (current.viewports[viewport] ?? 0) + item.count;
      if (item.properties) {
        current.properties ??= {};
        for (const [property, count] of Object.entries(item.properties)) current.properties[property] = (current.properties[property] ?? 0) + count;
      }
      if (!current.style && item.style) current.style = item.style;
      merged.set(item.key, current);
    }
  }
  const items = [...merged.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { totalDistinct: merged.size, items };
}

export function aggregateDesignInventories(viewports: Record<string, AuditDesignInventory>): AuditDesignInventory {
  const values = Object.values(viewports);
  return {
    elements: {
      total: Math.max(0, ...values.map(item => item.elements.total)),
      visible: Math.max(0, ...values.map(item => item.elements.visible)),
      textBearing: Math.max(0, ...values.map(item => item.elements.textBearing))
    },
    colors: mergeInventoryItems(viewports, "colors"),
    typography: mergeInventoryItems(viewports, "typography"),
    radii: mergeInventoryItems(viewports, "radii"),
    shadows: mergeInventoryItems(viewports, "shadows"),
    spacing: mergeInventoryItems(viewports, "spacing"),
    containerWidths: mergeInventoryItems(viewports, "containerWidths")
  };
}

export function mergeMediaInventories(sourceUrl: string, captures: Array<{ viewport: string; items: AuditMediaObservation[] }>): AuditMediaItem[] {
  const sourceOrigin = safeUrl(sourceUrl).origin;
  const merged = new Map<string, AuditMediaItem>();
  for (const capture of captures) {
    for (const item of capture.items) {
      const key = item.url ? `${item.kind}:${item.url}` : `${item.kind}:${item.selector}:${item.title ?? ""}`;
      const current = merged.get(key) ?? {
        kind: item.kind,
        url: item.url,
        alt: item.alt,
        title: item.title,
        naturalWidth: item.naturalWidth,
        naturalHeight: item.naturalHeight,
        srcset: item.srcset,
        sizes: item.sizes,
        loading: item.loading,
        fetchPriority: item.fetchPriority,
        viewports: [],
        usages: []
      };
      if (!current.viewports.includes(capture.viewport)) current.viewports.push(capture.viewport);
      if (current.usages.length < 100) current.usages.push({
        viewport: capture.viewport,
        selector: item.selector,
        tag: item.tag,
        width: item.width,
        height: item.height
      });
      if (item.url) {
        try {
          const parsed = new URL(item.url);
          current.external = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin !== sourceOrigin : false;
        } catch { /* unresolved URL remains unclassified */ }
      }
      merged.set(key, current);
    }
  }
  return [...merged.values()]
    .sort((a, b) => `${a.kind}:${a.url ?? a.usages[0]?.selector ?? ""}`.localeCompare(`${b.kind}:${b.url ?? b.usages[0]?.selector ?? ""}`));
}


async function readPreservedManualSegments(output: string, sourceUrl: string): Promise<{ raw: string; count: number; targets: ManualRootTarget[] } | undefined> {
  try {
    const raw = await readFile(join(output, "segments.json"), "utf8");
    const parsed = JSON.parse(raw) as { type?: string; status?: string; sourceUrl?: string; segments?: unknown[] };
    if (parsed.type !== "sitespec-migrate-segments" || parsed.status !== "complete" || parsed.sourceUrl !== sourceUrl || !Array.isArray(parsed.segments)) return undefined;
    const targets: ManualRootTarget[] = [];
    for (let segmentIndex = 0; segmentIndex < parsed.segments.length; segmentIndex += 1) {
      const segment = parsed.segments[segmentIndex];
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) continue;
      const value = segment as Record<string, unknown>;
      const segmentId = typeof value.id === "string" && value.id ? value.id : `segment-${String(segmentIndex + 1).padStart(2, "0")}`;
      const roots = Array.isArray(value.roots) && value.roots.length > 0 ? value.roots : [value];
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        const root = roots[rootIndex];
        if (!root || typeof root !== "object" || Array.isArray(root)) continue;
        const record = root as Record<string, unknown>;
        const evidence = record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence)
          ? record.evidence as Record<string, unknown>
          : undefined;
        const selector = typeof record.selector === "string" && record.selector
          ? record.selector
          : typeof evidence?.selector === "string" && evidence.selector
            ? evidence.selector
            : undefined;
        if (!selector) continue;
        const fingerprintRaw = record.fingerprint && typeof record.fingerprint === "object" && !Array.isArray(record.fingerprint)
          ? record.fingerprint as Record<string, unknown>
          : undefined;
        const ancestry = Array.isArray(fingerprintRaw?.ancestry)
          ? fingerprintRaw.ancestry.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 6).map(item => {
            const ancestor = item as Record<string, unknown>;
            return {
              tag: typeof ancestor.tag === "string" ? ancestor.tag : undefined,
              id: typeof ancestor.id === "string" ? ancestor.id : undefined,
              classes: Array.isArray(ancestor.classes) ? ancestor.classes.filter((entry): entry is string => typeof entry === "string").slice(0, 12) : undefined
            };
          })
          : undefined;
        const fingerprint: ManualRootFingerprint | undefined = fingerprintRaw ? {
          tag: typeof fingerprintRaw.tag === "string" ? fingerprintRaw.tag : typeof record.tag === "string" ? record.tag : undefined,
          id: typeof fingerprintRaw.id === "string" ? fingerprintRaw.id : undefined,
          classes: Array.isArray(fingerprintRaw.classes) ? fingerprintRaw.classes.filter((entry): entry is string => typeof entry === "string").slice(0, 20) : undefined,
          heading: typeof fingerprintRaw.heading === "string" ? fingerprintRaw.heading : undefined,
          textHash: typeof fingerprintRaw.textHash === "string" ? fingerprintRaw.textHash : undefined,
          structureHash: typeof fingerprintRaw.structureHash === "string" ? fingerprintRaw.structureHash : undefined,
          ancestry
        } : undefined;
        targets.push({
          targetId: `${segmentId}:root-${rootIndex + 1}`,
          segmentId,
          rootIndex,
          selector,
          tag: typeof record.tag === "string" ? record.tag : typeof evidence?.tag === "string" ? evidence.tag : undefined,
          fingerprint
        });
      }
    }
    return { raw, count: parsed.segments.length, targets };
  } catch {
    return undefined;
  }
}

export async function prepareAuditOutputDirectory(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length === 0) return;
    try {
      const previous = JSON.parse(await readFile(join(output, "audit.json"), "utf8")) as { type?: string };
      if (previous.type === "sitespec-migrate-audit") {
        await rm(output, { recursive: true, force: true });
        return;
      }
    } catch {
      // A non-audit directory is never removed implicitly.
    }
    throw new MigrateAuditError(
      "MIGRATE_OUTPUT_NOT_EMPTY",
      `Audit output directory is not empty and is not owned by a previous migrate audit: ${output}`,
      { output }
    );
  } catch (error) {
    if (error instanceof MigrateAuditError) throw error;
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") throw error;
  }
}

export async function auditUrl(options: MigrateAuditOptions): Promise<MigrateAuditResult> {
  const source = safeUrl(options.url).href;
  const root = resolve(options.root ?? ".");
  const output = resolveAuditOutputDirectory(root, source, options.output);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 600;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new MigrateAuditError("MIGRATE_TIMEOUT_INVALID", "--timeout must be an integer between 1000 and 300000 milliseconds.");
  }
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 30_000) {
    throw new MigrateAuditError("MIGRATE_SETTLE_INVALID", "--settle must be an integer between 0 and 30000 milliseconds.");
  }
  const viewportNames = options.viewports ?? ["desktop", "tablet", "mobile"];
  const viewports = viewportNames.map(name => AUDIT_VIEWPORTS[name]);
  if (viewports.some(value => !value)) throw new MigrateAuditError("MIGRATE_VIEWPORT_UNKNOWN", "Unknown audit viewport.");

  const preservedSegments = await readPreservedManualSegments(output, source);
  await prepareAuditOutputDirectory(output);
  await mkdir(join(output, "screenshots"), { recursive: true });
  await mkdir(join(output, "sections"), { recursive: true });
  await writeFile(join(output, "audit.json"), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-audit",
    status: "capturing",
    sourceUrl: source,
    output: "."
  }, null, 2)}\n`, "utf8");
  if (preservedSegments) await writeFile(join(output, "segments.json"), preservedSegments.raw, "utf8");

  const executable = await findAuditBrowser(options.browserPath);
  const browser = await launchChrome(executable, timeoutMs);
  try {
    const captures: PageCapture[] = [];
    for (const viewport of viewports) captures.push(await captureViewport(browser, source, viewport, output, timeoutMs, settleMs, preservedSegments?.targets ?? []));
    const desktop = captures.find(item => item.viewport.name === "desktop") ?? captures[0];
    if (!desktop) throw new MigrateAuditError("MIGRATE_CAPTURE_EMPTY", "No viewport captures were produced.");

    const perViewportDesign = Object.fromEntries(captures.map(item => [item.viewport.name, item.design]));
    const aggregate = aggregateDesignInventories(perViewportDesign);
    const mediaItems = mergeMediaInventories(source, captures.map(item => ({ viewport: item.viewport.name, items: item.media })));
    const sectionScreenshotMap = new Map(desktop.sectionScreenshots.map(item => [item.auditId, item.file]));
    const sections = desktop.sections.map(section => ({ ...section, screenshot: sectionScreenshotMap.get(section.auditId) }));
    const perViewportSections = Object.fromEntries(captures.map(item => [item.viewport.name, { viewport: item.viewport, count: item.sections.length, items: item.sections }]));
    const perViewportRegions = Object.fromEntries(captures.map(item => [item.viewport.name, { viewport: item.viewport, count: item.regions.length, items: item.regions }]));
    const perViewportManualRegions = Object.fromEntries(captures.map(item => [item.viewport.name, { viewport: item.viewport, count: item.manualRegions.length, items: item.manualRegions }]));
    const perViewportUi = Object.fromEntries(captures.map(item => [item.viewport.name, { viewport: item.viewport, count: item.ui.length, items: item.ui }]));

    const pageFile = join(output, "page.json");
    const domFile = join(output, "dom.html");
    const designFile = join(output, "design-inventory.json");
    const mediaFile = join(output, "media.json");
    const sectionsFile = join(output, "sections.json");
    const uiFile = join(output, "ui-inventory.json");
    const layoutFile = join(output, "layout.json");
    const auditFile = join(output, "audit.json");

    await writeFile(pageFile, `${JSON.stringify({
      version: "0.1",
      sourceUrl: source,
      finalUrl: desktop.finalUrl,
      capturedAt: new Date().toISOString(),
      ...desktop.page,
      viewportCaptures: captures.map(item => ({ viewport: item.viewport, finalUrl: item.finalUrl, screenshot: item.screenshot }))
    }, null, 2)}\n`, "utf8");
    await writeFile(domFile, desktop.dom, "utf8");
    await writeFile(designFile, `${JSON.stringify({ version: "0.1", sourceUrl: source, aggregate, viewports: perViewportDesign }, null, 2)}\n`, "utf8");
    await writeFile(mediaFile, `${JSON.stringify({
      version: "0.1",
      sourceUrl: source,
      count: mediaItems.length,
      byKind: Object.fromEntries([...new Set(mediaItems.map(item => item.kind))].sort().map(kind => [kind, mediaItems.filter(item => item.kind === kind).length])),
      items: mediaItems
    }, null, 2)}\n`, "utf8");
    await writeFile(sectionsFile, `${JSON.stringify({ version: "0.4", sourceUrl: source, viewport: desktop.viewport, count: sections.length, items: sections, viewports: perViewportSections, regions: perViewportRegions, manualRegions: perViewportManualRegions }, null, 2)}\n`, "utf8");
    const uiItems = captures.flatMap(capture => capture.ui.map(item => ({ viewport: capture.viewport.name, ...item })));
    await writeFile(uiFile, `${JSON.stringify({
      version: "0.1",
      type: "sitespec-migrate-audit-ui-inventory",
      sourceUrl: source,
      count: uiItems.length,
      byKind: Object.fromEntries([...new Set(uiItems.map(item => item.kind))].sort().map(kind => [kind, uiItems.filter(item => item.kind === kind).length])),
      linkedToManualSegments: uiItems.filter(item => item.segmentId).length,
      viewports: perViewportUi,
      items: uiItems
    }, null, 2)}\n`, "utf8");
    await writeFile(layoutFile, `${JSON.stringify({
      version: "0.1",
      type: "sitespec-migrate-audit-layout",
      sourceUrl: source,
      viewport: desktop.viewport,
      count: desktop.layout.length,
      items: desktop.layout
    }, null, 2)}\n`, "utf8");

    if (preservedSegments) await writeFile(join(output, "segments.json"), preservedSegments.raw, "utf8");

    const sectionScreenshotFiles = desktop.sectionScreenshots.map(item => item.file);
    const result: MigrateAuditResult = {
      sourceUrl: source,
      finalUrl: desktop.finalUrl,
      output,
      browser: { executable, userAgent: desktop.userAgent },
      viewports,
      files: {
        audit: "audit.json",
        page: "page.json",
        dom: "dom.html",
        designInventory: "design-inventory.json",
        media: "media.json",
        sections: "sections.json",
        ui: "ui-inventory.json",
        layout: "layout.json",
        screenshots: captures.map(item => item.screenshot),
        sectionScreenshots: sectionScreenshotFiles,
        ...(preservedSegments ? { segments: "segments.json" } : {})
      },
      summary: {
        sections: sections.length,
        sectionRegionNodes: captures.reduce((total, item) => total + item.regions.length, 0),
        ...(preservedSegments ? {
          manualRegionMatches: captures.reduce((total, item) => total + item.manualRegions.length, 0),
          manualBoundaryGroups: captures.reduce((total, item) => total + new Set(item.manualRegions.filter(match => match.boundary).map(match => match.segmentId)).size, 0)
        } : {}),
        media: mediaItems.length,
        uiElements: uiItems.length,
        layoutNodes: desktop.layout.length,
        visibleElements: aggregate.elements.visible,
        colors: aggregate.colors.totalDistinct,
        typography: aggregate.typography.totalDistinct,
        radii: aggregate.radii.totalDistinct,
        screenshots: captures.length
      }
    };

    await writeFile(auditFile, `${JSON.stringify({
      version: "0.1",
      type: "sitespec-migrate-audit",
      status: "complete",
      ...result,
      output: ".",
      browser: { ...result.browser, executable: basename(result.browser.executable) },
      ...(preservedSegments ? { summary: { ...result.summary, manualSegments: preservedSegments.count, manualDomSegments: preservedSegments.count } } : {})
    }, null, 2)}\n`, "utf8");
    return result;
  } catch (error) {
    if (error instanceof MigrateAuditError) throw error;
    throw new MigrateAuditError("MIGRATE_AUDIT_FAILED", error instanceof Error ? error.message : String(error), {
      browser: executable,
      browserStderr: browser.stderr().trim().slice(-4000)
    });
  } finally {
    await closeChrome(browser);
  }
}

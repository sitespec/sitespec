import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  closeChrome,
  createPageClient,
  evaluate,
  findAuditBrowser,
  launchChrome,
  type AuditLayoutNode,
  type CdpClient,
  type LaunchedChrome
} from "./migrate-audit.js";

export type SegmentRole = "section" | "header" | "footer" | "ignore";

export interface MigrateSegmentOptions {
  audit: string;
  root?: string;
  browserPath?: string;
  timeoutMs?: number;
  onReady?: (url: string) => void;
}

export interface DomSegmentFingerprint {
  tag: string;
  id?: string;
  classes: string[];
  heading?: string;
  textHash: string;
  structureHash: string;
  ancestry: Array<{ tag: string; id?: string; classes: string[] }>;
  box: AuditLayoutNode["box"];
}

export interface ManualDomRoot {
  selector: string;
  tag: string;
  fingerprint: DomSegmentFingerprint;
  evidence: AuditLayoutNode;
}

export interface ManualDomSegment {
  id: string;
  source: "manual-dom";
  role: SegmentRole;
  label: string;
  selectors: string[];
  roots: ManualDomRoot[];
  selector: string;
  tag: string;
  fingerprint: DomSegmentFingerprint;
  evidence: AuditLayoutNode;
}

export interface SegmentArtifact {
  version: "0.3";
  type: "sitespec-migrate-segments";
  status: "complete";
  source: "manual-dom";
  sourceUrl: string;
  observedUrl: string;
  sourceAudit: ".";
  viewport: { name: "desktop"; width: number; height: number };
  createdAt: string;
  segments: ManualDomSegment[];
}

export interface MigrateSegmentResult {
  sourceUrl: string;
  observedUrl: string;
  audit: string;
  output: string;
  browser: string;
  summary: {
    segments: number;
    sections: number;
    ignored: number;
    header: boolean;
    footer: boolean;
  };
}

export class MigrateSegmentError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateSegmentError";
    this.code = code;
    this.details = details;
  }
}

interface LoadedSegmentAudit {
  root: string;
  audit: Record<string, unknown>;
  sourceUrl: string;
  viewport: { name: "desktop"; width: number; height: number };
  existing?: Record<string, unknown>;
}

interface PickerRootPayload {
  selector: string;
  tag: string;
  fingerprint: DomSegmentFingerprint;
  evidence: AuditLayoutNode;
}

interface PickerSegmentPayload {
  role: SegmentRole;
  label: string;
  selectors: string[];
  roots: PickerRootPayload[];
  selector: string;
  tag: string;
  fingerprint: DomSegmentFingerprint;
  evidence: AuditLayoutNode;
}

interface PickerSavePayload {
  observedUrl: string;
  viewport: { width: number; height: number };
  segments: PickerSegmentPayload[];
}

interface PickerUiState {
  left?: number;
  top?: number;
  collapsed?: boolean;
}

interface PickerReloadPayload {
  selections: Array<{ role: SegmentRole; label: string; selectors: string[] }>;
  ui: PickerUiState;
}

type PickerAction =
  | { type: "save"; payload: PickerSavePayload }
  | { type: "reload"; payload: PickerReloadPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string, code: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error("JSON root is not an object.");
    return value;
  } catch (error) {
    throw new MigrateSegmentError(code, `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function resolveSegmentAuditRoot(input: string, root = "."): Promise<string> {
  const absolute = isAbsolute(input) ? input : resolve(root, input);
  if (basename(absolute) === "audit.json") return dirname(absolute);
  if (await fileExists(join(absolute, "audit.json"))) return absolute;
  throw new MigrateSegmentError("MIGRATE_SEGMENT_AUDIT_NOT_FOUND", `Could not find audit.json in ${absolute}.`, { audit: absolute });
}

async function loadSegmentAudit(input: string, root: string): Promise<LoadedSegmentAudit> {
  const auditRoot = await resolveSegmentAuditRoot(input, root);
  const audit = await readJson(join(auditRoot, "audit.json"), "MIGRATE_SEGMENT_AUDIT_INVALID");
  if (audit.type !== "sitespec-migrate-audit" || audit.status !== "complete") {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_AUDIT_INCOMPLETE", `Expected a completed migrate audit at ${auditRoot}.`, {
      type: audit.type,
      status: audit.status
    });
  }
  const sourceUrl = typeof audit.sourceUrl === "string" ? audit.sourceUrl : undefined;
  if (!sourceUrl) throw new MigrateSegmentError("MIGRATE_SEGMENT_AUDIT_INVALID", `Audit is missing sourceUrl: ${auditRoot}`);
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_AUDIT_INVALID", `Audit sourceUrl is invalid: ${sourceUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_URL_UNSUPPORTED", "Live DOM segmentation requires an http(s) production URL.");
  }

  const files = isRecord(audit.files) ? audit.files : {};
  const pageFile = typeof files.page === "string" ? files.page : "page.json";
  let viewport = { name: "desktop" as const, width: 1440, height: 1000 };
  if (await fileExists(join(auditRoot, pageFile))) {
    const page = await readJson(join(auditRoot, pageFile), "MIGRATE_SEGMENT_AUDIT_INVALID");
    const captures = Array.isArray(page.viewportCaptures) ? page.viewportCaptures : [];
    const desktop = captures.find(item => isRecord(item) && isRecord(item.viewport) && item.viewport.name === "desktop");
    if (isRecord(desktop) && isRecord(desktop.viewport)) {
      const width = Number(desktop.viewport.width);
      const height = Number(desktop.viewport.height);
      if (Number.isFinite(width) && width >= 320 && Number.isFinite(height) && height >= 240) viewport = { name: "desktop", width, height };
    }
  }

  let existing: Record<string, unknown> | undefined;
  const segmentsPath = join(auditRoot, "segments.json");
  if (await fileExists(segmentsPath)) {
    try {
      const raw = JSON.parse(await readFile(segmentsPath, "utf8")) as unknown;
      if (isRecord(raw) && raw.type === "sitespec-migrate-segments" && raw.status === "complete" && Array.isArray(raw.segments)) existing = raw;
    } catch {
      // A malformed previous review should not prevent a fresh live review.
    }
  }

  return { root: auditRoot, audit, sourceUrl, viewport, existing };
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeBox(value: unknown): AuditLayoutNode["box"] | undefined {
  if (!isRecord(value)) return undefined;
  const x = asFiniteNumber(value.x);
  const y = asFiniteNumber(value.y);
  const width = asFiniteNumber(value.width);
  const height = asFiniteNumber(value.height);
  if ([x, y, width, height].some(item => item === undefined) || width! < 0 || height! < 0) return undefined;
  return { x: x!, y: y!, width: width!, height: height! };
}

function normalizeStringArray(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, max);
}

function normalizeEvidence(value: unknown): AuditLayoutNode | undefined {
  if (!isRecord(value)) return undefined;
  const selector = typeof value.selector === "string" ? value.selector.trim() : "";
  const tag = typeof value.tag === "string" ? value.tag.trim().toLowerCase() : "";
  const box = normalizeBox(value.box);
  if (!selector || !tag || !box) return undefined;
  return {
    selector,
    tag,
    heading: typeof value.heading === "string" ? value.heading.slice(0, 500) : undefined,
    content: isRecord(value.content) ? value.content as AuditLayoutNode["content"] : undefined,
    structure: isRecord(value.structure) ? value.structure as AuditLayoutNode["structure"] : undefined,
    style: isRecord(value.style) ? value.style as AuditLayoutNode["style"] : undefined,
    headingStyle: isRecord(value.headingStyle) ? value.headingStyle as AuditLayoutNode["headingStyle"] : undefined,
    box
  };
}

function normalizeFingerprint(value: unknown, evidence: AuditLayoutNode): DomSegmentFingerprint | undefined {
  if (!isRecord(value)) return undefined;
  const textHash = typeof value.textHash === "string" ? value.textHash : "";
  const structureHash = typeof value.structureHash === "string" ? value.structureHash : "";
  const box = normalizeBox(value.box) ?? evidence.box;
  if (!textHash || !structureHash) return undefined;
  const ancestry = Array.isArray(value.ancestry)
    ? value.ancestry.filter(isRecord).slice(0, 6).map(item => ({
      tag: typeof item.tag === "string" ? item.tag : "div",
      id: typeof item.id === "string" && item.id ? item.id : undefined,
      classes: normalizeStringArray(item.classes, 12)
    }))
    : [];
  return {
    tag: typeof value.tag === "string" ? value.tag : evidence.tag,
    id: typeof value.id === "string" && value.id ? value.id : undefined,
    classes: normalizeStringArray(value.classes, 20),
    heading: typeof value.heading === "string" && value.heading ? value.heading.slice(0, 500) : undefined,
    textHash,
    structureHash,
    ancestry,
    box
  };
}

function hashSegmentValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function unionBoxes(boxes: AuditLayoutNode["box"][]): AuditLayoutNode["box"] {
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function sumNumberField(items: AuditLayoutNode[], key: keyof NonNullable<AuditLayoutNode["content"]>): number {
  return items.reduce((total, item) => total + Number(item.content?.[key] ?? 0), 0);
}

function aggregateRootEvidence(roots: PickerRootPayload[]): { evidence: AuditLayoutNode; fingerprint: DomSegmentFingerprint; tag: string } {
  if (roots.length === 1) return { evidence: roots[0]!.evidence, fingerprint: roots[0]!.fingerprint, tag: roots[0]!.tag };
  const firstHeading = roots.map(root => root.evidence.heading).find((value): value is string => Boolean(value));
  const descendantTags: Record<string, number> = {};
  for (const root of roots) {
    for (const [tag, count] of Object.entries(root.evidence.structure?.descendantTags ?? {})) {
      descendantTags[tag] = (descendantTags[tag] ?? 0) + Number(count || 0);
    }
  }
  const commonStyle = (key: keyof NonNullable<AuditLayoutNode["style"]>): string | undefined => {
    const values = roots.map(root => root.evidence.style?.[key]).filter((value): value is string => typeof value === "string" && value.length > 0);
    return values.length === roots.length && new Set(values).size === 1 ? values[0] : undefined;
  };
  const box = unionBoxes(roots.map(root => root.evidence.box));
  const evidence: AuditLayoutNode = {
    selector: roots[0]!.selector,
    tag: "group",
    heading: firstHeading,
    content: {
      textLength: sumNumberField(roots.map(root => root.evidence), "textLength"),
      headings: sumNumberField(roots.map(root => root.evidence), "headings"),
      links: sumNumberField(roots.map(root => root.evidence), "links"),
      buttons: sumNumberField(roots.map(root => root.evidence), "buttons"),
      images: sumNumberField(roots.map(root => root.evidence), "images"),
      videos: sumNumberField(roots.map(root => root.evidence), "videos"),
      forms: sumNumberField(roots.map(root => root.evidence), "forms"),
      lists: sumNumberField(roots.map(root => root.evidence), "lists")
    },
    structure: {
      directChildren: roots.length,
      directChildTags: roots.map(root => root.tag).slice(0, 24),
      descendantTags
    },
    style: {
      display: "group",
      position: commonStyle("position"),
      color: commonStyle("color"),
      backgroundColor: commonStyle("backgroundColor"),
      borderRadius: commonStyle("borderRadius"),
      paddingTop: commonStyle("paddingTop"),
      paddingRight: commonStyle("paddingRight"),
      paddingBottom: commonStyle("paddingBottom"),
      paddingLeft: commonStyle("paddingLeft"),
      gap: commonStyle("gap"),
      gridTemplateColumns: commonStyle("gridTemplateColumns"),
      flexDirection: commonStyle("flexDirection"),
      alignItems: commonStyle("alignItems"),
      justifyContent: commonStyle("justifyContent")
    },
    headingStyle: roots.map(root => root.evidence.headingStyle).find(value => value !== undefined),
    box
  };
  const fingerprint: DomSegmentFingerprint = {
    tag: "group",
    classes: [],
    heading: firstHeading,
    textHash: hashSegmentValue(roots.map(root => root.fingerprint.textHash).join("|")),
    structureHash: hashSegmentValue(JSON.stringify(evidence.structure)),
    ancestry: [],
    box
  };
  return { evidence, fingerprint, tag: "group" };
}

function normalizePickerRoot(value: unknown, index: number, rootIndex: number): PickerRootPayload {
  if (!isRecord(value)) throw new MigrateSegmentError("MIGRATE_SEGMENT_ROOT_INVALID", `Selection ${index + 1} root ${rootIndex + 1} is invalid.`);
  const selector = typeof value.selector === "string" ? value.selector.trim() : "";
  if (!selector) throw new MigrateSegmentError("MIGRATE_SEGMENT_SELECTOR_INVALID", `Selection ${index + 1} root ${rootIndex + 1} is missing a selector.`);
  const evidence = normalizeEvidence(value.evidence);
  if (!evidence) throw new MigrateSegmentError("MIGRATE_SEGMENT_EVIDENCE_INVALID", `Selection ${index + 1} root ${rootIndex + 1} is missing live DOM evidence.`);
  const fingerprint = normalizeFingerprint(value.fingerprint, evidence);
  if (!fingerprint) throw new MigrateSegmentError("MIGRATE_SEGMENT_FINGERPRINT_INVALID", `Selection ${index + 1} root ${rootIndex + 1} is missing its DOM fingerprint.`);
  return {
    selector,
    tag: typeof value.tag === "string" && value.tag ? value.tag.toLowerCase() : evidence.tag,
    fingerprint,
    evidence: { ...evidence, selector }
  };
}

export function normalizeDomSelections(raw: unknown): { observedUrl: string; viewport: { width: number; height: number }; segments: PickerSegmentPayload[] } {
  if (!isRecord(raw) || !Array.isArray(raw.segments)) {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_PAYLOAD_INVALID", "Live picker payload must contain a segments array.");
  }
  if (raw.segments.length === 0 || raw.segments.length > 100) {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_SELECTIONS_INVALID", "Select between 1 and 100 production DOM blocks before saving.");
  }
  const observedUrl = typeof raw.observedUrl === "string" ? raw.observedUrl : "";
  try {
    const url = new URL(observedUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_PAYLOAD_INVALID", "Live picker did not provide a valid observed production URL.");
  }
  const viewportRaw = isRecord(raw.viewport) ? raw.viewport : {};
  const width = asFiniteNumber(viewportRaw.width);
  const height = asFiniteNumber(viewportRaw.height);
  if (!width || width < 320 || !height || height < 240) {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_VIEWPORT_INVALID", "Live picker viewport dimensions are invalid.");
  }

  const roles = new Set<SegmentRole>(["section", "header", "footer", "ignore"]);
  const selectors = new Set<string>();
  let headers = 0;
  let footers = 0;
  const segments: PickerSegmentPayload[] = raw.segments.map((item, index) => {
    if (!isRecord(item)) throw new MigrateSegmentError("MIGRATE_SEGMENT_SELECTION_INVALID", `Selection ${index + 1} is invalid.`);
    const role = item.role as SegmentRole;
    if (!roles.has(role)) throw new MigrateSegmentError("MIGRATE_SEGMENT_ROLE_INVALID", `Unknown segment role: ${String(item.role)}`);
    if (role === "header") headers += 1;
    if (role === "footer") footers += 1;

    const rawRoots = Array.isArray(item.roots) && item.roots.length > 0 ? item.roots : [item];
    if (rawRoots.length > 24) throw new MigrateSegmentError("MIGRATE_SEGMENT_ROOTS_INVALID", `Selection ${index + 1} contains more than 24 DOM roots.`);
    const roots = rawRoots.map((root, rootIndex) => normalizePickerRoot(root, index, rootIndex));
    for (const root of roots) {
      if (selectors.has(root.selector)) throw new MigrateSegmentError("MIGRATE_SEGMENT_SELECTOR_INVALID", `Selector ${root.selector} is used by more than one selected block.`);
      selectors.add(root.selector);
    }
    const aggregated = aggregateRootEvidence(roots);
    const label = typeof item.label === "string" ? item.label.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    return {
      role,
      label: label || aggregated.evidence.heading || (role === "header" ? "Header" : role === "footer" ? "Footer" : role === "ignore" ? "Ignored region" : `Segment ${String(index + 1).padStart(2, "0")}`),
      selectors: roots.map(root => root.selector),
      roots,
      selector: roots[0]!.selector,
      tag: aggregated.tag,
      fingerprint: aggregated.fingerprint,
      evidence: aggregated.evidence
    };
  });
  if (headers > 1 || footers > 1) throw new MigrateSegmentError("MIGRATE_SEGMENT_SHELL_DUPLICATE", "A review may mark at most one header and one footer block.");
  return { observedUrl, viewport: { width, height }, segments };
}

export function buildDomSegmentArtifact(sourceUrl: string, raw: unknown): SegmentArtifact {
  const normalized = normalizeDomSelections(raw);
  const ordered = [...normalized.segments].sort((a, b) => a.evidence.box.y - b.evidence.box.y || a.evidence.box.x - b.evidence.box.x);
  return {
    version: "0.3",
    type: "sitespec-migrate-segments",
    status: "complete",
    source: "manual-dom",
    sourceUrl,
    observedUrl: normalized.observedUrl,
    sourceAudit: ".",
    viewport: { name: "desktop", ...normalized.viewport },
    createdAt: new Date().toISOString(),
    segments: ordered.map((item, index) => ({
      id: `segment-${String(index + 1).padStart(2, "0")}`,
      source: "manual-dom",
      ...item
    }))
  };
}

interface PickerPreviousSelection {
  role: SegmentRole;
  label: string;
  selectors: string[];
}

function previousSelections(existing: Record<string, unknown> | undefined): PickerPreviousSelection[] {
  if (!existing || !Array.isArray(existing.segments)) return [];
  const roles = new Set<SegmentRole>(["section", "header", "footer", "ignore"]);
  const result: PickerPreviousSelection[] = [];
  for (const raw of existing.segments) {
    if (!isRecord(raw) || !roles.has(raw.role as SegmentRole)) continue;
    const evidence = isRecord(raw.evidence) ? raw.evidence : {};
    const rootSelectors = Array.isArray(raw.roots)
      ? raw.roots.filter(isRecord).map(root => typeof root.selector === "string" ? root.selector.trim() : "").filter(Boolean)
      : [];
    const explicitSelectors = Array.isArray(raw.selectors) ? normalizeStringArray(raw.selectors, 24) : [];
    const legacySelector = typeof raw.selector === "string" ? raw.selector : typeof evidence.selector === "string" ? evidence.selector : "";
    const selectors = [...new Set(rootSelectors.length ? rootSelectors : explicitSelectors.length ? explicitSelectors : legacySelector ? [legacySelector] : [])];
    if (!selectors.length) continue;
    result.push({
      role: raw.role as SegmentRole,
      label: typeof raw.label === "string" ? raw.label : "",
      selectors
    });
  }
  return result;
}

function jsonForExpression(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function livePickerExpression(
  initial: PickerPreviousSelection[],
  initialUi: PickerUiState = {}
): string {
  return `(() => {
  if (window.__sitespecSegmentPicker?.destroy) window.__sitespecSegmentPicker.destroy();
  const INITIAL = ${jsonForExpression(initial)};
  const INITIAL_UI = ${jsonForExpression(initialUi)};
  const ELIGIBLE = 'div,section,header,footer,main,article,nav';
  const ROLE_LABELS = { section: 'Section', header: 'Header', footer: 'Footer', ignore: 'Ignore' };
  const state = { mode: 'inspect', hover: null, current: null, currentRole: 'section', selections: [], activeSelection: null, editingSelection: null, editingRoot: null, batchSelections: new Set(), batchAnchor: null, mouseX: innerWidth / 2, mouseY: innerHeight / 2, message: '', collapsed: Boolean(INITIAL_UI.collapsed) };
  const host = document.createElement('div');
  host.id = '__sitespec_segment_picker__';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box}.ss-panel{position:fixed;top:16px;right:16px;width:360px;max-height:calc(100vh - 32px);overflow:hidden;pointer-events:auto;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35);font:13px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:3}.ss-panel.collapsed{overflow:hidden}.ss-panel.collapsed .ss-body{display:none}.ss-head{padding:10px 10px 10px 14px;border-bottom:1px solid #374151;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;user-select:none;touch-action:none}.ss-panel.collapsed .ss-head{border-bottom:0}.ss-title{font-weight:750;font-size:14px}.ss-actions{display:flex;align-items:center;gap:5px}.ss-mode,.ss-head-btn{border:1px solid #4b5563;background:#1f2937;color:#fff;border-radius:7px;padding:6px 8px;cursor:pointer;font:inherit;line-height:1}.ss-head-btn{min-width:30px}.ss-mode.interact{background:#065f46;border-color:#10b981}.ss-body{padding:12px 14px;max-height:calc(100vh - 82px);overflow:auto}.ss-muted{color:#9ca3af;font-size:11px}.ss-current{margin:8px 0;padding:9px;border-radius:8px;background:#1f2937;min-height:62px}.ss-tag{font-weight:750;color:#93c5fd;text-transform:uppercase}.ss-selector{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d1d5db;overflow-wrap:anywhere;margin-top:4px}.ss-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.ss-btn{border:1px solid #4b5563;background:#1f2937;color:#f9fafb;border-radius:7px;padding:7px 8px;cursor:pointer;text-align:center}.ss-btn:hover:not(:disabled),.ss-head-btn:hover,.ss-mode:hover{background:#374151}.ss-btn:disabled{opacity:.38;cursor:not-allowed}.ss-btn.active{background:#1d4ed8;border-color:#60a5fa}.ss-btn.primary{background:#f9fafb;color:#111827;border-color:#f9fafb;font-weight:700}.ss-btn.group{border-color:#2563eb;color:#bfdbfe}.ss-field-label{display:block;margin-top:10px;color:#d1d5db;font-size:11px;font-weight:700}.ss-input{width:100%;margin-top:5px;border:1px solid #4b5563;background:#111827;color:#fff;border-radius:7px;padding:8px 9px;font:inherit}.ss-input:focus{outline:2px solid #2563eb;outline-offset:1px}.ss-active{margin-top:7px;padding:6px 8px;border-radius:6px;background:#172033;color:#93c5fd;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ss-list{margin-top:12px;border-top:1px solid #374151;padding-top:10px}.ss-list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}.ss-list-body{max-height:min(250px,32vh);overflow-y:auto;overscroll-behavior:contain;padding-right:3px;scrollbar-gutter:stable}.ss-batch{margin:6px 0 7px;padding:7px;border:1px solid #4c1d95;background:#1e1633;border-radius:8px}.ss-batch.hidden{display:none}.ss-batch-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;color:#ddd6fe;font-size:11px}.ss-batch-actions{display:grid;grid-template-columns:1fr 1fr;gap:5px}.ss-item{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #1f2937}.ss-item.active{background:#172033;margin:0 -5px;padding-left:5px;padding-right:5px;border-radius:5px}.ss-item.batch{background:#21183a;margin:0 -5px;padding-left:5px;padding-right:5px;border-radius:5px}.ss-check{width:20px;height:20px;border:1px solid #4b5563;border-radius:5px;background:#111827;color:#ddd6fe;cursor:pointer;font:700 12px/18px ui-sans-serif,system-ui;text-align:center;padding:0}.ss-check.on{background:#6d28d9;border-color:#a78bfa}.ss-item-main{min-width:0;cursor:pointer}.ss-item-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ss-item-meta{font-size:10px;color:#9ca3af;text-transform:uppercase}.ss-x{border:0;background:transparent;color:#fca5a5;cursor:pointer;font-size:16px}.ss-status{min-height:30px;margin-top:8px;color:#fbbf24;font-size:11px}.ss-short{margin-top:9px;color:#9ca3af;font-size:10px}.ss-catcher{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;background:transparent;z-index:1}.ss-overlay{position:fixed;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,.08);z-index:2}.ss-overlay.selected{border-color:#10b981;background:rgba(16,185,129,.055)}.ss-overlay.ignore{border-color:#9ca3af;background:rgba(107,114,128,.08)}.ss-overlay.batch{border-color:#a78bfa;background:rgba(139,92,246,.11)}.ss-overlay.group-root{border-style:dashed}.ss-chip{position:absolute;top:0;left:0;transform:translateY(-100%);background:#111827;color:white;padding:2px 5px;border-radius:4px 4px 0 0;font:10px/1.2 ui-sans-serif,system-ui;white-space:nowrap}' +
    '</style><div id="catcher" class="ss-catcher"></div><div id="overlays"></div><aside class="ss-panel"><div id="head" class="ss-head"><div><div class="ss-title">SiteSpec Segment</div><div class="ss-muted">Live production DOM picker</div></div><div class="ss-actions"><button id="reload" class="ss-head-btn" title="Reload production page">↻ Reload</button><button id="mode" class="ss-mode">Inspect (P)</button><button id="collapse" class="ss-head-btn" title="Collapse inspector">−</button></div></div><div class="ss-body"><div class="ss-current"><div><span id="tag" class="ss-tag">Hover a region</span> <span id="size" class="ss-muted"></span></div><div id="selector" class="ss-selector">Move over the production page, click to lock a DOM region.</div></div><div class="ss-grid"><button id="parent" class="ss-btn">↑ Parent</button><button id="child" class="ss-btn">↓ Child</button><button id="prev" class="ss-btn">← Previous</button><button id="next" class="ss-btn">Next →</button></div><label class="ss-field-label" for="label">Block name</label><input id="label" class="ss-input" maxlength="160" placeholder="e.g. Platform hero"><div id="active" class="ss-active">Active block: none</div><div class="ss-grid" id="roles"><button class="ss-btn active" data-role="section">Section (S)</button><button class="ss-btn" data-role="header">Header (H)</button><button class="ss-btn" data-role="footer">Footer (F)</button><button class="ss-btn" data-role="ignore">Ignore (I)</button></div><div class="ss-grid"><button id="add" class="ss-btn primary">Add / update block</button><button id="add-root" class="ss-btn group">Add root to block (G)</button><button id="remove-root" class="ss-btn">Remove root</button><button id="unlock" class="ss-btn">Unlock (Esc)</button></div><div id="status" class="ss-status"></div><div class="ss-list"><div class="ss-list-head"><div><strong id="count">0</strong> blocks</div><span class="ss-muted">scrollable · select to merge</span></div><div id="batch" class="ss-batch hidden"><div class="ss-batch-head"><span><strong id="batch-count">0</strong> selected</span><span>Block name + role apply to merge</span></div><div class="ss-batch-actions"><button id="merge-selected" class="ss-btn group">Merge selected</button><button id="ungroup-selected" class="ss-btn">Ungroup</button><button id="delete-selected" class="ss-btn">Delete selected</button><button id="cancel-selected" class="ss-btn">Cancel selection</button></div></div><div id="list" class="ss-list-body"></div></div><button id="save" class="ss-btn primary" style="width:100%;margin-top:12px">Save & finish</button><div class="ss-short">Add/update returns immediately to Inspect. The new block stays active so another selected sibling can be added with Add root to block. Select existing blocks with the checkbox, Cmd/Ctrl-click, or Shift-click, then Merge selected. G adds a root; M merges selected blocks. Reload preserves blocks and inspector position.</div></div></aside>';
  document.documentElement.appendChild(host);
  const $ = (id) => shadow.getElementById(id);
  const catcher = $('catcher');
  const overlays = $('overlays');
  const panel = shadow.querySelector('.ss-panel');
  const head = $('head');

  const clean = (value, max) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max || 500);
  const fnv = (value) => { let h = 2166136261; for (let i=0;i<value.length;i++){ h ^= value.charCodeAt(i); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const classes = (el) => Array.from(el.classList || []).filter(Boolean).slice(0,20);
  const visible = (el) => { if (!(el instanceof Element)) return false; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>=24 && r.height>=18 && s.display!=='none' && s.visibility!=='hidden' && Number(s.opacity||1)>0.01; };
  const eligible = (el) => el instanceof Element && el.matches(ELIGIBLE) && visible(el) && !host.contains(el);
  const regionFrom = (node) => { let el = node instanceof Element ? node : null; while (el && el !== document.body && el !== document.documentElement) { if (eligible(el)) return el; el = el.parentElement; } return null; };
  const eligibleParent = (el) => { let p=el?.parentElement; while(p && p!==document.body && p!==document.documentElement){ if(eligible(p)) return p; p=p.parentElement; } return null; };
  const eligibleSibling = (el, dir) => { let s=dir<0?el?.previousElementSibling:el?.nextElementSibling; while(s){ if(eligible(s)) return s; s=dir<0?s.previousElementSibling:s.nextElementSibling; } return null; };
  const eligibleChild = (el) => { if(!el) return null; const point=document.elementFromPoint(state.mouseX,state.mouseY); if(point && el.contains(point)){ let p=regionFrom(point); while(p && p.parentElement && p.parentElement!==el && el.contains(p.parentElement)){ const next=regionFrom(p.parentElement); if(!next||next===p) break; p=next; } if(p&&p!==el&&el.contains(p)) return p; } const all=Array.from(el.querySelectorAll(ELIGIBLE)).filter(eligible); return all.sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return br.width*br.height-ar.width*ar.height;})[0]||null; };
  const selectorFor = (el) => { if (el.id) { const byId='#'+CSS.escape(el.id); try { if(document.querySelectorAll(byId).length===1) return byId; } catch {} } const parts=[]; let node=el; while(node && node!==document.documentElement && parts.length<9){ let part=node.tagName.toLowerCase(); const parent=node.parentElement; if(parent){ const same=Array.from(parent.children).filter(child=>child.tagName===node.tagName); if(same.length>1) part += ':nth-of-type('+(same.indexOf(node)+1)+')'; } parts.unshift(part); const test=parts.join(' > '); try{ if(document.querySelectorAll(test).length===1) return test; }catch{} node=parent; } return parts.join(' > '); };
  const headingOf = (el) => { const h=el.matches('h1,h2,h3,h4,h5,h6')?el:el.querySelector('h1,h2,h3,h4,h5,h6'); return h?clean(h.textContent,500):''; };
  const contentOf = (el) => ({ textLength: clean(el.innerText,12000).length, headings: el.querySelectorAll('h1,h2,h3,h4,h5,h6').length + (el.matches('h1,h2,h3,h4,h5,h6')?1:0), links: el.querySelectorAll('a[href]').length, buttons: el.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]').length, images: el.querySelectorAll('img,picture,svg').length, videos: el.querySelectorAll('video').length, forms: el.querySelectorAll('form').length, lists: el.querySelectorAll('ul,ol').length });
  const structureOf = (el) => { const tags={}; const desc=Array.from(el.querySelectorAll('*')).slice(0,1200); for(const n of desc){const t=n.tagName.toLowerCase();tags[t]=(tags[t]||0)+1;} return { directChildren: el.children.length, directChildTags:Array.from(el.children).slice(0,24).map(n=>n.tagName.toLowerCase()), descendantTags:tags }; };
  const styleOf = (el) => { const s=getComputedStyle(el); return { display:s.display, position:s.position, color:s.color, backgroundColor:s.backgroundColor, borderRadius:s.borderRadius, paddingTop:s.paddingTop, paddingRight:s.paddingRight, paddingBottom:s.paddingBottom, paddingLeft:s.paddingLeft, gap:s.gap, gridTemplateColumns:s.gridTemplateColumns, flexDirection:s.flexDirection, alignItems:s.alignItems, justifyContent:s.justifyContent }; };
  const headingStyleOf = (el) => { const h=el.matches('h1,h2,h3,h4,h5,h6')?el:el.querySelector('h1,h2,h3,h4,h5,h6'); if(!h)return undefined; const s=getComputedStyle(h); return { fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,textTransform:s.textTransform }; };
  const offsetPoint = (el) => { let x=0,y=0,node=el,guard=0; while(node instanceof HTMLElement && guard<40){x+=node.offsetLeft;y+=node.offsetTop;node=node.offsetParent;guard+=1;} return {x,y}; };
  const boxOf = (el) => { const r=el.getBoundingClientRect(); const position=getComputedStyle(el).position; let x=r.left+scrollX,y=r.top+scrollY; if(position==='fixed'){x=r.left;y=r.top;} else if(position==='sticky'){const o=offsetPoint(el);x=o.x;y=o.y;} return { x:Math.round(x*1000)/1000,y:Math.round(y*1000)/1000,width:Math.round(r.width*1000)/1000,height:Math.round(r.height*1000)/1000 }; };
  const evidenceOf = (el) => { const selector=selectorFor(el), heading=headingOf(el), style=styleOf(el); return { selector, tag:el.tagName.toLowerCase(), heading:heading||undefined, background:style.backgroundColor, content:contentOf(el), structure:structureOf(el), style, headingStyle:headingStyleOf(el), box:boxOf(el) }; };
  const fingerprintOf = (el, evidence) => { const ancestry=[]; let p=el.parentElement; while(p && p!==document.documentElement && ancestry.length<6){ ancestry.push({tag:p.tagName.toLowerCase(),id:p.id||undefined,classes:classes(p).slice(0,12)}); p=p.parentElement; } const text=clean(el.innerText,5000); const structure=JSON.stringify(evidence.structure); return { tag:el.tagName.toLowerCase(),id:el.id||undefined,classes:classes(el),heading:evidence.heading,textHash:fnv(text),structureHash:fnv(structure),ancestry,box:evidence.box }; };
  const selectionFor = (el) => state.selections.find(item=>item.els.includes(el));
  const selectionIndex = (el) => state.selections.findIndex(item=>item.els.includes(el));
  const rootConflict = (el, target, ignoreRoot) => { for(const item of state.selections){for(const root of item.els){if(root===el||root===ignoreRoot)continue;if(target===item && target.els.includes(root)){if(root.contains(el)||el.contains(root))return {item,root};continue;}if(root.contains(el)||el.contains(root))return {item,root};}} return null; };
  const setMessage = (message) => { state.message=message||''; $('status').textContent=state.message; };
  const roleSet = (role) => { if(!ROLE_LABELS[role])return; state.currentRole=role; shadow.querySelectorAll('[data-role]').forEach(btn=>btn.classList.toggle('active',btn.dataset.role===role)); };
  const clampPanel = (left, top) => { const r=panel.getBoundingClientRect(); return { left:Math.max(8,Math.min(Math.max(8,innerWidth-r.width-8),left)), top:Math.max(8,Math.min(Math.max(8,innerHeight-r.height-8),top)) }; };
  const positionPanel = (left, top) => { const next=clampPanel(left,top); panel.style.left=next.left+'px';panel.style.top=next.top+'px';panel.style.right='auto'; };
  const panelUi = () => { const r=panel.getBoundingClientRect(); return { left:Math.round(r.left),top:Math.round(r.top),collapsed:state.collapsed }; };
  const setCollapsed = (value) => { state.collapsed=Boolean(value);panel.classList.toggle('collapsed',state.collapsed);$('collapse').textContent=state.collapsed?'+':'−';$('collapse').title=state.collapsed?'Expand inspector':'Collapse inspector';const r=panel.getBoundingClientRect();positionPanel(r.left,r.top); };
  const blockBox = (item) => { const boxes=item.els.map(boxOf);const x=Math.min(...boxes.map(box=>box.x)),y=Math.min(...boxes.map(box=>box.y)),right=Math.max(...boxes.map(box=>box.x+box.width)),bottom=Math.max(...boxes.map(box=>box.y+box.height));return {x,y,width:right-x,height:bottom-y}; };
  const orderedSelections = () => state.selections.slice().sort((a,b)=>blockBox(a).y-blockBox(b).y||blockBox(a).x-blockBox(b).x);
  const batchItems = () => orderedSelections().filter(item=>state.batchSelections.has(item));
  const clearBatch = () => { state.batchSelections.clear(); state.batchAnchor=null; };
  const syncBatchControls = () => { const items=batchItems(); if(!items.length)return; const roles=new Set(items.map(item=>item.role)); if(roles.size===1)roleSet(items[0].role); if(items.length===1)$('label').value=items[0].label||headingOf(items[0].els[0])||''; };
  const toggleBatch = (item, range) => { const ordered=orderedSelections(); if(range&&state.batchAnchor&&ordered.includes(state.batchAnchor)){const from=ordered.indexOf(state.batchAnchor),to=ordered.indexOf(item);for(const value of ordered.slice(Math.min(from,to),Math.max(from,to)+1))state.batchSelections.add(value);}else if(state.batchSelections.has(item))state.batchSelections.delete(item);else state.batchSelections.add(item);state.batchAnchor=item;syncBatchControls();render(); };
  const setCurrent = (el, lock) => { if(!eligible(el))return; state.current=el; if(lock) state.hover=null; const existing=selectionFor(el); if(existing){ state.activeSelection=existing; state.editingSelection=existing; state.editingRoot=el; roleSet(existing.role); $('label').value=existing.label||''; } else { state.editingSelection=null; state.editingRoot=null; roleSet(el.tagName.toLowerCase()==='header'?'header':el.tagName.toLowerCase()==='footer'?'footer':'section'); $('label').value=headingOf(el); } render(); };
  const rectOverlay = (el, kind, label) => { const r=el.getBoundingClientRect(); if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)return; const box=document.createElement('div'); box.className='ss-overlay '+kind; box.style.left=Math.max(0,r.left)+'px';box.style.top=Math.max(0,r.top)+'px';box.style.width=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))+'px';box.style.height=Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))+'px'; if(label){const chip=document.createElement('span');chip.className='ss-chip';chip.textContent=label;box.appendChild(chip);} overlays.appendChild(box); };
  const render = () => {
    overlays.innerHTML='';
    for(const item of state.selections){item.els.forEach((el,index)=>rectOverlay(el,(item.role==='ignore'?'selected ignore':'selected')+(state.batchSelections.has(item)?' batch':'')+(item.els.length>1?' group-root':''),index===0?ROLE_LABELS[item.role]+': '+(item.label||headingOf(el)||el.tagName.toLowerCase())+(item.els.length>1?' · '+item.els.length+' roots':''):''));}
    const current=state.current||state.hover;
    if(state.mode==='inspect'&&current&&!selectionFor(current)) rectOverlay(current,'',current.tagName.toLowerCase());
    if(current){const e=evidenceOf(current);$('tag').textContent=e.tag;$('size').textContent=Math.round(e.box.width)+'×'+Math.round(e.box.height);$('selector').textContent=e.selector;} else {$('tag').textContent=state.mode==='interact'?'Interact mode':'Hover a region';$('size').textContent='';$('selector').textContent=state.mode==='interact'?'The production page accepts normal clicks. Press P to inspect again.':'Move over the production page; hover immediately inspects the next DOM region.';}
    $('count').textContent=String(state.selections.length);
    $('active').textContent=state.activeSelection?'Active block: '+(state.activeSelection.label||headingOf(state.activeSelection.els[0])||'unnamed')+' · '+state.activeSelection.els.length+' root'+(state.activeSelection.els.length===1?'':'s'):'Active block: none';
    const selected=batchItems();$('batch').classList.toggle('hidden',selected.length===0);$('batch-count').textContent=String(selected.length);$('merge-selected').disabled=selected.length<2;$('ungroup-selected').disabled=selected.length!==1||selected[0].els.length<2||selected[0].role==='header'||selected[0].role==='footer';$('delete-selected').disabled=selected.length===0;
    const list=$('list'); const listScrollTop=list.scrollTop; list.innerHTML='';
    orderedSelections().forEach(item=>{const row=document.createElement('div');row.className='ss-item'+(state.activeSelection===item?' active':'')+(state.batchSelections.has(item)?' batch':'');const check=document.createElement('button');check.className='ss-check'+(state.batchSelections.has(item)?' on':'');check.textContent=state.batchSelections.has(item)?'✓':'';check.title='Select block for merge/group actions';check.setAttribute('aria-pressed',state.batchSelections.has(item)?'true':'false');check.addEventListener('click',(event)=>{event.stopPropagation();toggleBatch(item,event.shiftKey);});const main=document.createElement('div');main.className='ss-item-main';main.innerHTML='<div class="ss-item-title"></div><div class="ss-item-meta"></div>';main.querySelector('.ss-item-title').textContent=item.label||headingOf(item.els[0])||item.els[0].tagName.toLowerCase();main.querySelector('.ss-item-meta').textContent=ROLE_LABELS[item.role]+' · '+item.els.length+' root'+(item.els.length===1?'':'s');main.addEventListener('click',(event)=>{if(event.metaKey||event.ctrlKey||event.shiftKey){event.preventDefault();toggleBatch(item,event.shiftKey);return;}state.activeSelection=item;state.editingSelection=item;state.editingRoot=item.els[0];state.current=item.els[0];state.hover=null;roleSet(item.role);$('label').value=item.label||'';item.els[0].scrollIntoView({block:'center',behavior:'smooth'});render();});const x=document.createElement('button');x.className='ss-x';x.textContent='×';x.title='Remove block';x.addEventListener('click',(event)=>{event.stopPropagation();state.selections=state.selections.filter(value=>value!==item);state.batchSelections.delete(item);if(state.batchAnchor===item)state.batchAnchor=null;if(state.activeSelection===item)state.activeSelection=null;if(state.editingSelection===item){state.editingSelection=null;state.editingRoot=null;}if(item.els.includes(state.current))state.current=null;render();});row.append(check,main,x);list.appendChild(row);});
    list.scrollTop=listScrollTop;
    $('mode').textContent=state.mode==='inspect'?'Inspect (P)':'Interact (P)';$('mode').classList.toggle('interact',state.mode==='interact');
    const currentOwner=current?selectionFor(current):null;
    $('add-root').disabled=!state.activeSelection||!current||currentOwner===state.activeSelection;
    $('remove-root').disabled=!currentOwner;
    $('remove-root').textContent=currentOwner&&currentOwner.els.length===1?'Remove block':'Remove root';
    $('status').textContent=state.message;
  };
  const resumeInspect = (message) => { state.mode='inspect';state.current=null;state.hover=null;state.editingSelection=null;state.editingRoot=null;catcher.style.pointerEvents='auto';$('label').blur();setMessage(message);render(); };
  const toggleMode = () => { state.mode=state.mode==='inspect'?'interact':'inspect'; state.hover=null; state.current=null; state.editingSelection=null;state.editingRoot=null; catcher.style.pointerEvents=state.mode==='inspect'?'auto':'none'; setMessage(state.mode==='interact'?'Interact mode: production controls are enabled; navigation remains disabled.':'Inspect mode: hover a region; no extra page click is required after adding a block.'); render(); };
  const addCurrent = () => { const el=state.current||state.hover; if(!eligible(el)){setMessage('Lock a production region first.');return;} const existing=selectionFor(el); const editing=state.editingSelection&&state.editingRoot&&state.editingSelection.els.includes(state.editingRoot)?state.editingSelection:null; const item=existing||editing; const replacingRoot=!existing&&item?state.editingRoot:null; const role=state.currentRole; if((role==='header'||role==='footer')&&state.selections.some(value=>value!==item&&value.role===role)){setMessage('Only one '+role+' block can be selected.');return;} if(!existing){const conflict=rootConflict(el,item,replacingRoot);if(conflict){setMessage('Nested overlap with "'+(conflict.item.label||conflict.root.tagName.toLowerCase())+'". Remove that selection first.');return;}} const label=clean($('label').value,160); let target=item; if(target){if(replacingRoot){const index=target.els.indexOf(replacingRoot);if(index>=0)target.els[index]=el;target.els.sort((a,b)=>boxOf(a).y-boxOf(b).y||boxOf(a).x-boxOf(b).x);}target.role=role;target.label=label||target.label;}else{target={els:[el],role,label};state.selections.push(target);} state.activeSelection=target; const name=target.label||headingOf(el)||el.tagName.toLowerCase(); resumeInspect((item?'Updated ':'Added ')+name+'. Inspecting the next region.'); };
  const addRootCurrent = () => { const target=state.activeSelection; const el=state.current||state.hover; if(!target){setMessage('Select or create the block that should receive another root.');return;} if(!eligible(el)){setMessage('Lock another production region first.');return;} const owner=selectionFor(el); if(owner===target){setMessage('That DOM root is already part of the active block.');return;} if(owner){setMessage('That DOM root already belongs to "'+(owner.label||headingOf(owner.els[0])||'another block')+'".');return;} const conflict=rootConflict(el,target);if(conflict){setMessage('Nested overlap with "'+(conflict.item.label||conflict.root.tagName.toLowerCase())+'". Choose a sibling-level root instead.');return;} target.els.push(el);target.els.sort((a,b)=>boxOf(a).y-boxOf(b).y||boxOf(a).x-boxOf(b).x);const name=target.label||headingOf(target.els[0])||'block';resumeInspect('Added root to '+name+' ('+target.els.length+' roots). Inspecting the next region.'); };
  const removeCurrentRoot = () => { const el=state.current||state.hover; const owner=el?selectionFor(el):null;if(!owner){setMessage('Lock a selected DOM root first.');return;}if(owner.els.length===1){state.selections=state.selections.filter(item=>item!==owner);state.batchSelections.delete(owner);if(state.batchAnchor===owner)state.batchAnchor=null;if(state.activeSelection===owner)state.activeSelection=null;resumeInspect('Removed block. Inspecting the next region.');return;}owner.els=owner.els.filter(root=>root!==el);state.activeSelection=owner;resumeInspect('Removed root from '+(owner.label||'block')+'. '+owner.els.length+' roots remain.'); };
  const mergeSelected = () => { const items=batchItems();if(items.length<2){setMessage('Select at least two existing blocks to merge.');return;}const roleSetValues=new Set(items.map(item=>item.role));const role=roleSetValues.size===1?items[0].role:state.currentRole;if((role==='header'||role==='footer')&&state.selections.some(item=>!state.batchSelections.has(item)&&item.role===role)){setMessage('Cannot merge as '+role+': another '+role+' block already exists.');return;}const roots=items.flatMap(item=>item.els).sort((a,b)=>boxOf(a).y-boxOf(b).y||boxOf(a).x-boxOf(b).x);const label=clean($('label').value,160)||items[0].label||headingOf(roots[0])||'Merged block';const merged={els:roots,role,label};state.selections=state.selections.filter(item=>!state.batchSelections.has(item));state.selections.push(merged);clearBatch();state.activeSelection=merged;roleSet(role);$('label').value=label;resumeInspect('Merged '+items.length+' blocks into "'+label+'" ('+roots.length+' roots). Inspecting the next region.'); };
  const deleteSelected = () => { const items=batchItems();if(!items.length){setMessage('Select blocks to delete.');return;}const count=items.length;state.selections=state.selections.filter(item=>!state.batchSelections.has(item));if(state.activeSelection&&items.includes(state.activeSelection))state.activeSelection=null;if(state.current&&items.some(item=>item.els.includes(state.current)))state.current=null;clearBatch();resumeInspect('Deleted '+count+' selected block'+(count===1?'':'s')+'. Inspecting the next region.'); };
  const ungroupSelected = () => { const items=batchItems();if(items.length!==1){setMessage('Select one grouped block to ungroup.');return;}const item=items[0];if(item.els.length<2){setMessage('The selected block has only one root.');return;}if(item.role==='header'||item.role==='footer'){setMessage('Header/Footer groups cannot be ungrouped because only one shell block per role is allowed.');return;}const index=state.selections.indexOf(item);const parts=item.els.map((el,partIndex)=>({els:[el],role:item.role,label:headingOf(el)||(partIndex===0?item.label:(item.label||'Block')+' '+(partIndex+1))}));state.selections.splice(index,1,...parts);clearBatch();state.activeSelection=parts[0]||null;resumeInspect('Ungrouped "'+(item.label||'block')+'" into '+parts.length+' blocks. Inspecting the next region.'); };
  const nav = (kind) => { const base=state.current||state.hover;if(!base)return; const baseOwner=selectionFor(base); const next=kind==='parent'?eligibleParent(base):kind==='child'?eligibleChild(base):kind==='prev'?eligibleSibling(base,-1):eligibleSibling(base,1);if(next){state.current=next;state.hover=null;const existing=selectionFor(next);if(existing){state.activeSelection=existing;state.editingSelection=existing;state.editingRoot=next;roleSet(existing.role);$('label').value=existing.label||'';}else{if(baseOwner){state.activeSelection=baseOwner;state.editingSelection=baseOwner;state.editingRoot=base;}if(state.editingSelection){roleSet(state.editingSelection.role);$('label').value=state.editingSelection.label||headingOf(state.editingRoot)||'';}else{$('label').value=headingOf(next);roleSet(next.tagName.toLowerCase()==='header'?'header':next.tagName.toLowerCase()==='footer'?'footer':'section');}}render();}else setMessage('No eligible '+kind+' region.'); };
  const rootPayload = (el) => { const evidence=evidenceOf(el);return {selector:evidence.selector,tag:evidence.tag,fingerprint:fingerprintOf(el,evidence),evidence}; };
  const save = () => { if(state.selections.length===0){setMessage('Select at least one production block.');return;} const segments=state.selections.map(item=>({role:item.role,label:item.label||headingOf(item.els[0])||'',roots:item.els.map(rootPayload)})); const payload={observedUrl:location.href,viewport:{width:innerWidth,height:innerHeight},segments}; $('save').disabled=true;setMessage('Saving DOM blocks...'); try{window.sitespecSegmentSave(JSON.stringify(payload));}catch(error){$('save').disabled=false;setMessage('Save failed: '+String(error&&error.message||error));} };
  const reload = () => { const selections=state.selections.map(item=>({role:item.role,label:item.label||'',selectors:item.els.map(selectorFor)})); const payload={selections,ui:panelUi()}; $('reload').disabled=true;setMessage('Reloading production page...'); try{window.sitespecSegmentReload(JSON.stringify(payload));}catch(error){$('reload').disabled=false;setMessage('Reload failed: '+String(error&&error.message||error));} };

  const drag = { active:false, pointerId:null, dx:0, dy:0 };
  head.addEventListener('pointerdown',(event)=>{if(event.button!==0||event.target.closest('button,input'))return;const r=panel.getBoundingClientRect();drag.active=true;drag.pointerId=event.pointerId;drag.dx=event.clientX-r.left;drag.dy=event.clientY-r.top;panel.style.left=r.left+'px';panel.style.top=r.top+'px';panel.style.right='auto';head.setPointerCapture?.(event.pointerId);event.preventDefault();});
  head.addEventListener('pointermove',(event)=>{if(!drag.active||event.pointerId!==drag.pointerId)return;positionPanel(event.clientX-drag.dx,event.clientY-drag.dy);});
  const stopDrag = (event) => { if(!drag.active||event.pointerId!==drag.pointerId)return;drag.active=false;try{head.releasePointerCapture?.(event.pointerId);}catch{} };
  head.addEventListener('pointerup',stopDrag);head.addEventListener('pointercancel',stopDrag);

  const regionAtPoint = (x,y) => { const stack=document.elementsFromPoint(x,y); for(const element of stack){ if(element===host)continue; const region=regionFrom(element); if(region)return region; } return null; };
  catcher.addEventListener('pointermove',(event)=>{state.mouseX=event.clientX;state.mouseY=event.clientY;if(state.mode!=='inspect'||state.current)return;const next=regionAtPoint(event.clientX,event.clientY);if(next!==state.hover){state.hover=next;render();}});
  catcher.addEventListener('click',(event)=>{if(state.mode!=='inspect')return;event.preventDefault();event.stopPropagation();const next=regionAtPoint(event.clientX,event.clientY);if(next)setCurrent(next,true);});
  document.addEventListener('click',(event)=>{if(state.mode!=='interact'||host.contains(event.target))return;const link=event.target instanceof Element?event.target.closest('a[href]'):null;if(link){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();setMessage('Navigation is disabled during segmentation; Interact mode is for controls on this audited page.');}},true);
  document.addEventListener('submit',(event)=>{if(state.mode==='interact'){event.preventDefault();event.stopPropagation();setMessage('Form navigation is disabled during segmentation.');}},true);
  document.addEventListener('keydown',(event)=>{const active=shadow.activeElement;if(active&&active.tagName==='INPUT')return;if(event.key.toLowerCase()==='p'){event.preventDefault();toggleMode();return;}if(state.mode!=='inspect')return;const map={h:'header',f:'footer',i:'ignore',s:'section'};if(map[event.key.toLowerCase()]){event.preventDefault();roleSet(map[event.key.toLowerCase()]);return;}if(event.key.toLowerCase()==='g'){event.preventDefault();addRootCurrent();return;}if(event.key.toLowerCase()==='m'){event.preventDefault();mergeSelected();return;}if(event.key==='ArrowUp'){event.preventDefault();nav('parent');}else if(event.key==='ArrowDown'){event.preventDefault();nav('child');}else if(event.key==='ArrowLeft'){event.preventDefault();nav('prev');}else if(event.key==='ArrowRight'){event.preventDefault();nav('next');}else if(event.key==='Enter'){event.preventDefault();addCurrent();}else if(event.key==='Escape'){event.preventDefault();state.current=null;state.editingSelection=null;state.editingRoot=null;setMessage('Unlocked.');render();}},true);
  window.addEventListener('scroll',render,{passive:true});window.addEventListener('resize',()=>{const r=panel.getBoundingClientRect();positionPanel(r.left,r.top);render();},{passive:true});
  $('mode').addEventListener('click',toggleMode);$('reload').addEventListener('click',reload);$('collapse').addEventListener('click',()=>setCollapsed(!state.collapsed));$('parent').addEventListener('click',()=>nav('parent'));$('child').addEventListener('click',()=>nav('child'));$('prev').addEventListener('click',()=>nav('prev'));$('next').addEventListener('click',()=>nav('next'));$('add').addEventListener('click',addCurrent);$('add-root').addEventListener('click',addRootCurrent);$('remove-root').addEventListener('click',removeCurrentRoot);$('merge-selected').addEventListener('click',mergeSelected);$('ungroup-selected').addEventListener('click',ungroupSelected);$('delete-selected').addEventListener('click',deleteSelected);$('cancel-selected').addEventListener('click',()=>{clearBatch();setMessage('Block selection cleared.');render();});$('unlock').addEventListener('click',()=>{state.current=null;state.editingSelection=null;state.editingRoot=null;render();});$('save').addEventListener('click',save);shadow.querySelectorAll('[data-role]').forEach(btn=>btn.addEventListener('click',()=>roleSet(btn.dataset.role)));
  $('label').addEventListener('input',()=>{if(state.batchSelections.size>=2)return;const el=state.current;if(!el)return;const owner=selectionFor(el);if(!owner)return;owner.label=clean($('label').value,160);state.activeSelection=owner;render();});
  $('label').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();addCurrent();}});
  const restoredRoots=new Set();
  for(const saved of INITIAL){try{const selectors=Array.isArray(saved.selectors)?saved.selectors:typeof saved.selector==='string'?[saved.selector]:[];const els=selectors.map(selector=>document.querySelector(selector)).filter(el=>eligible(el)&&!restoredRoots.has(el));if(!els.length)continue;els.forEach(el=>restoredRoots.add(el));state.selections.push({els,role:ROLE_LABELS[saved.role]?saved.role:'section',label:saved.label||headingOf(els[0])});}catch{}}
  state.selections.sort((a,b)=>blockBox(a).y-blockBox(b).y);
  if(Number.isFinite(INITIAL_UI.left)&&Number.isFinite(INITIAL_UI.top)) positionPanel(Number(INITIAL_UI.left),Number(INITIAL_UI.top));
  setCollapsed(state.collapsed);
  render();
  window.__sitespecSegmentPicker={destroy(){host.remove();},state};
  return {ready:true,restored:state.selections.length,url:location.href};
})()`;
}

async function writeArtifact(loaded: LoadedSegmentAudit, artifact: SegmentArtifact): Promise<void> {
  await writeFile(join(loaded.root, "segments.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const audit = { ...loaded.audit };
  const files = isRecord(audit.files) ? { ...audit.files } : {};
  files.segments = "segments.json";
  audit.files = files;
  const summary = isRecord(audit.summary) ? { ...audit.summary } : {};
  summary.manualSegments = artifact.segments.length;
  summary.manualDomSegments = artifact.segments.length;
  audit.summary = summary;
  await writeFile(join(loaded.root, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
}

async function navigatePicker(client: CdpClient, url: string, timeoutMs: number): Promise<string> {
  await Promise.all([
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Network.enable")
  ]);
  await client.send("Page.setBypassCSP", { enabled: true });
  const load = client.waitForEvent("Page.loadEventFired", timeoutMs);
  const response = await client.send<{ errorText?: string }>("Page.navigate", { url });
  if (response.errorText) throw new MigrateSegmentError("MIGRATE_SEGMENT_NAVIGATION_FAILED", `Chrome could not navigate to ${url}: ${response.errorText}`);
  await load;
  await new Promise(resolveWait => setTimeout(resolveWait, 350));
  return evaluate<string>(client, "location.href");
}

function normalizePickerReloadPayload(raw: unknown): PickerReloadPayload {
  if (!isRecord(raw)) return { selections: [], ui: {} };
  const roles = new Set<SegmentRole>(["section", "header", "footer", "ignore"]);
  const selections = Array.isArray(raw.selections)
    ? raw.selections.filter(isRecord).slice(0, 100).flatMap(item => {
      const role = roles.has(item.role as SegmentRole) ? item.role as SegmentRole : "section";
      const selectors = Array.isArray(item.selectors)
        ? normalizeStringArray(item.selectors, 24)
        : typeof item.selector === "string" && item.selector.trim() ? [item.selector.trim()] : [];
      if (!selectors.length) return [];
      return [{ role, label: typeof item.label === "string" ? item.label.replace(/\s+/g, " ").trim().slice(0, 160) : "", selectors: [...new Set(selectors)] }];
    })
    : [];
  const rawUi = isRecord(raw.ui) ? raw.ui : {};
  const left = asFiniteNumber(rawUi.left);
  const top = asFiniteNumber(rawUi.top);
  return {
    selections,
    ui: {
      left: left === undefined ? undefined : Math.round(left),
      top: top === undefined ? undefined : Math.round(top),
      collapsed: Boolean(rawUi.collapsed)
    }
  };
}

async function waitForPickerAction(client: CdpClient, timeoutMs: number): Promise<PickerAction> {
  const event = await client.waitForEvent<{ name?: string; payload?: string }>(
    "Runtime.bindingCalled",
    timeoutMs,
    params => params.name === "sitespecSegmentSave" || params.name === "sitespecSegmentReload"
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload ?? "");
  } catch {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_PAYLOAD_INVALID", "Live picker returned malformed JSON.");
  }
  if (event.name === "sitespecSegmentReload") return { type: "reload", payload: normalizePickerReloadPayload(parsed) };
  return { type: "save", payload: parsed as PickerSavePayload };
}

async function runLivePicker(loaded: LoadedSegmentAudit, browserPath: string, timeoutMs: number, onReady?: (url: string) => void): Promise<{ artifact: SegmentArtifact; observedUrl: string }> {
  let browser: LaunchedChrome | undefined;
  let client: CdpClient | undefined;
  try {
    browser = await launchChrome(browserPath, timeoutMs, { headless: false, windowSize: { width: loaded.viewport.width, height: Math.max(720, loaded.viewport.height) } });
    client = await createPageClient(browser.port, timeoutMs);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: loaded.viewport.width,
      height: Math.max(720, loaded.viewport.height),
      deviceScaleFactor: 1,
      mobile: false
    });
    await Promise.all([
      client.send("Runtime.addBinding", { name: "sitespecSegmentSave" }),
      client.send("Runtime.addBinding", { name: "sitespecSegmentReload" })
    ]);
    const observedUrl = await navigatePicker(client, loaded.sourceUrl, timeoutMs);
    let selections = previousSelections(loaded.existing);
    let ui: PickerUiState = {};
    const inject = async (): Promise<void> => {
      const ready = await evaluate<{ ready?: boolean }>(client!, livePickerExpression(selections, ui));
      if (!ready?.ready) throw new MigrateSegmentError("MIGRATE_SEGMENT_PICKER_INJECT_FAILED", "Could not initialize the live DOM picker in the production page.");
      await client!.send("Page.bringToFront");
    };
    await inject();
    onReady?.(observedUrl);

    while (true) {
      const action = await waitForPickerAction(client, 12 * 60 * 60 * 1000);
      if (action.type === "save") {
        const artifact = buildDomSegmentArtifact(loaded.sourceUrl, action.payload);
        return { artifact, observedUrl: artifact.observedUrl };
      }

      selections = action.payload.selections;
      ui = action.payload.ui;
      const load = client.waitForEvent("Page.loadEventFired", timeoutMs);
      await client.send("Page.reload");
      await load;
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
      await inject();
    }
  } catch (error) {
    if (error instanceof MigrateSegmentError) throw error;
    throw new MigrateSegmentError("MIGRATE_SEGMENT_BROWSER_FAILED", error instanceof Error ? error.message : String(error), { browserPath });
  } finally {
    client?.close();
    if (browser) await closeChrome(browser);
  }
}

export async function segmentAudit(options: MigrateSegmentOptions): Promise<MigrateSegmentResult> {
  const root = resolve(options.root ?? ".");
  const timeoutMs = Math.max(5_000, Math.min(120_000, Math.round(options.timeoutMs ?? 30_000)));
  const loaded = await loadSegmentAudit(options.audit, root);
  let browserPath: string;
  try {
    browserPath = await findAuditBrowser(options.browserPath);
  } catch (error) {
    throw new MigrateSegmentError("MIGRATE_SEGMENT_BROWSER_NOT_FOUND", error instanceof Error ? error.message : String(error), {
      browserPath: options.browserPath,
      environmentVariable: "SITESPEC_CHROME_PATH"
    });
  }
  const { artifact, observedUrl } = await runLivePicker(loaded, browserPath, timeoutMs, options.onReady);
  await writeArtifact(loaded, artifact);
  return {
    sourceUrl: loaded.sourceUrl,
    observedUrl,
    audit: loaded.root,
    output: join(loaded.root, "segments.json"),
    browser: browserPath,
    summary: {
      segments: artifact.segments.length,
      sections: artifact.segments.filter(item => item.role === "section").length,
      ignored: artifact.segments.filter(item => item.role === "ignore").length,
      header: artifact.segments.some(item => item.role === "header"),
      footer: artifact.segments.some(item => item.role === "footer")
    }
  };
}

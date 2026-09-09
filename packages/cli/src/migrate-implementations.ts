import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AuditLeafUiObservation, AuditLayoutNode } from "./migrate-audit.js";
import type { ComponentFamilyProposal } from "./migrate-design.js";
import type { UiFamilyProposal } from "./migrate-ui.js";

export interface InferImplementationsOptions {
  analysis: string;
  root?: string;
  output?: string;
}

export interface ImplementationInferenceResult {
  site: string;
  status: "ready" | "partial" | "blocked";
  phase: "implementation-inference";
  output: string;
  report: string;
  files: string[];
  blockers: string[];
  warnings: string[];
  summary: {
    uiImplementations: number;
    sectionImplementations: number;
    shellImplementations: number;
    semanticTokenExtensions: number;
    evidenceBackedStyles: number;
    fallbackStyles: number;
  };
}

export class MigrateImplementationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateImplementationError";
    this.code = code;
    this.details = details;
  }
}

type Json = Record<string, unknown>;

type ContractReport = {
  type: string;
  version: string;
  status: string;
  site: string;
  source?: { review?: string; reviewSha256?: string; proposal?: string; proposalSha256?: string };
  contracts?: Array<Record<string, unknown>>;
  packs?: Array<Record<string, unknown>>;
  output?: string;
};

type DesignReport = {
  type?: string;
  site?: string;
  audits?: Array<{ sourceUrl?: string; path?: string }>;
};

type AuditEvidence = {
  page: string;
  sourceUrl: string;
  root: string;
  sources: Array<{ file: string; sha256: string }>;
  ui: Array<AuditLeafUiObservation & { viewport?: string }>;
  sections: {
    items?: Array<Record<string, unknown>>;
    viewports?: Record<string, { items?: Array<Record<string, unknown>> }>;
    manualRegions?: Record<string, { items?: Array<Record<string, unknown>> }>;
  };
};

type TokenLeaf = {
  path: string;
  layer: "primitive" | "semantic";
  type?: string;
  value?: string | number;
  alias?: string;
  resolved?: string | number;
};

type Dominant = { value?: string; confidence: number; count: number; total: number };

type StyleProfile = {
  display?: Dominant;
  position?: Dominant;
  color?: Dominant;
  backgroundColor?: Dominant;
  borderTopWidth?: Dominant;
  borderTopColor?: Dominant;
  borderRadius?: Dominant;
  paddingTop?: Dominant;
  paddingRight?: Dominant;
  paddingBottom?: Dominant;
  paddingLeft?: Dominant;
  gap?: Dominant;
  gridTemplateColumns?: Dominant;
  flexDirection?: Dominant;
  alignItems?: Dominant;
  justifyContent?: Dominant;
  fontFamily?: Dominant;
  fontSize?: Dominant;
  fontWeight?: Dominant;
  lineHeight?: Dominant;
  letterSpacing?: Dominant;
  textDecorationLine?: Dominant;
  boxShadow?: Dominant;
};

const OUTPUT_MARKER = ".sitespec-implementation-inference.json";
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function relativeOrAbsolute(from: string, to: string): string {
  const value = relative(from, to);
  return value && !value.startsWith("..") && !isAbsolute(value) ? slash(value) : slash(to);
}

function parseJson<T>(raw: string, file: string, code: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new MigrateImplementationError(code, `Could not parse ${file}.`, { file }); }
}

async function readRequiredJson<T>(file: string, code: string): Promise<{ raw: string; value: T }> {
  if (!(await exists(file))) throw new MigrateImplementationError(code, `Required migration artifact not found: ${file}`, { file });
  const raw = await readFile(file, "utf8");
  return { raw, value: parseJson<T>(raw, file, code) };
}

async function prepareOutput(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length === 0) return;
    try {
      const marker = parseJson<{ type?: string }>(await readFile(join(output, OUTPUT_MARKER), "utf8"), join(output, OUTPUT_MARKER), "MIGRATE_IMPLEMENTATIONS_OUTPUT_NOT_OWNED");
      if (marker.type === "sitespec-migrate-implementation-output") {
        await rm(output, { recursive: true, force: true });
        return;
      }
    } catch (error) {
      if (error instanceof MigrateImplementationError && error.code !== "MIGRATE_IMPLEMENTATIONS_OUTPUT_NOT_OWNED") throw error;
    }
    throw new MigrateImplementationError("MIGRATE_IMPLEMENTATIONS_OUTPUT_NOT_OWNED", `Implementation output directory is not empty and is not owned by a previous migration run: ${output}`, { output });
  } catch (error) {
    if (error instanceof MigrateImplementationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function getAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setAt(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isRecord(next)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function tokenLeaves(tokens: unknown): TokenLeaf[] {
  const out: TokenLeaf[] = [];
  const walk = (layer: "primitive" | "semantic", value: unknown, path: string[]): void => {
    if (!isRecord(value)) return;
    if ("$value" in value) {
      const raw = value.$value;
      const alias = typeof raw === "string" ? raw.match(/^\{([^}]+)\}$/)?.[1] : undefined;
      out.push({ path: path.join("."), layer, type: typeof value.$type === "string" ? value.$type : undefined, value: typeof raw === "string" || typeof raw === "number" ? raw : undefined, alias });
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(layer, child, [...path, key]);
  };
  if (isRecord(tokens) && isRecord(tokens.primitive)) walk("primitive", tokens.primitive, ["primitive"]);
  if (isRecord(tokens) && isRecord(tokens.semantic)) walk("semantic", tokens.semantic, ["semantic"]);
  const byPath = new Map(out.map(item => [item.path, item]));
  const resolveLeaf = (leaf: TokenLeaf, seen = new Set<string>()): string | number | undefined => {
    if (!leaf.alias) return leaf.value;
    if (seen.has(leaf.path)) return undefined;
    seen.add(leaf.path);
    const target = byPath.get(leaf.alias);
    return target ? resolveLeaf(target, seen) : undefined;
  };
  for (const leaf of out) leaf.resolved = resolveLeaf(leaf);
  return out;
}

function cssName(path: string): string {
  const parts = path.split(".");
  if (parts[0] === "semantic") parts.shift();
  return parts.join("-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").toLowerCase();
}

function cssVar(path: string): string {
  return `var(--${cssName(path)})`;
}

function colorHex(value: string): string | undefined {
  const raw = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(raw);
  if (hex) {
    const part = hex[1]!;
    if (part.length === 3) return `#${part.split("").map(char => `${char}${char}`).join("")}`;
    return `#${part.slice(0, 6)}`;
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(raw);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) === 0)) return undefined;
  const channel = (value: string) => Math.max(0, Math.min(255, Math.round(Number(value)))).toString(16).padStart(2, "0");
  return `#${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}`;
}

function normalizedTokenValue(type: string | undefined, value: string | number | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  if (type === "color" && typeof value === "string") return colorHex(value) ?? value.trim().toLowerCase();
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  return value;
}

function findPrimitive(leaves: TokenLeaf[], type: string, observed: string | number | undefined): TokenLeaf | undefined {
  const normalized = normalizedTokenValue(type, observed);
  if (normalized === undefined) return undefined;
  return leaves.find(leaf => leaf.layer === "primitive" && leaf.type === type && normalizedTokenValue(type, leaf.resolved) === normalized);
}

function findSemantic(leaves: TokenLeaf[], type: string, observed: string | number | undefined, preferred: string[] = []): TokenLeaf | undefined {
  const normalized = normalizedTokenValue(type, observed);
  if (normalized === undefined) return undefined;
  const candidates = leaves.filter(leaf => leaf.layer === "semantic" && leaf.type === type && normalizedTokenValue(type, leaf.resolved) === normalized);
  return candidates.sort((left, right) => {
    const score = (item: TokenLeaf) => preferred.findIndex(prefix => item.path.startsWith(prefix));
    const a = score(left); const b = score(right);
    return (a < 0 ? 999 : a) - (b < 0 ? 999 : b) || left.path.localeCompare(right.path);
  })[0];
}

function dominant(values: Array<string | undefined>): Dominant {
  const filtered = values.map(value => value?.trim()).filter((value): value is string => Boolean(value));
  if (filtered.length === 0) return { confidence: 0, count: 0, total: 0 };
  const counts = new Map<string, number>();
  for (const value of filtered) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  return { value, count, total: filtered.length, confidence: Math.round((count / filtered.length) * 1000) / 1000 };
}

function styleProfile(styles: Array<Record<string, unknown> | undefined>): StyleProfile {
  const field = (name: string): Dominant => dominant(styles.map(style => typeof style?.[name] === "string" ? style[name] as string : undefined));
  return {
    display: field("display"), position: field("position"), color: field("color"), backgroundColor: field("backgroundColor"),
    borderTopWidth: field("borderTopWidth"), borderTopColor: field("borderTopColor"), borderRadius: field("borderRadius"),
    paddingTop: field("paddingTop"), paddingRight: field("paddingRight"), paddingBottom: field("paddingBottom"), paddingLeft: field("paddingLeft"),
    gap: field("gap"), gridTemplateColumns: field("gridTemplateColumns"), flexDirection: field("flexDirection"), alignItems: field("alignItems"), justifyContent: field("justifyContent"),
    fontFamily: field("fontFamily"), fontSize: field("fontSize"), fontWeight: field("fontWeight"), lineHeight: field("lineHeight"), letterSpacing: field("letterSpacing"),
    textDecorationLine: field("textDecorationLine"), boxShadow: field("boxShadow")
  };
}

function buttonVariant(item: AuditLeafUiObservation): string {
  const px = (value: string | undefined): number => Number.parseFloat(value ?? "0") || 0;
  const transparent = (value: string | undefined): boolean => !value || value === "transparent" || value === "rgba(0, 0, 0, 0)" || value === "rgba(0,0,0,0)";
  if (!transparent(item.style.backgroundColor)) return "solid";
  if (px(item.style.borderTopWidth) > 0) return "outline";
  return "ghost";
}

function familyForKind(kind: string): string {
  if (kind === "button") return "button";
  if (kind === "link") return "link";
  if (kind === "input") return "text-input";
  if (kind === "textarea") return "textarea";
  if (kind === "select") return "select";
  if (kind === "checkbox" || kind === "radio") return "choice";
  if (kind === "badge-candidate") return "badge";
  return "card";
}

function pageId(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return url.pathname === "/" ? "home" : url.pathname.split("/").filter(Boolean).join("-").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
  } catch { return "page"; }
}

async function loadAuditEvidence(root: string, report: DesignReport): Promise<AuditEvidence[]> {
  const out: AuditEvidence[] = [];
  for (const audit of report.audits ?? []) {
    if (!audit.path || !audit.sourceUrl) continue;
    const auditRoot = isAbsolute(audit.path) ? audit.path : resolve(root, audit.path);
    const uiFile = join(auditRoot, "ui-inventory.json");
    const sectionsFile = join(auditRoot, "sections.json");
    const sources: Array<{ file: string; sha256: string }> = [];
    let ui: { items?: Array<AuditLeafUiObservation & { viewport?: string }> } = {};
    if (await exists(uiFile)) {
      const raw = await readFile(uiFile, "utf8");
      ui = parseJson(raw, uiFile, "MIGRATE_IMPLEMENTATIONS_AUDIT_INVALID");
      sources.push({ file: uiFile, sha256: sha256(raw) });
    }
    let sections: AuditEvidence["sections"] = {};
    if (await exists(sectionsFile)) {
      const raw = await readFile(sectionsFile, "utf8");
      sections = parseJson(raw, sectionsFile, "MIGRATE_IMPLEMENTATIONS_AUDIT_INVALID");
      sources.push({ file: sectionsFile, sha256: sha256(raw) });
    }
    out.push({ page: pageId(audit.sourceUrl), sourceUrl: audit.sourceUrl, root: auditRoot, sources, ui: ui.items ?? [], sections });
  }
  return out;
}

function auditForMember(audits: AuditEvidence[], member: { page?: string; sourceUrl?: string }): AuditEvidence | undefined {
  return audits.find(audit => member.sourceUrl && audit.sourceUrl === member.sourceUrl)
    ?? audits.find(audit => member.page && audit.page === member.page);
}

function sectionNodesForFamily(family: ComponentFamilyProposal, audits: AuditEvidence[]): Array<{ viewport: string; node: AuditLayoutNode }> {
  const nodes: Array<{ viewport: string; node: AuditLayoutNode }> = [];
  for (const member of family.members) {
    const audit = auditForMember(audits, member);
    if (!audit) continue;
    let matchedManual = false;
    for (const [viewport, collection] of Object.entries(audit.sections.manualRegions ?? {})) {
      const matches = (collection.items ?? []).filter(item => isRecord(item) && item.segmentId === member.auditId);
      if (matches.length === 0) continue;
      matchedManual = true;
      const boundary = matches.find(item => isRecord(item.boundary))?.boundary;
      const item = boundary ?? matches[0]?.item;
      if (isRecord(item) && isRecord(item.box)) nodes.push({ viewport, node: item as unknown as AuditLayoutNode });
    }
    if (matchedManual) continue;
    for (const [viewport, collection] of Object.entries(audit.sections.viewports ?? {})) {
      const item = (collection.items ?? []).find(section => isRecord(section) && section.auditId === member.auditId);
      if (isRecord(item) && isRecord(item.box)) nodes.push({ viewport, node: item as unknown as AuditLayoutNode });
    }
  }
  return nodes;
}

function semanticExists(tokens: unknown, path: string): boolean {
  return getAt(tokens, path.split(".")) !== undefined;
}

function extensionLeaf(type: string, primitivePath: string, source: string, reason: string): Record<string, unknown> {
  return {
    $type: type,
    $value: `{${primitivePath}}`,
    $extensions: {
      "org.sitespec.migration": {
        status: "derived",
        source,
        reason
      }
    }
  };
}

function addSemanticAlias(
  extension: Record<string, unknown>,
  baseTokens: unknown,
  path: string,
  primitive: TokenLeaf | undefined,
  type: string,
  source: string,
  reason: string,
  additions: Array<{ path: string; primitive: string; source: string; reason: string }>
): boolean {
  if (!primitive || semanticExists(baseTokens, path)) return false;
  setAt(extension, path.split(".").slice(1), extensionLeaf(type, primitive.path, source, reason));
  additions.push({ path, primitive: primitive.path, source, reason });
  return true;
}

function primitiveByPath(leaves: TokenLeaf[], path: string | undefined): TokenLeaf | undefined {
  return path ? leaves.find(item => item.path === path && item.layer === "primitive") : undefined;
}

function aliasPrimitiveForSemantic(leaves: TokenLeaf[], path: string): TokenLeaf | undefined {
  const semantic = leaves.find(item => item.path === path && item.layer === "semantic");
  return semantic?.alias ? primitiveByPath(leaves, semantic.alias) : undefined;
}

function numericDimension(leaves: TokenLeaf[], prefix: string): TokenLeaf[] {
  return leaves.filter(item => item.layer === "primitive" && item.type === "dimension" && item.path.startsWith(prefix) && typeof item.resolved === "string" && /^-?\d+(?:\.\d+)?px$/i.test(item.resolved))
    .sort((a, b) => Number.parseFloat(a.resolved as string) - Number.parseFloat(b.resolved as string));
}

function buildTokenExtension(
  baseTokens: Json,
  leaves: TokenLeaf[],
  uiObservations: AuditLeafUiObservation[],
): { extension: Record<string, unknown>; additions: Array<{ path: string; primitive: string; source: string; reason: string }> } {
  const extension: Record<string, unknown> = { semantic: {} };
  const additions: Array<{ path: string; primitive: string; source: string; reason: string }> = [];
  const buttons = uiObservations.filter(item => familyForKind(item.kind) === "button");
  const solid = buttons.filter(item => buttonVariant(item) === "solid");
  const borderItems = buttons.filter(item => Number.parseFloat(item.style.borderTopWidth ?? "0") > 0);
  const controlX = dominant(buttons.flatMap(item => [item.style.paddingLeft, item.style.paddingRight]));
  const controlY = dominant(buttons.flatMap(item => [item.style.paddingTop, item.style.paddingBottom]));
  const controlRadius = dominant(buttons.map(item => item.style.borderRadius));
  const contrast = dominant(solid.map(item => item.style.color));
  const border = dominant(borderItems.map(item => item.style.borderTopColor));

  const spaces = numericDimension(leaves, "primitive.space.").filter(item => !item.path.endsWith(".page") && !item.path.endsWith(".section"));
  const radii = numericDimension(leaves, "primitive.radius.");
  const colorPrimitives = leaves.filter(item => item.layer === "primitive" && item.type === "color");
  const white = colorPrimitives.find(item => normalizedTokenValue("color", item.resolved) === "#ffffff");
  const neutralBorderFallback = aliasPrimitiveForSemantic(leaves, "semantic.color.text.subtle") ?? colorPrimitives.find(item => item.path.includes("neutral"));
  const controlXPrimitive = findPrimitive(leaves, "dimension", controlX.value) ?? spaces[Math.min(4, Math.max(0, spaces.length - 1))];
  const controlYPrimitive = findPrimitive(leaves, "dimension", controlY.value) ?? spaces[Math.min(2, Math.max(0, spaces.length - 1))];
  const radiusPrimitive = findPrimitive(leaves, "dimension", controlRadius.value) ?? radii[0];
  addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, "semantic.space.control.x", controlXPrimitive, "dimension", controlX.value ? "leaf-ui:button" : "foundation-core-spacing-scale", controlX.value ? `Dominant horizontal button padding (${controlX.value}, confidence ${controlX.confidence}).` : "No stable button padding was available; use a conservative value from the accepted primitive spacing scale.", additions);
  addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, "semantic.space.control.y", controlYPrimitive, "dimension", controlY.value ? "leaf-ui:button" : "foundation-core-spacing-scale", controlY.value ? `Dominant vertical button padding (${controlY.value}, confidence ${controlY.confidence}).` : "No stable button padding was available; use a conservative value from the accepted primitive spacing scale.", additions);
  addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, "semantic.radius.control", radiusPrimitive, "dimension", controlRadius.value ? "leaf-ui:button" : "foundation-radius-scale", controlRadius.value ? `Dominant button radius (${controlRadius.value}, confidence ${controlRadius.confidence}).` : "No stable control radius was available; use the smallest accepted radius primitive.", additions);
  addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, "semantic.color.accent.contrast", findPrimitive(leaves, "color", contrast.value) ?? white, "color", contrast.value ? "leaf-ui:button-solid" : "foundation-color-fallback", contrast.value ? `Dominant solid-button foreground (${contrast.value}, confidence ${contrast.confidence}).` : "No stable solid-button foreground was available; use the accepted white primitive as accent contrast.", additions);
  addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, "semantic.color.border.default", findPrimitive(leaves, "color", border.value) ?? neutralBorderFallback, "color", border.value ? "leaf-ui:border" : "foundation-fallback", border.value ? `Dominant visible control border (${border.value}, confidence ${border.confidence}).` : "No stable control border color was observed; reuse an accepted neutral primitive as a conservative border fallback.", additions);

  const picks = spaces.length >= 5
    ? [spaces[1], spaces[Math.min(2, spaces.length - 1)], spaces[Math.min(3, spaces.length - 1)], spaces[Math.min(5, spaces.length - 1)], spaces[Math.min(7, spaces.length - 1)]]
    : spaces;
  const stackNames = ["sm", "md", "lg", "xl", "2xl"];
  for (let index = 0; index < Math.min(picks.length, stackNames.length); index += 1) {
    addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, `semantic.space.stack.${stackNames[index]}`, picks[index], "dimension", "foundation-core-spacing-scale", `Implementation spacing role derived from the accepted primitive spacing scale; no new primitive value is introduced.`, additions);
  }

  const typographyMap = [
    ["semantic.font.family.body", "semantic.font.role.text.md.default.family", "fontFamily"],
    ["semantic.font.family.heading", "semantic.font.role.heading.32.compact-tracked.family", "fontFamily"],
    ["semantic.font.size.small", "semantic.font.role.text.sm.default.size", "dimension"],
    ["semantic.font.size.body", "semantic.font.role.text.md.default.size", "dimension"],
    ["semantic.font.size.lead", "semantic.font.role.text.lg.default.size", "dimension"],
    ["semantic.font.size.heading", "semantic.font.role.heading.32.compact-tracked.size", "dimension"],
    ["semantic.font.size.display", "semantic.font.role.display.64.compact-tracked.size", "dimension"],
    ["semantic.font.lineHeight.body", "semantic.font.role.text.md.default.lineHeight", "number"],
    ["semantic.font.lineHeight.lead", "semantic.font.role.text.lg.default.lineHeight", "number"],
    ["semantic.font.lineHeight.heading", "semantic.font.role.heading.32.compact-tracked.lineHeight", "number"],
    ["semantic.font.lineHeight.display", "semantic.font.role.display.64.compact-tracked.lineHeight", "number"]
  ] as const;
  const fontFamilies = leaves.filter(item => item.layer === "primitive" && item.type === "fontFamily");
  const fontSizes = numericDimension(leaves, "primitive.font.size.");
  const lineHeights = leaves.filter(item => item.layer === "primitive" && item.type === "number" && item.path.startsWith("primitive.font.lineHeight.")).sort((a, b) => Number(a.resolved ?? 0) - Number(b.resolved ?? 0));
  const typographyFallback = new Map<string, TokenLeaf | undefined>([
    ["semantic.font.family.body", fontFamilies[0]],
    ["semantic.font.family.heading", fontFamilies[0]],
    ["semantic.font.size.small", fontSizes[0]],
    ["semantic.font.size.body", fontSizes[Math.min(1, Math.max(0, fontSizes.length - 1))]],
    ["semantic.font.size.lead", fontSizes[Math.min(2, Math.max(0, fontSizes.length - 1))]],
    ["semantic.font.size.heading", fontSizes[Math.max(0, fontSizes.length - 2)]],
    ["semantic.font.size.display", fontSizes.at(-1)],
    ["semantic.font.lineHeight.body", lineHeights.at(-1)],
    ["semantic.font.lineHeight.lead", lineHeights.at(-1)],
    ["semantic.font.lineHeight.heading", lineHeights[0]],
    ["semantic.font.lineHeight.display", lineHeights[0]]
  ]);
  for (const [target, sourceSemantic, type] of typographyMap) {
    const primitive = aliasPrimitiveForSemantic(leaves, sourceSemantic) ?? typographyFallback.get(target);
    addSemanticAlias(extension.semantic as Record<string, unknown>, baseTokens, target, primitive, type, primitive && aliasPrimitiveForSemantic(leaves, sourceSemantic) ? "foundation-typography-role" : "foundation-typography-scale", primitive && aliasPrimitiveForSemantic(leaves, sourceSemantic) ? `Convenience implementation role derived from accepted ${sourceSemantic}; no typography value is invented.` : "Convenience implementation role derived from the accepted primitive typography scale because the named role was not present.", additions);
  }
  return { extension, additions };
}

function tokenColor(leaves: TokenLeaf[], value: string | undefined, preferred: string[]): string | undefined {
  if (!value) return undefined;
  if (value === "transparent" || value === "rgba(0, 0, 0, 0)" || value === "rgba(0,0,0,0)") return "transparent";
  return findSemantic(leaves, "color", value, preferred)?.path;
}

function cssColor(leaves: TokenLeaf[], value: string | undefined, preferred: string[], fallback: string): string {
  const path = tokenColor(leaves, value, preferred);
  if (!path) return fallback;
  if (path === "transparent" || path === "currentColor") return path;
  return cssVar(path);
}

function safeCssKeyword(value: string | undefined, allowed: string[], fallback: string): string {
  return value && allowed.includes(value) ? value : fallback;
}

function uiStyleCss(uiId: string, contract: Record<string, unknown>, observations: AuditLeafUiObservation[], leaves: TokenLeaf[]): { css: string; evidenceStyles: number; fallbackStyles: number; evidence: Record<string, unknown> } {
  const familyItems = observations.filter(item => familyForKind(item.kind) === String(contract.family ?? uiId));
  const variantSources = Array.isArray(contract.variantSources) ? contract.variantSources.filter(isRecord) : [];
  const base = styleProfile(familyItems.map(item => item.style as unknown as Record<string, unknown>));
  let evidenceStyles = 0;
  let fallbackStyles = 0;
  const evidence: Record<string, unknown> = { base };

  if (uiId === "link") {
    const color = cssColor(leaves, base.color?.value, ["semantic.color.text.", "semantic.color.accent."], cssVar("semantic.color.text.default"));
    if (base.color?.confidence && base.color.confidence >= 0.6) evidenceStyles += 1; else fallbackStyles += 1;
    const decoration = safeCssKeyword(base.textDecorationLine?.value, ["none", "underline", "overline", "line-through"], "none");
    return {
      css: `.link {\n  color: ${color};\n  font-family: ${cssVar("semantic.font.family.body")};\n  font-size: ${cssVar("semantic.font.size.body")};\n  line-height: ${cssVar("semantic.font.lineHeight.body")};\n  text-decoration: ${decoration};\n}\n`,
      evidenceStyles, fallbackStyles, evidence
    };
  }

  const display = safeCssKeyword(base.display?.value, ["inline-flex", "flex", "inline-block", "block", "grid", "inline-grid"], "inline-flex");
  const align = safeCssKeyword(base.alignItems?.value, ["normal", "stretch", "center", "start", "end", "flex-start", "flex-end", "baseline"], "center");
  const justify = safeCssKeyword(base.justifyContent?.value, ["normal", "center", "start", "end", "flex-start", "flex-end", "space-between", "space-around", "space-evenly"], "center");
  const baseLines = [
    `.button {`,
    `  display: ${display};`,
    `  align-items: ${align};`,
    `  justify-content: ${justify};`,
    `  padding: ${cssVar("semantic.space.control.y")} ${cssVar("semantic.space.control.x")};`,
    `  border: 1px solid ${cssVar("semantic.color.border.default")};`,
    `  border-radius: ${cssVar("semantic.radius.control")};`,
    `  font-family: ${cssVar("semantic.font.family.body")};`,
    `  font-size: ${cssVar("semantic.font.size.body")};`,
    `  line-height: ${cssVar("semantic.font.lineHeight.body")};`,
    `  font-weight: 700;`,
    `  text-decoration: none;`,
    `  cursor: pointer;`,
    `}`,
    `.button[aria-disabled="true"], .button:disabled { cursor: default; opacity: .55; }`
  ];
  const variantEvidence: Record<string, unknown> = {};
  for (const mapping of variantSources) {
    const source = typeof mapping.source === "string" ? mapping.source : "default";
    const id = typeof mapping.id === "string" ? mapping.id : source;
    const subset = familyItems.filter(item => buttonVariant(item) === source);
    const profile = styleProfile(subset.map(item => item.style as unknown as Record<string, unknown>));
    variantEvidence[id] = { source, profile, samples: subset.length };
    const background = cssColor(leaves, profile.backgroundColor?.value, ["semantic.color.accent.", "semantic.color.surface."], source === "solid" ? cssVar("semantic.color.accent.default") : "transparent");
    const color = cssColor(leaves, profile.color?.value, ["semantic.color.text.", "semantic.color.accent."], source === "solid" ? cssVar("semantic.color.accent.contrast") : cssVar("semantic.color.text.default"));
    const borderColor = cssColor(leaves, profile.borderTopColor?.value, ["semantic.color.accent.", "semantic.color.border.", "semantic.color.text."], source === "solid" ? cssVar("semantic.color.accent.default") : "currentColor");
    baseLines.push(`.button[data-variant="${id}"] { background-color: ${background}; color: ${color}; border-color: ${borderColor}; }`);
    if (subset.length > 0) evidenceStyles += 3; else fallbackStyles += 3;
  }
  evidence.variants = variantEvidence;
  return { css: `${baseLines.join("\n")}\n`, evidenceStyles, fallbackStyles, evidence };
}

function uiImplementation(uiId: string, contract: Record<string, unknown>, css: string): string {
  const variants = Array.isArray(contract.variants) ? contract.variants.filter(item => typeof item === "string") as string[] : ["default"];
  const variantUnion = variants.map(item => JSON.stringify(item)).join(" | ") || '"default"';
  if (uiId === "link") return `---\ninterface Props { label: string; href: string; variant?: ${variantUnion}; }\nconst { label, href, variant = "default" } = Astro.props;\n---\n<a class="link" data-ui="link" data-variant={variant} href={href}>{label}</a>\n\n<style>\n${css}</style>\n`;
  return `---\ninterface Props { label?: string; href?: string; disabled?: boolean; variant?: ${variantUnion}; }\nconst { label = "", href, disabled = false, variant = "default" } = Astro.props;\n---\n{href ? (\n  <a class="button" data-ui="button" data-variant={variant} href={disabled ? undefined : href} aria-disabled={disabled ? "true" : undefined}>{label}</a>\n) : (\n  <button class="button" data-ui="button" data-variant={variant} type="button" disabled={disabled}>{label}</button>\n)}\n\n<style>\n${css}</style>\n`;
}

function componentLayoutProfile(family: ComponentFamilyProposal, audits: AuditEvidence[]): { desktop: StyleProfile; mobile: StyleProfile; evidence: number } {
  const nodes = sectionNodesForFamily(family, audits);
  const desktop = nodes.filter(item => item.viewport === "desktop").map(item => item.node.style as Record<string, unknown> | undefined);
  const mobile = nodes.filter(item => item.viewport === "mobile").map(item => item.node.style as Record<string, unknown> | undefined);
  return { desktop: styleProfile(desktop), mobile: styleProfile(mobile), evidence: nodes.length };
}

function componentCss(componentId: string, family: ComponentFamilyProposal, audits: AuditEvidence[], leaves: TokenLeaf[]): { css: string; evidenceStyles: number; fallbackStyles: number; evidence: Record<string, unknown> } {
  const layout = componentLayoutProfile(family, audits);
  let evidenceStyles = 0;
  let fallbackStyles = 0;
  const backgroundConfidence = layout.desktop.backgroundColor?.confidence ?? 0;
  const colorConfidence = layout.desktop.color?.confidence ?? 0;
  const bg = backgroundConfidence >= 0.55
    ? cssColor(leaves, layout.desktop.backgroundColor?.value, ["semantic.color.surface.", "semantic.color.accent."], cssVar("semantic.color.surface.default"))
    : cssVar("semantic.color.surface.default");
  const fg = colorConfidence >= 0.55
    ? cssColor(leaves, layout.desktop.color?.value, ["semantic.color.text."], cssVar("semantic.color.text.default"))
    : cssVar("semantic.color.text.default");
  if (backgroundConfidence >= 0.55) evidenceStyles += 1; else fallbackStyles += 1;
  if (colorConfidence >= 0.55) evidenceStyles += 1; else fallbackStyles += 1;
  const layoutDisplay = safeCssKeyword(layout.desktop.display?.value, ["grid", "flex", "block"], "grid");
  const flexDirection = safeCssKeyword(layout.desktop.flexDirection?.value, ["row", "row-reverse", "column", "column-reverse"], "column");
  const columns = layout.desktop.gridTemplateColumns?.value && layout.desktop.gridTemplateColumns.value !== "none" ? layout.desktop.gridTemplateColumns.value : undefined;
  const lines = [
    `section { padding: ${cssVar("semantic.space.section")} ${cssVar("semantic.space.page")}; background-color: ${bg}; color: ${fg}; }`,
    `.inner { max-width: ${cssVar("semantic.size.content")}; margin-inline: auto; }`,
    `.layout { display: ${layoutDisplay}; ${layoutDisplay === "flex" ? `flex-direction: ${flexDirection};` : ""} ${columns && layoutDisplay === "grid" ? `grid-template-columns: ${columns};` : ""} gap: ${cssVar("semantic.space.stack.xl")}; align-items: center; }`,
    `.copy { display: grid; gap: ${cssVar("semantic.space.stack.md")}; min-width: 0; }`,
    `h1, h2 { margin: 0; font-family: ${cssVar("semantic.font.family.heading")}; font-size: ${componentId === "hero" ? cssVar("semantic.font.size.display") : cssVar("semantic.font.size.heading")}; line-height: ${componentId === "hero" ? cssVar("semantic.font.lineHeight.display") : cssVar("semantic.font.lineHeight.heading")}; }`,
    `.text { margin: 0; font-family: ${cssVar("semantic.font.family.body")}; font-size: ${componentId === "hero" ? cssVar("semantic.font.size.lead") : cssVar("semantic.font.size.body")}; line-height: ${componentId === "hero" ? cssVar("semantic.font.lineHeight.lead") : cssVar("semantic.font.lineHeight.body")}; color: ${cssVar("semantic.color.text.muted")}; }`,
    `.actions { display: flex; flex-wrap: wrap; gap: ${cssVar("semantic.space.stack.sm")}; }`,
    `.media { min-width: 0; }`,
    `.media :global(picture), .media :global(img) { display: block; width: 100%; height: auto; }`,
    `.items { display: grid; gap: ${cssVar("semantic.space.stack.lg")}; margin: 0; padding: 0; list-style: none; }`,
    `.item { display: grid; gap: ${cssVar("semantic.space.stack.sm")}; }`,
    `.item-title, .item-text { margin: 0; }`,
    `.field-list { display: grid; gap: ${cssVar("semantic.space.stack.md")}; }`,
    `.field { display: grid; gap: ${cssVar("semantic.space.stack.sm")}; }`,
    `.field input, .field textarea, .field select { padding: ${cssVar("semantic.space.control.y")} ${cssVar("semantic.space.control.x")}; border: 1px solid ${cssVar("semantic.color.border.default")}; border-radius: ${cssVar("semantic.radius.control")}; background: ${cssVar("semantic.color.surface.default")}; color: ${cssVar("semantic.color.text.default")}; font: inherit; }`,
    `.form-submit { justify-self: start; padding: ${cssVar("semantic.space.control.y")} ${cssVar("semantic.space.control.x")}; border: 1px solid ${cssVar("semantic.color.accent.default")}; border-radius: ${cssVar("semantic.radius.control")}; background: ${cssVar("semantic.color.accent.default")}; color: ${cssVar("semantic.color.accent.contrast")}; font: inherit; font-weight: 700; cursor: pointer; }`,
    `@media (max-width: 760px) { .layout { display: grid; grid-template-columns: 1fr; } }`
  ];
  if (componentId === "testimonials") lines.push(`section[data-variant="carousel"] .items { display: flex; overflow-x: auto; }`, `section[data-variant="carousel"] .item { min-width: min(82vw, 30rem); }`);
  if (componentId === "logo-cloud") lines.push(`.items { grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); align-items: center; }`, `.item { justify-items: center; text-align: center; }`);
  return { css: `${lines.join("\n")}\n`, evidenceStyles, fallbackStyles, evidence: { layout, samples: layout.evidence } };
}

function typeForProp(name: string, required: boolean): string {
  const suffix = required ? "" : "?";
  if (name === "primaryAction") return `${name}${suffix}: Action`;
  if (name === "media") return `${name}${suffix}: ImageValue`;
  if (name === "items") return `${name}${suffix}: Item[]`;
  if (name === "form") return `${name}${suffix}: FormValue`;
  return `${name}${suffix}: string`;
}

function componentImplementation(componentId: string, contract: Record<string, unknown>, css: string): string {
  const variants = Array.isArray(contract.variants) ? contract.variants.filter(item => typeof item === "string") as string[] : ["default"];
  const props = Array.isArray(contract.props) ? contract.props.filter(item => typeof item === "string") as string[] : [];
  const required = new Set(Array.isArray(contract.required) ? contract.required.filter(item => typeof item === "string") as string[] : []);
  const fields = props.map(name => `  ${typeForProp(name, required.has(name))};`).join("\n");
  const has = (name: string) => props.includes(name);
  const titleTag = componentId === "hero" ? "h1" : "h2";
  const itemMode = componentId === "testimonials" ? "testimonial" : componentId === "logo-cloud" ? "logo" : "generic";
  const itemMarkup = itemMode === "testimonial"
    ? `{props.items && props.items.length > 0 && <ul class="items">{props.items.map((item) => <li class="item">{item.text && <blockquote class="item-text">{item.text}</blockquote>}{item.title && <p class="item-title">{item.title}</p>}{item.media && <div class="media"><SiteImage image={item.media} /></div>}</li>)}</ul>}`
    : itemMode === "logo"
      ? `{props.items && props.items.length > 0 && <ul class="items">{props.items.map((item) => <li class="item">{item.media && <div class="media"><SiteImage image={item.media} /></div>}{item.label && <span>{item.label}</span>}</li>)}</ul>}`
      : `{props.items && props.items.length > 0 && <ul class="items">{props.items.map((item) => <li class="item">{item.title && <h3 class="item-title">{item.title}</h3>}{item.text && <p class="item-text">{item.text}</p>}{item.media && <div class="media"><SiteImage image={item.media} /></div>}{item.href && item.label && <Link href={item.href} label={item.label} />}</li>)}</ul>}`;
  const formMarkup = `{props.form && <form class="field-list" action={props.form.action} method={props.form.method ?? "post"}>{props.form.fields?.map((field) => <label class="field"><span>{field.label}</span>{field.kind === "textarea" ? <textarea name={field.name} placeholder={field.placeholder} required={field.required}></textarea> : field.kind === "select" ? <select name={field.name} required={field.required}>{field.options?.map((option) => <option value={option.value}>{option.label}</option>)}</select> : <input type={field.kind ?? "text"} name={field.name} placeholder={field.placeholder} required={field.required} />}</label>)}<button class="form-submit" type="submit">{props.form.submitLabel ?? "Submit"}</button></form>}`;
  return `---\nimport Button from "../../ui/button/index.astro";\nimport Link from "../../ui/link/index.astro";\nimport SiteImage from "@site-generated/components/SiteImage.astro";\ninterface Action { label: string; href?: string; }\ninterface ImageValue { src: string; alt?: string; decorative?: boolean; width?: number; height?: number; sizes?: string; srcset?: string; sources?: Array<{ type: string; srcset: string }>; loading?: "eager" | "lazy"; decoding?: "async" | "sync" | "auto"; fetchPriority?: "high" | "low" | "auto" }\ninterface Item { title?: string; text?: string; label?: string; href?: string; media?: ImageValue; }\ninterface FormField { label: string; name: string; kind?: "text" | "email" | "tel" | "url" | "textarea" | "select"; placeholder?: string; required?: boolean; options?: Array<{ label: string; value: string }>; }\ninterface FormValue { action?: string; method?: "get" | "post"; fields?: FormField[]; submitLabel?: string; }\ninterface SectionProps {\n${fields}\n}\ninterface Props { sectionId: string; variant: ${variants.map(item => JSON.stringify(item)).join(" | ") || '"default"'}; theme: string; props: SectionProps; }\nconst { sectionId, variant, theme, props } = Astro.props;\n---\n<section id={sectionId} data-section={sectionId} data-component=${JSON.stringify(componentId)} data-variant={variant} data-theme={theme}>\n  <div class="inner">\n    <div class="layout">\n      <div class="copy">\n        ${has("title") ? `{props.title && <${titleTag}>{props.title}</${titleTag}>}` : ""}\n        ${has("text") ? `{props.text && <p class="text">{props.text}</p>}` : ""}\n        ${has("primaryAction") ? `{props.primaryAction && <div class="actions"><Button label={props.primaryAction.label} href={props.primaryAction.href} variant="default" /></div>}` : ""}\n      </div>\n      ${has("media") ? `{props.media && <div class="media"><SiteImage image={props.media} /></div>}` : ""}\n      ${has("items") ? itemMarkup : ""}\n      ${has("form") ? formMarkup : ""}\n    </div>\n  </div>\n</section>\n\n<style>\n${css}</style>\n`;
}

function shellStyle(region: "header" | "footer", family: ComponentFamilyProposal | undefined, audits: AuditEvidence[], leaves: TokenLeaf[]): { css: string; evidence: Record<string, unknown>; evidenceStyles: number; fallbackStyles: number } {
  const nodes = family ? sectionNodesForFamily(family, audits) : [];
  const profile = styleProfile(nodes.filter(item => item.viewport === "desktop").map(item => item.node.style as Record<string, unknown> | undefined));
  const bg = cssColor(leaves, profile.backgroundColor?.value, ["semantic.color.surface."], region === "footer" ? cssVar("semantic.color.surface.muted") : cssVar("semantic.color.surface.default"));
  const fg = cssColor(leaves, profile.color?.value, ["semantic.color.text."], cssVar("semantic.color.text.default"));
  const sticky = region === "header" && (profile.position?.value === "sticky" || profile.position?.value === "fixed");
  const borderProp = region === "header" ? "border-bottom" : "border-top";
  return {
    css: `.${region === "header" ? "site-header" : "site-footer"} { ${sticky ? "position: sticky; top: 0; z-index: 10;" : ""} ${borderProp}: 1px solid ${cssVar("semantic.color.border.default")}; background-color: ${bg}; color: ${fg}; padding-inline: ${cssVar("semantic.space.page")}; }\n.inner { max-width: ${cssVar("semantic.size.content")}; margin-inline: auto; padding-block: ${region === "header" ? cssVar("semantic.space.stack.md") : cssVar("semantic.space.stack.xl")}; display: flex; align-items: center; justify-content: space-between; gap: ${cssVar("semantic.space.stack.lg")}; }\nul { display: flex; flex-wrap: wrap; gap: ${cssVar("semantic.space.stack.md")}; margin: 0; padding: 0; list-style: none; }\na { color: inherit; text-decoration: none; }\n`,
    evidence: { profile, samples: nodes.length },
    evidenceStyles: (profile.backgroundColor?.confidence ?? 0) >= 0.55 ? 1 : 0,
    fallbackStyles: (profile.backgroundColor?.confidence ?? 0) >= 0.55 ? 0 : 1
  };
}

function headerImplementation(css: string): string {
  return `---\ninterface NavigationItem { id: string; label: string; href: string; target: "self" | "blank"; external: boolean; current?: boolean; }\ninterface Props { site: { name: string; homeHref: string }; navigation: Record<string, NavigationItem[]>; }\nconst { site, navigation } = Astro.props;\nconst items = navigation.primary ?? [];\n---\n<header class="site-header" data-site-shell="header">\n  <div class="inner">\n    <a class="brand" href={site.homeHref}>{site.name}</a>\n    {items.length > 0 && <nav aria-label="Primary"><ul>{items.map((item) => <li><a href={item.href} target={item.target === "blank" ? "_blank" : undefined} rel={item.target === "blank" ? "noreferrer" : undefined} aria-current={item.current ? "page" : undefined}>{item.label}</a></li>)}</ul></nav>}\n  </div>\n</header>\n<style>\n${css}.brand { font-family: ${cssVar("semantic.font.family.heading")}; font-weight: 700; }\n</style>\n`;
}

function footerImplementation(css: string): string {
  return `---\ninterface NavigationItem { id: string; label: string; href: string; target: "self" | "blank"; external: boolean; current?: boolean; }\ninterface Props { site: { name: string }; navigation: Record<string, NavigationItem[]>; }\nconst { site, navigation } = Astro.props;\nconst items = navigation.project ?? navigation.primary ?? [];\n---\n<footer class="site-footer" data-site-shell="footer">\n  <div class="inner">\n    <p>{site.name}</p>\n    {items.length > 0 && <nav aria-label="Footer"><ul>{items.map((item) => <li><a href={item.href} target={item.target === "blank" ? "_blank" : undefined} rel={item.target === "blank" ? "noreferrer" : undefined}>{item.label}</a></li>)}</ul></nav>}\n  </div>\n</footer>\n<style>\n${css}p { margin: 0; }\n</style>\n`;
}

function shellEntryImplementation(): string {
  return `---\nimport Header from "./Header.astro";\nimport Footer from "./Footer.astro";\nconst { site, brand, page, navigation } = Astro.props;\n---\n<Header site={site} brand={brand} page={page} navigation={navigation} />\n<main id="main-content"><slot /></main>\n<Footer site={site} brand={brand} page={page} navigation={navigation} />\n<style is:global>\n*, *::before, *::after { box-sizing: border-box; }\nhtml { font-family: ${cssVar("semantic.font.family.body")}; }\nbody { margin: 0; background: ${cssVar("semantic.color.surface.default")}; color: ${cssVar("semantic.color.text.default")}; }\na { color: inherit; }\nimg { max-width: 100%; height: auto; }\n</style>\n`;
}

async function writeTracked(output: string, relativeFile: string, content: string, files: string[]): Promise<void> {
  const file = join(output, relativeFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  files.push(slash(relativeFile));
}

function contractOutput(reportFile: string, report: ContractReport): string {
  if (!report.output) return dirname(reportFile);
  return isAbsolute(report.output) ? report.output : resolve(dirname(reportFile), report.output);
}

function validateContractReport(report: ContractReport, expected: string, file: string): void {
  if (report.type !== expected || typeof report.site !== "string") throw new MigrateImplementationError("MIGRATE_IMPLEMENTATIONS_CONTRACT_INVALID", `${file} is not ${expected}.`, { file });
}

async function assertContractSourceCurrent(reportFile: string, report: ContractReport, code: string): Promise<void> {
  const source = report.source;
  if (!source) return;
  for (const [kind, pathValue, hashValue] of [
    ["review", source.review, source.reviewSha256],
    ["proposal", source.proposal, source.proposalSha256]
  ] as const) {
    if (!pathValue || !hashValue) continue;
    const file = isAbsolute(pathValue) ? pathValue : resolve(dirname(reportFile), pathValue);
    if (!(await exists(file))) throw new MigrateImplementationError(code, `${basename(reportFile)} references a missing ${kind}: ${file}`, { report: reportFile, file, kind });
    const raw = await readFile(file, "utf8");
    if (sha256(raw) !== hashValue) throw new MigrateImplementationError(code, `${basename(reportFile)} is stale because its ${kind} changed. Re-run the corresponding review/contracts command before implementation inference.`, { report: reportFile, file, kind });
  }
}

export async function inferImplementations(options: InferImplementationsOptions): Promise<ImplementationInferenceResult> {
  const root = resolve(options.root ?? ".");
  const analysis = isAbsolute(options.analysis) ? options.analysis : resolve(root, options.analysis);
  const foundationReportFile = join(analysis, "foundation-materialization.json");
  const componentReportFile = join(analysis, "component-contracts.json");
  const uiReportFile = join(analysis, "ui-contracts.json");
  const shellReportFile = join(analysis, "shell-contracts.json");
  const componentProposalFile = join(analysis, "component-families.json");
  const uiProposalFile = join(analysis, "ui-families.json");
  const designReportFile = join(analysis, "report.json");
  const requiredInputs = [foundationReportFile, componentReportFile, uiReportFile, shellReportFile, componentProposalFile, uiProposalFile, designReportFile];
  const missingInputs: string[] = [];
  for (const file of requiredInputs) if (!(await exists(file))) missingInputs.push(file);
  if (missingInputs.length > 0) {
    const next: string[] = [];
    if (missingInputs.includes(designReportFile) || missingInputs.includes(componentProposalFile) || missingInputs.includes(uiProposalFile)) next.push(`npm run site -- migrate design <audit...>`);
    if (missingInputs.includes(foundationReportFile)) next.push(`npm run site -- migrate foundation review ${JSON.stringify(analysis)} --force`, `npm run site -- migrate foundation materialize ${JSON.stringify(join(analysis, "foundation-review.json"))}`);
    if (missingInputs.includes(componentReportFile)) next.push(`npm run site -- migrate components review ${JSON.stringify(analysis)} --force`, `npm run site -- migrate components contracts ${JSON.stringify(join(analysis, "component-review.json"))}`);
    if (missingInputs.includes(uiReportFile)) next.push(`npm run site -- migrate ui review ${JSON.stringify(analysis)} --force`, `npm run site -- migrate ui contracts ${JSON.stringify(join(analysis, "ui-review.json"))}`);
    if (missingInputs.includes(shellReportFile)) next.push(`npm run site -- migrate shell contracts ${JSON.stringify(join(analysis, "component-review.json"))}`);
    throw new MigrateImplementationError(
      "MIGRATE_IMPLEMENTATIONS_INPUT_MISSING",
      `Implementation inference requires current reviewed migration artifacts. Missing:\n${missingInputs.map(file => `  - ${file}`).join("\n")}${next.length ? `\nNext:\n${[...new Set(next)].map(command => `  ${command}`).join("\n")}` : ""}`,
      { missing: missingInputs, next: [...new Set(next)] }
    );
  }
  const foundation = await readRequiredJson<Record<string, unknown>>(foundationReportFile, "MIGRATE_IMPLEMENTATIONS_FOUNDATION_MISSING");
  const components = await readRequiredJson<ContractReport>(componentReportFile, "MIGRATE_IMPLEMENTATIONS_COMPONENTS_MISSING");
  const ui = await readRequiredJson<ContractReport>(uiReportFile, "MIGRATE_IMPLEMENTATIONS_UI_MISSING");
  const shell = await readRequiredJson<ContractReport>(shellReportFile, "MIGRATE_IMPLEMENTATIONS_SHELL_MISSING");
  const componentProposal = await readRequiredJson<{ type?: string; site?: string; families?: ComponentFamilyProposal[] }>(componentProposalFile, "MIGRATE_IMPLEMENTATIONS_COMPONENT_PROPOSAL_MISSING");
  const uiProposal = await readRequiredJson<{ type?: string; site?: string; families?: UiFamilyProposal[] }>(uiProposalFile, "MIGRATE_IMPLEMENTATIONS_UI_PROPOSAL_MISSING");
  const designReport = await readRequiredJson<DesignReport>(designReportFile, "MIGRATE_IMPLEMENTATIONS_DESIGN_REPORT_MISSING");
  validateContractReport(components.value, "sitespec-migrate-component-contracts", componentReportFile);
  validateContractReport(ui.value, "sitespec-migrate-ui-contracts", uiReportFile);
  validateContractReport(shell.value, "sitespec-migrate-shell-contracts", shellReportFile);
  await assertContractSourceCurrent(componentReportFile, components.value, "MIGRATE_IMPLEMENTATIONS_COMPONENTS_STALE");
  await assertContractSourceCurrent(uiReportFile, ui.value, "MIGRATE_IMPLEMENTATIONS_UI_STALE");
  await assertContractSourceCurrent(shellReportFile, shell.value, "MIGRATE_IMPLEMENTATIONS_SHELL_STALE");
  const foundationValue = foundation.value;
  if (foundationValue.type !== "sitespec-migrate-foundation-materialization" || foundationValue.status !== "ready" || typeof foundationValue.output !== "string" || typeof foundationValue.site !== "string") {
    throw new MigrateImplementationError("MIGRATE_IMPLEMENTATIONS_FOUNDATION_NOT_READY", "foundation-materialization.json must be ready before implementation inference.", { file: foundationReportFile });
  }
  const sites = [foundationValue.site, components.value.site, ui.value.site, shell.value.site, componentProposal.value.site, uiProposal.value.site].filter(Boolean);
  if (new Set(sites).size !== 1) throw new MigrateImplementationError("MIGRATE_IMPLEMENTATIONS_SITE_MISMATCH", `Implementation inputs belong to different sites: ${sites.join(", ")}`, { sites });
  const foundationTokensFile = isAbsolute(foundationValue.output) ? foundationValue.output : resolve(dirname(foundationReportFile), foundationValue.output);
  const tokens = await readRequiredJson<Json>(foundationTokensFile, "MIGRATE_IMPLEMENTATIONS_TOKENS_MISSING");
  const leaves = tokenLeaves(tokens.value);
  const audits = await loadAuditEvidence(root, designReport.value);
  const observations = audits.flatMap(audit => audit.ui);
  const byComponentFamily = new Map((componentProposal.value.families ?? []).map(item => [item.id, item]));
  const byUiFamily = new Map((uiProposal.value.families ?? []).map(item => [item.id, item]));

  const output = options.output ? (isAbsolute(options.output) ? options.output : resolve(root, options.output)) : join(analysis, "implementation-preview");
  const report = join(analysis, "implementation-inference.json");
  await prepareOutput(output);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, OUTPUT_MARKER), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-implementation-output" }, null, 2)}\n`, "utf8");

  const files: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const implementations: Array<Record<string, unknown>> = [];
  let evidenceStyles = 0;
  let fallbackStyles = 0;

  const extensionBuilt = buildTokenExtension(tokens.value, leaves, observations);
  await writeTracked(output, "design/extensions.json", `${JSON.stringify(extensionBuilt.extension, null, 2)}\n`, files);
  await writeTracked(output, "design/fonts.yaml", `specVersion: "0.5"\nfonts: {}\n`, files);
  warnings.push("Roboto Flex is referenced by the inferred foundation but local font binaries are not available in audit evidence. The generated fonts.yaml is intentionally empty, so runtime can fall back to sans-serif until local font assets are supplied.");

  for (const contract of ui.value.contracts ?? []) {
    const uiId = typeof contract.uiId === "string" ? contract.uiId : undefined;
    const familyId = typeof contract.family === "string" ? contract.family : uiId;
    if (!uiId || !familyId || !ID_PATTERN.test(uiId)) { blockers.push("UI contract is missing a valid uiId/family."); continue; }
    if (!byUiFamily.has(familyId)) warnings.push(`${uiId}: source UI family ${familyId} was not found; implementation uses contract-safe fallbacks.`);
    const styled = uiStyleCss(uiId, contract, observations, leaves);
    evidenceStyles += styled.evidenceStyles; fallbackStyles += styled.fallbackStyles;
    const file = `ui/${uiId}/index.astro`;
    await writeTracked(output, file, uiImplementation(uiId, contract, styled.css), files);
    implementations.push({ layer: "ui", id: uiId, file, confidence: contract.confidence, evidence: styled.evidence, unresolved: contract.unresolved ?? [] });
  }

  for (const contract of components.value.contracts ?? []) {
    const componentId = typeof contract.componentId === "string" ? contract.componentId : undefined;
    const familyId = typeof contract.family === "string" ? contract.family : componentId;
    if (!componentId || !familyId || !ID_PATTERN.test(componentId)) { blockers.push("Component contract is missing a valid componentId/family."); continue; }
    const family = byComponentFamily.get(familyId);
    if (!family) { blockers.push(`${componentId}: source component family ${familyId} is missing.`); continue; }
    const styled = componentCss(componentId, family, audits, leaves);
    evidenceStyles += styled.evidenceStyles; fallbackStyles += styled.fallbackStyles;
    const file = `components/${componentId}/index.astro`;
    await writeTracked(output, file, componentImplementation(componentId, contract, styled.css), files);
    const componentUnresolved = Array.isArray(contract.unresolved) ? [...contract.unresolved] : [];
    const contractProps = Array.isArray(contract.props) ? contract.props.filter(item => typeof item === "string") as string[] : [];
    if (contractProps.includes("form")) componentUnresolved.push("Form submit semantics are rendered with a native submit button because the accepted Button contract does not yet expose submit/reset type semantics.");
    implementations.push({ layer: "section", id: componentId, file, confidence: contract.confidence, evidence: styled.evidence, unresolved: componentUnresolved });
  }

  const shellPacks = shell.value.packs ?? [];
  let shellImplementations = 0;
  if (shellPacks.length > 0) {
    const regions = Array.isArray(shellPacks[0]?.regions) ? (shellPacks[0]!.regions as Array<Record<string, unknown>>) : [];
    const headerRegion = regions.find(item => item.region === "header");
    const footerRegion = regions.find(item => item.region === "footer");
    const headerFamilyId = typeof headerRegion?.family === "string" ? headerRegion.family : "site-header";
    const footerFamilyId = typeof footerRegion?.family === "string" ? footerRegion.family : "site-footer";
    const headerStyled = shellStyle("header", byComponentFamily.get(headerFamilyId), audits, leaves);
    const footerStyled = shellStyle("footer", byComponentFamily.get(footerFamilyId), audits, leaves);
    evidenceStyles += headerStyled.evidenceStyles + footerStyled.evidenceStyles;
    fallbackStyles += headerStyled.fallbackStyles + footerStyled.fallbackStyles;
    await writeTracked(output, "shell/default.astro", shellEntryImplementation(), files);
    await writeTracked(output, "shell/Header.astro", headerImplementation(headerStyled.css), files);
    await writeTracked(output, "shell/Footer.astro", footerImplementation(footerStyled.css), files);
    shellImplementations = 3;
    implementations.push({ layer: "shell", id: "default", file: "shell/default.astro", confidence: 1, unresolved: ["Responsive menu open/close behavior is not inferred from static default-state audit evidence."] });
    implementations.push({ layer: "shell", id: headerFamilyId, file: "shell/Header.astro", confidence: headerRegion?.confidence, evidence: headerStyled.evidence, unresolved: ["Mobile navigation state machine is intentionally not fabricated."] });
    implementations.push({ layer: "shell", id: footerFamilyId, file: "shell/Footer.astro", confidence: footerRegion?.confidence, evidence: footerStyled.evidence, unresolved: [] });
  } else blockers.push("No accepted shell pack is available for implementation inference.");

  const uiImplementations = implementations.filter(item => item.layer === "ui").length;
  const sectionImplementations = implementations.filter(item => item.layer === "section").length;
  if (audits.length === 0) warnings.push("No audit evidence paths were available in report.json; implementations are contract-shaped but styling uses foundation fallbacks only.");
  warnings.push("Hover/focus/active visual-state styling and client-side interaction are not inferred from default-state audit evidence.");
  warnings.push("Generated section markup follows accepted contract props instead of copying production HTML. DOM evidence is used for layout/style signals, preserving the Design System API boundary.");
  const status: ImplementationInferenceResult["status"] = blockers.length > 0 ? (implementations.length > 0 ? "partial" : "blocked") : "ready";
  const summary = { uiImplementations, sectionImplementations, shellImplementations, semanticTokenExtensions: extensionBuilt.additions.length, evidenceBackedStyles: evidenceStyles, fallbackStyles };
  const document = {
    version: "0.1",
    type: "sitespec-migrate-implementation-inference",
    status,
    phase: "implementation-inference",
    site: String(foundationValue.site),
    source: {
      foundation: relativeOrAbsolute(dirname(report), foundationReportFile), foundationSha256: sha256(foundation.raw),
      components: relativeOrAbsolute(dirname(report), componentReportFile), componentsSha256: sha256(components.raw),
      ui: relativeOrAbsolute(dirname(report), uiReportFile), uiSha256: sha256(ui.raw),
      shell: relativeOrAbsolute(dirname(report), shellReportFile), shellSha256: sha256(shell.raw),
      designReport: relativeOrAbsolute(dirname(report), designReportFile), designReportSha256: sha256(designReport.raw),
      evidenceSources: audits.flatMap(audit => audit.sources.map(source => ({ file: relativeOrAbsolute(dirname(report), source.file), sha256: source.sha256 })))
    },
    rule: "Accepted contracts define implementation APIs. Audit DOM-root/computed-style evidence may shape layout and token mappings, but production HTML is not copied verbatim and unobserved interaction/runtime behavior is not fabricated.",
    output: relativeOrAbsolute(dirname(report), output),
    files: files.sort(),
    tokenExtensions: { file: "design/extensions.json", additions: extensionBuilt.additions },
    fonts: { file: "design/fonts.yaml", status: "fallback-only", family: "Roboto Flex", reason: "Audit evidence identifies the family but does not contain redistributable local font binaries." },
    implementations,
    blockers,
    warnings: [...new Set(warnings)],
    summary
  };
  await writeFile(report, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { site: String(foundationValue.site), status, phase: "implementation-inference", output, report, files: files.sort(), blockers, warnings: [...new Set(warnings)], summary };
}

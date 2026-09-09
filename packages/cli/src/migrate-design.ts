import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AUDIT_VIEWPORTS, type AuditDesignInventory, type AuditInventoryItem, type AuditLayoutNode, type AuditMediaItem, type AuditLeafUiObservation } from "./migrate-audit.js";
import { buildUiFamilyModel, type UiFamilyModel } from "./migrate-ui.js";

export interface MigrateDesignOptions {
  audits: string[];
  root?: string;
  output?: string;
}

export interface MigrateDesignResult {
  site: string;
  output: string;
  audits: Array<{ sourceUrl: string; path: string }>;
  files: {
    report: string;
    foundations: string;
    tokenCandidates: string;
    foundationProposal: string;
    sectionRhythm: string;
    sectionClusters: string;
    componentFamilies: string;
    uiFamilies: string;
    shellCandidates: string;
    mediaRoles: string;
  };
  summary: {
    pages: number;
    manualSegmentPages: number;
    foundationValues: number;
    primitiveTokenCandidates: number;
    semanticTokenCandidates: number;
    typographyCandidates: number;
    foundationProposal: {
      primitiveTokens: number;
      corePrimitiveTokens: number;
      semanticRoles: number;
      typographyRoles: number;
      unresolved: number;
    };
    sectionRhythm: {
      status: SectionRhythmModel["status"];
      candidates: number;
      strongCandidates: number;
      recommended?: string;
      confidence: number;
    };
    sectionClusters: number;
    clusteredSections: number;
    unclusteredSections: number;
    componentFamilies: {
      total: number;
      core: number;
      supporting: number;
      local: number;
      shell: number;
      section: number;
      variants: number;
    };
    uiFamilies: UiFamilyModel["summary"];
    shellCandidates: number;
    mediaRoleCandidates: number;
    tokenNormalization: TokenNormalizationSummary;
  };
}

export class MigrateDesignError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateDesignError";
    this.code = code;
    this.details = details;
  }
}

interface AuditArtifact {
  root: string;
  sourceUrl: string;
  finalUrl: string;
  page: Record<string, unknown>;
  design: { aggregate: AuditDesignInventory; viewports?: Record<string, AuditDesignInventory> };
  sections: {
    viewport?: { width?: number; height?: number };
    source: "manual" | "automatic";
    items: AuditSection[];
    regions?: Record<string, { viewport?: { width?: number; height?: number }; items: AuditLayoutNode[] }>;
    manualRegions?: Record<string, { viewport?: { width?: number; height?: number }; items: ManualRegionMatch[] }>;
  };
  media: { items: AuditMediaItem[] };
  ui?: { items: Array<AuditLeafUiObservation & { viewport?: string }> };
}

interface ManualRegionMatch {
  targetId?: string;
  segmentId?: string;
  rootIndex?: number;
  sourceSelector: string;
  matchedSelector?: string;
  matchMethod?: "selector" | "fingerprint";
  score?: number;
  item: AuditLayoutNode;
  boundary?: AuditLayoutNode;
  boundaryConfidence?: number;
}

export interface AuditSection {
  auditId: string;
  source?: "manual" | "automatic";
  role?: "section" | "header" | "footer";
  label?: string;
  tag?: string;
  selector?: string;
  selectors?: string[];
  heading?: string;
  background?: string;
  screenshot?: string;
  screenshotClip?: { x: number; y: number; width: number; height: number };
  box: { x: number; y: number; width: number; height: number };
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
  roots?: AuditLayoutNode[];
  headingStyle?: {
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textTransform?: string;
  };
}

export interface FoundationEvidenceItem {
  key: string;
  value?: string;
  count: number;
  pages: string[];
  pageCounts: Record<string, number>;
  coverage: number;
  confidence: number;
  properties?: Record<string, number>;
  viewports?: Record<string, number>;
  style?: Record<string, string>;
}

export interface DesignFoundations {
  pages: number;
  colors: FoundationEvidenceItem[];
  typography: FoundationEvidenceItem[];
  radii: FoundationEvidenceItem[];
  shadows: FoundationEvidenceItem[];
  spacing: FoundationEvidenceItem[];
  containerWidths: FoundationEvidenceItem[];
}

export interface PrimitiveTokenCandidate {
  id: string;
  group: "color" | "space" | "radius" | "shadow" | "size" | "font.family" | "font.size" | "font.lineHeight" | "font.weight" | "font.letterSpacing";
  type: "color" | "dimension" | "shadow" | "fontFamily" | "number" | "string";
  value: string | number;
  confidence: number;
  evidence: {
    count: number;
    pages: string[];
    coverage: number;
    properties?: Record<string, number>;
    viewports?: Record<string, number>;
    rawValues?: string[];
  };
}

export interface SemanticTokenCandidate {
  id: string;
  role: string;
  primitive: string;
  confidence: number;
  reason: string;
  evidence: { count: number; pages: string[]; properties?: Record<string, number> };
}

export interface TypographyCandidate {
  id: string;
  suggestedRole: string;
  confidence: number;
  style: Record<string, string>;
  evidence: {
    count: number;
    pages: string[];
    coverage: number;
    rawStyles?: number;
    lineHeightRatios?: Record<string, number>;
  };
}

export type FoundationProposalStatus = "core" | "supporting" | "exception";

export interface FoundationTokenProposal {
  path: string;
  type: PrimitiveTokenCandidate["type"];
  value: string | number;
  status: FoundationProposalStatus;
  confidence: number;
  sources: string[];
  reason: string;
}

export interface FoundationSemanticProposal {
  path: string;
  primitive: string;
  confidence: number;
  sources: string[];
  reason: string;
}

export interface FoundationTypographyRoleProposal {
  role: string;
  status: Exclude<FoundationProposalStatus, "exception">;
  confidence: number;
  style: {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing?: string;
    textTransform?: string;
  };
  source: string;
  alternates: Array<{
    source: string;
    confidence: number;
    fontWeight: string;
    lineHeight: string;
    letterSpacing?: string;
  }>;
  evidence: TypographyCandidate["evidence"];
}

export interface DesignFoundationProposal {
  model: {
    layers: ["evidence", "normalized-candidates", "foundation-proposal"];
    rule: string;
  };
  primitive: {
    color: FoundationTokenProposal[];
    spacing: {
      baseUnit?: string;
      baseUnitConfidence: number;
      tokens: FoundationTokenProposal[];
    };
    radius: FoundationTokenProposal[];
    shadow: FoundationTokenProposal[];
    size: FoundationTokenProposal[];
    font: {
      family: FoundationTokenProposal[];
      size: FoundationTokenProposal[];
      weight: FoundationTokenProposal[];
      lineHeight: FoundationTokenProposal[];
      letterSpacing: FoundationTokenProposal[];
    };
  };
  semantic: FoundationSemanticProposal[];
  typography: FoundationTypographyRoleProposal[];
  layout: {
    convention: "outer-gutter-inner-container";
    contentWidth?: {
      primitive: string;
      max: string;
      confidence: number;
      reason: string;
      responsiveEvidence: Array<{ viewport: string; viewportWidth: string; observedWidth: string; source: string }>;
    };
    pageGutter: {
      status: "proposed" | "unresolved";
      confidence: number;
      values: Array<{ viewport: string; value: string; primitive?: string; source: string; confirmedBySpacing: boolean }>;
      reason: string;
    };
    sectionSpacing: {
      status: "proposed" | "unresolved";
      primitive?: string;
      value?: string;
      confidence: number;
      sourceCandidate?: string;
      reason: string;
    };
    innerContainerCandidates: Array<{
      tier: string;
      values: Array<{ viewport: string; value: string; primitive: string; source: string }>;
      reason: string;
    }>;
  };
  unresolved: Array<{ area: string; reason: string; candidates?: string[] }>;
  summary: {
    primitiveTokens: number;
    corePrimitiveTokens: number;
    semanticRoles: number;
    typographyRoles: number;
    unresolved: number;
  };
}

export interface SectionRhythmCandidate {
  value: string;
  primitiveCandidate: string;
  confidence: number;
  strength: "strong" | "supporting" | "weak";
  evidence: {
    sections: number;
    viewportOccurrences: number;
    pages: string[];
    pageCoverage: number;
    balancedSections: number;
    balancedRatio: number;
    responsiveSections: number;
    responsiveRatio: number;
    selectorCoverage: number;
    sectionViewports: string[];
    manualSections: number;
    clusters: string[];
    repeatedClusters: number;
    inventory: {
      count: number;
      paddingTop: number;
      paddingBottom: number;
      verticalShare: number;
      viewports: string[];
      viewportCoverage: number;
    };
    examples: Array<{
      page: string;
      viewport?: string;
      auditId: string;
      label?: string;
      source?: "manual" | "automatic";
      cluster?: string;
      selector?: string;
      screenshot?: string;
      paddingTop?: string;
      paddingBottom?: string;
      boundarySource?: "common-ancestor" | "roots";
      boundarySelector?: string;
    }>;
  };
  reason: string;
}

export interface SectionRhythmModel {
  status: "proposed" | "unresolved";
  rule: string;
  recommended?: {
    value: string;
    primitiveCandidate: string;
    confidence: number;
    reason: string;
  };
  compactCandidates: string[];
  candidates: SectionRhythmCandidate[];
  rejected: Array<{
    value: string;
    primitiveCandidate: string;
    reason: string;
  }>;
}

export type TokenNormalizationCategory = "color" | "spacing" | "radius" | "shadow" | "size" | "typography";

export interface TokenNormalizationRejection {
  category: TokenNormalizationCategory;
  value: string;
  reason: string;
  count: number;
  pages: string[];
}

export interface TokenNormalizationCategorySummary {
  raw: number;
  normalized: number;
  rejected: number;
  merged: number;
}

export interface TokenNormalizationSummary {
  rawEvidenceValues: number;
  normalizedEvidenceGroups: number;
  rejectedEvidenceValues: number;
  mergedEvidenceValues: number;
  reasons: Record<string, number>;
  adjustments: Record<string, number>;
  byCategory: Record<TokenNormalizationCategory, TokenNormalizationCategorySummary>;
}

export interface TokenNormalizationReport extends TokenNormalizationSummary {
  rejected: TokenNormalizationRejection[];
}

export interface SectionViewportEvidence {
  viewport: string;
  width: number;
  height?: number;
  roots: AuditLayoutNode[];
  box: { x: number; y: number; width: number; height: number };
  matchedSelectors: number;
  totalSelectors: number;
  matchConfidence?: number;
  boundary?: AuditLayoutNode;
  boundaryConfidence?: number;
}

export interface SectionObservation {
  page: string;
  sourceUrl: string;
  section: AuditSection;
  viewportWidth: number;
  viewports: Record<string, SectionViewportEvidence>;
}

export interface SectionSimilarity {
  score: number;
  signals: Record<string, number>;
}

export interface SectionCluster {
  id: string;
  suggestedFamily?: string;
  suggestedFamilyConfidence?: number;
  score: number;
  pages: string[];
  evidenceQuality: "enhanced" | "legacy";
  segmentation: "manual" | "automatic" | "mixed";
  members: Array<{
    page: string;
    sourceUrl: string;
    auditId: string;
    label?: string;
    selector?: string;
    selectors?: string[];
    screenshot?: string;
    screenshotClip?: { x: number; y: number; width: number; height: number };
    source?: "manual" | "automatic";
    semanticIntent?: ManualSectionIntentEvidence;
  }>;
  signals: Record<string, number>;
}

export type ComponentFamilyLayer = "shell" | "section";
export type ComponentFamilyRole = "intro" | "content" | "proof" | "conversion" | "utility";
export type ComponentFamilyStatus = "core" | "supporting" | "local";

export interface ComponentFamilyMember {
  page: string;
  sourceUrl: string;
  auditId: string;
  label?: string;
  source?: "manual" | "automatic";
  cluster?: string;
  semanticIntent?: ManualSectionIntentEvidence;
  variant: string;
  selector?: string;
  selectors?: string[];
  screenshot?: string;
}

export interface ComponentFamilyVariantProposal {
  id: string;
  confidence: number;
  source: "default" | "reviewer-label";
  members: Array<{ page: string; auditId: string; label?: string }>;
  reason: string;
}

export interface ComponentFamilyPropHint {
  name: string;
  kind: "string" | "action" | "media" | "items" | "navigation" | "form";
  confidence: number;
  presenceRatio: number;
  variantCoverage: number;
  requiredRecommendation: "required" | "optional";
  reason: string;
}

export interface ComponentFamilyProposal {
  id: string;
  suggestedComponentId: string;
  layer: ComponentFamilyLayer;
  role?: ComponentFamilyRole;
  status: ComponentFamilyStatus;
  confidence: number;
  reason: string;
  evidence: {
    instances: number;
    pages: string[];
    pageCoverage: number;
    crossPage: boolean;
    repeatedWithinPage: boolean;
    manualInstances: number;
    semanticIntentSupport: number;
    semanticIntentConfidence: number;
    clusters: string[];
    clusterSimilarity: number;
    observedContent: {
      headings: { min: number; max: number; average: number };
      links: { min: number; max: number; average: number };
      buttons: { min: number; max: number; average: number };
      images: { min: number; max: number; average: number };
      forms: { min: number; max: number; average: number };
      lists: { min: number; max: number; average: number };
    };
  };
  variants: ComponentFamilyVariantProposal[];
  contractHints: {
    role?: ComponentFamilyRole;
    maxPerPage?: number;
    placement?: "first" | "last";
    pageHeading?: boolean;
    props: ComponentFamilyPropHint[];
  };
  members: ComponentFamilyMember[];
}

export interface ComponentFamilyModel {
  rule: string;
  families: ComponentFamilyProposal[];
  unresolved: Array<{
    area: string;
    reason: string;
    families?: string[];
  }>;
  coverage: {
    sectionFamilies: "modeled";
    shellFamilies: "modeled";
    leafControls: "not-modeled" | "observed";
    reason: string;
  };
  summary: {
    total: number;
    core: number;
    supporting: number;
    local: number;
    shell: number;
    section: number;
    variants: number;
    unresolved: number;
  };
}

interface LoadedInput {
  artifacts: AuditArtifact[];
  host: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "site";
}

function normalizedHost(source: string): string {
  try {
    return new URL(source).host.replace(/^www\./, "").toLowerCase();
  } catch {
    throw new MigrateDesignError("MIGRATE_DESIGN_AUDIT_INVALID", `Audit contains an invalid source URL: ${source}`);
  }
}

function pageId(source: string): string {
  const url = new URL(source);
  const path = url.pathname === "/" ? "home" : url.pathname.split("/").filter(Boolean).join("-");
  return slug(path || "home");
}

async function readJson(file: string, code: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(parsed)) throw new Error("JSON root must be an object.");
    return parsed;
  } catch (error) {
    throw new MigrateDesignError(code, `Could not read migration artifact ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
}

async function resolveAuditRoot(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved) === "audit.json") return dirname(resolved);
  return resolved;
}

async function readOptionalJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new MigrateDesignError("MIGRATE_DESIGN_EVIDENCE_INVALID", `Could not read migration artifact ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
}

function normalizeLayoutNode(value: unknown): AuditLayoutNode | undefined {
  if (!isRecord(value) || typeof value.selector !== "string" || typeof value.tag !== "string" || !isRecord(value.box)) return undefined;
  const box = value.box;
  if (![box.x, box.y, box.width, box.height].every(item => Number.isFinite(Number(item)))) return undefined;
  return {
    ...value,
    selector: value.selector,
    tag: value.tag,
    box: { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) }
  } as unknown as AuditLayoutNode;
}

function manualSections(raw: Record<string, unknown> | undefined): { viewport?: { width?: number; height?: number }; items: AuditSection[] } | undefined {
  if (!raw || raw.type !== "sitespec-migrate-segments" || raw.status !== "complete" || !Array.isArray(raw.segments)) return undefined;
  const viewport = isRecord(raw.viewport) ? raw.viewport as { width?: number; height?: number } : undefined;
  const screenshot = typeof raw.screenshot === "string" ? raw.screenshot : undefined;
  const items: AuditSection[] = [];
  for (const value of raw.segments) {
    if (!isRecord(value) || value.role === "ignore") continue;
    const evidence = isRecord(value.evidence) ? value.evidence : {};
    const rawRoots = Array.isArray(value.roots) ? value.roots.filter(isRecord) : [];
    const rootSelectors = rawRoots.map(root => typeof root.selector === "string" ? root.selector : "").filter(Boolean);
    const roots = rawRoots.flatMap(root => {
      const rootEvidence = isRecord(root.evidence) ? root.evidence : {};
      const rootSelector = typeof root.selector === "string" ? root.selector : typeof rootEvidence.selector === "string" ? rootEvidence.selector : undefined;
      const rootBox = isRecord(rootEvidence.box) && [rootEvidence.box.x, rootEvidence.box.y, rootEvidence.box.width, rootEvidence.box.height].every(item => Number.isFinite(Number(item)))
        ? { x: Number(rootEvidence.box.x), y: Number(rootEvidence.box.y), width: Number(rootEvidence.box.width), height: Number(rootEvidence.box.height) }
        : undefined;
      if (!rootSelector || !rootBox) return [];
      return [{
        selector: rootSelector,
        tag: typeof rootEvidence.tag === "string" ? rootEvidence.tag : typeof root.tag === "string" ? root.tag : "div",
        heading: typeof rootEvidence.heading === "string" ? rootEvidence.heading : undefined,
        content: isRecord(rootEvidence.content) ? rootEvidence.content as AuditLayoutNode["content"] : undefined,
        structure: isRecord(rootEvidence.structure) ? rootEvidence.structure as AuditLayoutNode["structure"] : undefined,
        style: isRecord(rootEvidence.style) ? rootEvidence.style as AuditLayoutNode["style"] : undefined,
        headingStyle: isRecord(rootEvidence.headingStyle) ? rootEvidence.headingStyle as AuditLayoutNode["headingStyle"] : undefined,
        box: rootBox
      } satisfies AuditLayoutNode];
    });
    const selectors = rootSelectors.length
      ? rootSelectors
      : Array.isArray(value.selectors)
        ? value.selectors.filter((item): item is string => typeof item === "string" && item.length > 0)
        : typeof value.selector === "string" && value.selector ? [value.selector] : typeof evidence.selector === "string" && evidence.selector ? [evidence.selector] : [];
    const clip = isRecord(value.screenshotClip) ? value.screenshotClip : undefined;
    const box = clip && [clip.x, clip.y, clip.width, clip.height].every(item => Number.isFinite(Number(item)))
      ? { x: Number(clip.x), y: Number(clip.y), width: Number(clip.width), height: Number(clip.height) }
      : isRecord(evidence.box) && [evidence.box.x, evidence.box.y, evidence.box.width, evidence.box.height].every(item => Number.isFinite(Number(item)))
        ? { x: Number(evidence.box.x), y: Number(evidence.box.y), width: Number(evidence.box.width), height: Number(evidence.box.height) }
        : undefined;
    if (!box) continue;
    const role = value.role === "header" || value.role === "footer" ? value.role : "section";
    items.push({
      auditId: typeof value.id === "string" ? value.id : `segment-${String(items.length + 1).padStart(2, "0")}`,
      source: "manual",
      role,
      label: typeof value.label === "string" ? value.label : undefined,
      tag: role === "header" || role === "footer" ? role : typeof evidence.tag === "string" ? evidence.tag : "section",
      selector: selectors[0] ?? (typeof evidence.selector === "string" ? evidence.selector : undefined),
      selectors: selectors.length > 0 ? [...new Set(selectors)] : undefined,
      heading: typeof evidence.heading === "string" ? evidence.heading : undefined,
      background: typeof evidence.background === "string" ? evidence.background : undefined,
      screenshot,
      screenshotClip: clip ? { x: Number(clip.x), y: Number(clip.y), width: Number(clip.width), height: Number(clip.height) } : undefined,
      box,
      content: isRecord(evidence.content) ? evidence.content as AuditSection["content"] : undefined,
      structure: isRecord(evidence.structure) ? evidence.structure as AuditSection["structure"] : undefined,
      style: isRecord(evidence.style) ? evidence.style as AuditSection["style"] : undefined,
      roots: roots.length > 0 ? roots : undefined,
      headingStyle: isRecord(evidence.headingStyle) ? evidence.headingStyle as AuditSection["headingStyle"] : undefined
    });
  }
  return items.length > 0 ? { viewport, items } : undefined;
}

async function loadAudit(input: string, root: string): Promise<AuditArtifact> {
  const auditRoot = await resolveAuditRoot(input, root);
  const audit = await readJson(join(auditRoot, "audit.json"), "MIGRATE_DESIGN_AUDIT_INVALID");
  if (audit.type !== "sitespec-migrate-audit" || audit.status !== "complete") {
    throw new MigrateDesignError(
      "MIGRATE_DESIGN_AUDIT_INCOMPLETE",
      `Expected a completed sitespec-migrate-audit at ${auditRoot}.`,
      { audit: auditRoot, type: audit.type, status: audit.status }
    );
  }
  const sourceUrl = typeof audit.sourceUrl === "string" ? audit.sourceUrl : undefined;
  if (!sourceUrl) throw new MigrateDesignError("MIGRATE_DESIGN_AUDIT_INVALID", `Audit is missing sourceUrl: ${auditRoot}`);
  const finalUrl = typeof audit.finalUrl === "string" ? audit.finalUrl : sourceUrl;

  const files = isRecord(audit.files) ? audit.files : {};
  const designFile = typeof files.designInventory === "string" ? files.designInventory : "design-inventory.json";
  const sectionsFile = typeof files.sections === "string" ? files.sections : "sections.json";
  const mediaFile = typeof files.media === "string" ? files.media : "media.json";
  const uiFile = typeof files.ui === "string" ? files.ui : "ui-inventory.json";
  const pageFile = typeof files.page === "string" ? files.page : "page.json";
  const segmentsFile = typeof files.segments === "string" ? files.segments : "segments.json";

  const [designRaw, sectionsRaw, mediaRaw, uiRaw, page, segmentsRaw] = await Promise.all([
    readJson(join(auditRoot, designFile), "MIGRATE_DESIGN_EVIDENCE_INVALID"),
    readJson(join(auditRoot, sectionsFile), "MIGRATE_DESIGN_EVIDENCE_INVALID"),
    readJson(join(auditRoot, mediaFile), "MIGRATE_DESIGN_EVIDENCE_INVALID"),
    readOptionalJson(join(auditRoot, uiFile)),
    readJson(join(auditRoot, pageFile), "MIGRATE_DESIGN_EVIDENCE_INVALID"),
    readOptionalJson(join(auditRoot, segmentsFile))
  ]);

  if (!isRecord(designRaw.aggregate)) {
    throw new MigrateDesignError("MIGRATE_DESIGN_EVIDENCE_INVALID", `design-inventory.json is missing aggregate evidence: ${auditRoot}`);
  }
  for (const category of ["colors", "typography", "radii", "shadows", "spacing", "containerWidths"]) {
    const group = designRaw.aggregate[category];
    if (!isRecord(group) || !Array.isArray(group.items)) {
      throw new MigrateDesignError("MIGRATE_DESIGN_EVIDENCE_INVALID", `design-inventory.json is missing ${category} items: ${auditRoot}`);
    }
  }
  if (!Array.isArray(sectionsRaw.items) || !Array.isArray(mediaRaw.items)) {
    throw new MigrateDesignError("MIGRATE_DESIGN_EVIDENCE_INVALID", `Audit section/media evidence is malformed: ${auditRoot}`);
  }
  const reviewed = manualSections(segmentsRaw);
  const regions = isRecord(sectionsRaw.regions)
    ? Object.fromEntries(Object.entries(sectionsRaw.regions).flatMap(([viewport, rawViewport]) => {
      if (!isRecord(rawViewport) || !Array.isArray(rawViewport.items)) return [];
      const items = rawViewport.items.map(normalizeLayoutNode).filter((item): item is AuditLayoutNode => Boolean(item));
      return [[viewport, { viewport: isRecord(rawViewport.viewport) ? rawViewport.viewport as { width?: number; height?: number } : undefined, items }]];
    }))
    : undefined;
  const manualRegions = isRecord(sectionsRaw.manualRegions)
    ? Object.fromEntries(Object.entries(sectionsRaw.manualRegions).flatMap(([viewport, rawViewport]) => {
      if (!isRecord(rawViewport) || !Array.isArray(rawViewport.items)) return [];
      const items = rawViewport.items.filter(isRecord).flatMap(value => {
        if (typeof value.sourceSelector !== "string") return [];
        const item = normalizeLayoutNode(value.item);
        if (!item) return [];
        const method = value.matchMethod === "selector" || value.matchMethod === "fingerprint" ? value.matchMethod : undefined;
        const score = Number(value.score);
        const boundary = normalizeLayoutNode(value.boundary);
        const boundaryConfidence = Number(value.boundaryConfidence);
        return [{
          targetId: typeof value.targetId === "string" ? value.targetId : undefined,
          segmentId: typeof value.segmentId === "string" ? value.segmentId : undefined,
          rootIndex: Number.isInteger(Number(value.rootIndex)) ? Number(value.rootIndex) : undefined,
          sourceSelector: value.sourceSelector,
          matchedSelector: typeof value.matchedSelector === "string" ? value.matchedSelector : item.selector,
          matchMethod: method,
          score: Number.isFinite(score) ? score : undefined,
          item,
          boundary: boundary ?? undefined,
          boundaryConfidence: Number.isFinite(boundaryConfidence) ? boundaryConfidence : undefined
        } satisfies ManualRegionMatch];
      });
      return [[viewport, { viewport: isRecord(rawViewport.viewport) ? rawViewport.viewport as { width?: number; height?: number } : undefined, items }]];
    }))
    : undefined;

  return {
    root: auditRoot,
    sourceUrl,
    finalUrl,
    page,
    design: {
      aggregate: designRaw.aggregate as unknown as AuditDesignInventory,
      viewports: isRecord(designRaw.viewports) ? designRaw.viewports as unknown as Record<string, AuditDesignInventory> : undefined
    },
    sections: {
      viewport: reviewed?.viewport ?? (isRecord(sectionsRaw.viewport) ? sectionsRaw.viewport as { width?: number; height?: number } : undefined),
      source: reviewed ? "manual" : "automatic",
      items: reviewed?.items ?? (sectionsRaw.items as AuditSection[]).map(section => ({ ...section, source: "automatic" as const })),
      regions,
      manualRegions
    },
    media: { items: mediaRaw.items as AuditMediaItem[] },
    ...(uiRaw && Array.isArray(uiRaw.items)
      ? { ui: { items: uiRaw.items.filter(isRecord) as unknown as Array<AuditLeafUiObservation & { viewport?: string }> } }
      : {})
  };
}

async function loadInputs(inputs: string[], root: string): Promise<LoadedInput> {
  if (inputs.length < 2) {
    throw new MigrateDesignError(
      "MIGRATE_DESIGN_AUDITS_TOO_FEW",
      "migrate design requires at least two completed audits so shared production patterns can be distinguished from page-specific ones.",
      { audits: inputs.length }
    );
  }
  const artifacts = await Promise.all(inputs.map(input => loadAudit(input, root)));
  const pageKeys = artifacts.map(item => new URL(item.sourceUrl).href);
  const duplicates = [...new Set(pageKeys.filter((value, index) => pageKeys.indexOf(value) !== index))];
  if (duplicates.length > 0) {
    throw new MigrateDesignError(
      "MIGRATE_DESIGN_AUDITS_DUPLICATE",
      "migrate design requires distinct representative page audits; the same source URL was supplied more than once.",
      { duplicates }
    );
  }
  const hosts = [...new Set(artifacts.map(item => normalizedHost(item.sourceUrl)))];
  if (hosts.length !== 1) {
    throw new MigrateDesignError(
      "MIGRATE_DESIGN_SITE_MISMATCH",
      "All migrate design inputs must belong to the same production host.",
      { hosts }
    );
  }
  return { artifacts, host: hosts[0]! };
}

export function resolveDesignOutputDirectory(root: string, host: string, output?: string): string {
  if (output) return isAbsolute(output) ? output : resolve(root, output);
  return join(resolve(root), ".sitespec", "migration", slug(host), "design");
}

export async function prepareDesignOutputDirectory(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length === 0) return;
    try {
      const previous = JSON.parse(await readFile(join(output, "report.json"), "utf8")) as { type?: string };
      if (previous.type === "sitespec-migrate-design") {
        const preservedReviews = new Map<string, string>();
        for (const file of ["foundation-review.json", "component-review.json", "ui-review.json"]) {
          try {
            preservedReviews.set(file, await readFile(join(output, file), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await rm(output, { recursive: true, force: true });
        if (preservedReviews.size > 0) {
          await mkdir(output, { recursive: true });
          for (const [file, value] of preservedReviews) await writeFile(join(output, file), value, "utf8");
        }
        return;
      }
    } catch {
      // Never remove a directory not marked as SiteSpec migration analysis output.
    }
    throw new MigrateDesignError(
      "MIGRATE_DESIGN_OUTPUT_NOT_EMPTY",
      `Design analysis output directory is not empty and is not owned by a previous migrate design run: ${output}`,
      { output }
    );
  } catch (error) {
    if (error instanceof MigrateDesignError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function evidenceConfidence(count: number, coverage: number): number {
  const occurrence = Math.min(1, Math.log10(Math.max(1, count) + 1) / 2);
  return round(clamp(0.28 + 0.47 * coverage + 0.25 * occurrence));
}

function mergeFoundationCategory(
  artifacts: AuditArtifact[],
  category: keyof Omit<AuditDesignInventory, "elements">
): FoundationEvidenceItem[] {
  const merged = new Map<string, FoundationEvidenceItem>();
  for (const artifact of artifacts) {
    const id = pageId(artifact.sourceUrl);
    const group = artifact.design.aggregate[category];
    for (const item of group.items) {
      const current = merged.get(item.key) ?? {
        key: item.key,
        value: item.value,
        count: 0,
        pages: [],
        pageCounts: {},
        coverage: 0,
        confidence: 0,
        properties: {},
        viewports: {},
        style: item.style
      };
      current.count += item.count;
      current.pageCounts[id] = (current.pageCounts[id] ?? 0) + item.count;
      if (!current.pages.includes(id)) current.pages.push(id);
      if (item.properties) {
        current.properties ??= {};
        for (const [property, count] of Object.entries(item.properties)) current.properties[property] = (current.properties[property] ?? 0) + count;
      }
      if (item.viewports) {
        current.viewports ??= {};
        for (const [viewport, count] of Object.entries(item.viewports)) current.viewports[viewport] = (current.viewports[viewport] ?? 0) + count;
      }
      if (!current.style && item.style) current.style = item.style;
      merged.set(item.key, current);
    }
  }
  for (const item of merged.values()) {
    item.pages.sort();
    item.coverage = round(item.pages.length / artifacts.length);
    item.confidence = evidenceConfidence(item.count, item.coverage);
    if (item.properties && Object.keys(item.properties).length === 0) delete item.properties;
    if (item.viewports && Object.keys(item.viewports).length === 0) delete item.viewports;
  }
  return [...merged.values()].sort((a, b) => b.count - a.count || b.coverage - a.coverage || a.key.localeCompare(b.key));
}

export function aggregateAuditFoundations(artifacts: Array<{ sourceUrl: string; design: { aggregate: AuditDesignInventory } }>): DesignFoundations {
  const normalized = artifacts as AuditArtifact[];
  return {
    pages: artifacts.length,
    colors: mergeFoundationCategory(normalized, "colors"),
    typography: mergeFoundationCategory(normalized, "typography"),
    radii: mergeFoundationCategory(normalized, "radii"),
    shadows: mergeFoundationCategory(normalized, "shadows"),
    spacing: mergeFoundationCategory(normalized, "spacing"),
    containerWidths: mergeFoundationCategory(normalized, "containerWidths")
  };
}

function candidateName(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function numberFromCss(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(?:px|rem|em|%)?$/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : undefined;
}

interface CssDimension {
  value: number;
  unit: "px" | "rem" | "em" | "%" | "";
}

function parseCssDimension(value: string | undefined): CssDimension | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(px|rem|em|%)?$/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  return { value: number, unit: (match[2]?.toLowerCase() ?? "") as CssDimension["unit"] };
}

function stableNumber(value: number, places = 3): number {
  return Number(value.toFixed(places));
}

function stableDimension(value: number, unit: CssDimension["unit"]): string {
  return `${stableNumber(value)}${unit}`;
}

function mergeNumberRecords(target: Record<string, number>, source: Record<string, number> | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizePages(items: FoundationEvidenceItem[]): string[] {
  return [...new Set(items.flatMap(item => item.pages))].sort();
}

interface NormalizedEvidenceItem {
  key: string;
  value: string | number;
  count: number;
  pages: string[];
  coverage: number;
  confidence: number;
  properties?: Record<string, number>;
  viewports?: Record<string, number>;
  rawValues: string[];
}

interface NormalizedTypographyStyle {
  key: string;
  style: Record<string, string>;
  count: number;
  pages: string[];
  coverage: number;
  confidence: number;
  rawStyles: number;
  lineHeightRatios: Record<string, number>;
}

interface TokenNormalizationState {
  rejected: TokenNormalizationRejection[];
  normalizedCounts: Record<TokenNormalizationCategory, number>;
  adjustments: Record<string, number>;
}

function createNormalizationState(): TokenNormalizationState {
  return {
    rejected: [],
    normalizedCounts: { color: 0, spacing: 0, radius: 0, shadow: 0, size: 0, typography: 0 },
    adjustments: {}
  };
}

function addAdjustment(state: TokenNormalizationState, reason: string, amount = 1): void {
  state.adjustments[reason] = (state.adjustments[reason] ?? 0) + amount;
}

function rejectEvidence(state: TokenNormalizationState, category: TokenNormalizationCategory, item: FoundationEvidenceItem, reason: string): void {
  state.rejected.push({
    category,
    value: item.value ?? item.key,
    reason,
    count: item.count,
    pages: item.pages
  });
}

function srgbCompand(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, encoded)) * 255);
}

function parsePercentOrNumber(value: string, percentScale = 1): number | undefined {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const numeric = Number(trimmed.slice(0, -1));
    return Number.isFinite(numeric) ? numeric / 100 * percentScale : undefined;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

interface CanonicalColor {
  value: string;
  alpha: number;
}

function colorValue(r: number, g: number, b: number, alpha = 1): CanonicalColor {
  const rr = Math.max(0, Math.min(255, Math.round(r)));
  const gg = Math.max(0, Math.min(255, Math.round(g)));
  const bb = Math.max(0, Math.min(255, Math.round(b)));
  const aa = Math.max(0, Math.min(1, alpha));
  if (aa >= 0.9995) {
    return { value: `#${[rr, gg, bb].map(channel => channel.toString(16).padStart(2, "0")).join("")}`, alpha: 1 };
  }
  return { value: `rgba(${rr}, ${gg}, ${bb}, ${stableNumber(aa)})`, alpha: stableNumber(aa) };
}

function canonicalCssColor(raw: string): CanonicalColor | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "black") return colorValue(0, 0, 0);
  if (value === "white") return colorValue(255, 255, 255);
  if (value === "transparent") return colorValue(0, 0, 0, 0);

  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let body = hex[1]!;
    if (body.length === 3 || body.length === 4) body = body.split("").map(char => char + char).join("");
    if (body.length === 6 || body.length === 8) {
      const r = parseInt(body.slice(0, 2), 16);
      const g = parseInt(body.slice(2, 4), 16);
      const b = parseInt(body.slice(4, 6), 16);
      const alpha = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
      return colorValue(r, g, b, alpha);
    }
  }

  const rgb = value.match(/^rgba?\((.*)\)$/i);
  if (rgb) {
    const [channelsRaw, parsedAlphaRaw] = rgb[1]!.split(/\s*\/\s*/, 2);
    let alphaRaw = parsedAlphaRaw;
    const channels = channelsRaw!.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
    if (channels.length === 4 && alphaRaw === undefined) alphaRaw = channels.pop();
    if (channels.length !== 3) return undefined;
    const parsed = channels.map(channel => channel.endsWith("%") ? parsePercentOrNumber(channel, 255) : Number(channel));
    if (parsed.some(channel => channel === undefined || !Number.isFinite(channel))) return undefined;
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.trim().endsWith("%") ? parsePercentOrNumber(alphaRaw, 1) : Number(alphaRaw);
    if (alpha === undefined || !Number.isFinite(alpha)) return undefined;
    return colorValue(parsed[0]!, parsed[1]!, parsed[2]!, alpha);
  }

  const lab = value.match(/^lab\((.*)\)$/i);
  if (lab) {
    const [channelsRaw, alphaRaw] = lab[1]!.split(/\s*\/\s*/, 2);
    const channels = channelsRaw!.trim().split(/\s+/).filter(Boolean);
    if (channels.length !== 3 || channels[1]!.endsWith("%") || channels[2]!.endsWith("%")) return undefined;
    const l = parsePercentOrNumber(channels[0]!, 100);
    const a = Number(channels[1]);
    const b = Number(channels[2]);
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.trim().endsWith("%") ? parsePercentOrNumber(alphaRaw, 1) : Number(alphaRaw);
    if (![l, a, b, alpha].every(item => item !== undefined && Number.isFinite(item))) return undefined;

    const fy = (l! + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const epsilon = 216 / 24389;
    const kappa = 24389 / 27;
    const inverse = (component: number): number => component ** 3 > epsilon ? component ** 3 : (116 * component - 16) / kappa;
    const x50 = 0.96422 * inverse(fx);
    const y50 = inverse(fy);
    const z50 = 0.82521 * inverse(fz);
    const x = 0.9555766 * x50 - 0.0230393 * y50 + 0.0631636 * z50;
    const y = -0.0282895 * x50 + 1.0099416 * y50 + 0.0210077 * z50;
    const z = 0.0122982 * x50 - 0.020483 * y50 + 1.3299098 * z50;
    const red = 3.2406 * x - 1.5372 * y - 0.4986 * z;
    const green = -0.9689 * x + 1.8758 * y + 0.0415 * z;
    const blue = 0.0557 * x - 0.204 * y + 1.057 * z;
    return colorValue(srgbCompand(red), srgbCompand(green), srgbCompand(blue), alpha as number);
  }

  const oklab = value.match(/^oklab\((.*)\)$/i);
  if (oklab) {
    const [channelsRaw, alphaRaw] = oklab[1]!.split(/\s*\/\s*/, 2);
    const channels = channelsRaw!.trim().split(/\s+/).filter(Boolean);
    if (channels.length !== 3 || channels[1]!.endsWith("%") || channels[2]!.endsWith("%")) return undefined;
    const l = channels[0]!.endsWith("%") ? parsePercentOrNumber(channels[0]!, 1) : Number(channels[0]);
    const a = Number(channels[1]);
    const b = Number(channels[2]);
    const alpha = alphaRaw === undefined ? 1 : alphaRaw.trim().endsWith("%") ? parsePercentOrNumber(alphaRaw, 1) : Number(alphaRaw);
    if (![l, a, b, alpha].every(item => item !== undefined && Number.isFinite(item))) return undefined;
    const ll = l! + 0.3963377774 * a + 0.2158037573 * b;
    const mm = l! - 0.1055613458 * a - 0.0638541728 * b;
    const ss = l! - 0.0894841775 * a - 1.291485548 * b;
    const l3 = ll ** 3;
    const m3 = mm ** 3;
    const s3 = ss ** 3;
    const red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
    return colorValue(srgbCompand(red), srgbCompand(green), srgbCompand(blue), alpha as number);
  }

  return undefined;
}

function normalizedColorEvidence(foundations: DesignFoundations, state: TokenNormalizationState): NormalizedEvidenceItem[] {
  const merged = new Map<string, { items: FoundationEvidenceItem[]; count: number; properties: Record<string, number>; rawValues: string[] }>();
  for (const item of foundations.colors) {
    const raw = item.value ?? item.key;
    if (/^url\(/i.test(raw)) {
      rejectEvidence(state, "color", item, "svgPaintReference");
      continue;
    }
    const canonical = canonicalCssColor(raw);
    if (!canonical) {
      rejectEvidence(state, "color", item, "unsupportedColorSyntax");
      continue;
    }
    if (canonical.alpha <= 0.001) {
      rejectEvidence(state, "color", item, "transparentColor");
      continue;
    }
    const properties = item.properties ?? {};
    const meaningful: Record<string, number> = {};
    for (const property of ["color", "backgroundColor", "fill", "stroke"]) {
      const count = properties[property] ?? 0;
      if (count > 0) meaningful[property] = count;
    }
    const borderCount = (properties.borderTopColor ?? 0) + (properties.borderRightColor ?? 0) + (properties.borderBottomColor ?? 0) + (properties.borderLeftColor ?? 0);
    if (borderCount > 0) addAdjustment(state, "defaultBorderOccurrencesIgnored", borderCount);
    const meaningfulCount = Object.values(meaningful).reduce((sum, count) => sum + count, 0);
    if (meaningfulCount <= 0) {
      rejectEvidence(state, "color", item, borderCount > 0 ? "inactiveBorderOnly" : "noMeaningfulColorUsage");
      continue;
    }
    const current = merged.get(canonical.value) ?? { items: [], count: 0, properties: {}, rawValues: [] };
    current.items.push(item);
    current.count += meaningfulCount;
    mergeNumberRecords(current.properties, meaningful);
    if (!current.rawValues.includes(raw)) current.rawValues.push(raw);
    merged.set(canonical.value, current);
  }
  const result = [...merged.entries()].map(([key, group]): NormalizedEvidenceItem => {
    const pages = normalizePages(group.items);
    const coverage = round(pages.length / Math.max(1, foundations.pages));
    if (group.rawValues.length > 1) addAdjustment(state, "equivalentColorValuesMerged", group.rawValues.length - 1);
    return {
      key,
      value: key,
      count: group.count,
      pages,
      coverage,
      confidence: evidenceConfidence(group.count, coverage),
      properties: sortedRecord(group.properties),
      rawValues: [...group.rawValues].sort()
    };
  }).sort((a, b) => b.count - a.count || b.coverage - a.coverage || a.key.localeCompare(b.key));
  state.normalizedCounts.color = result.length;
  return result;
}

function normalizedSpacingProperties(properties: Record<string, number> | undefined, state: TokenNormalizationState): { properties: Record<string, number>; count: number; structural: number; margins: number } {
  const source = properties ?? {};
  const result: Record<string, number> = {};
  const gapCounts = [source.gap ?? 0, source.rowGap ?? 0, source.columnGap ?? 0];
  const gap = Math.max(...gapCounts);
  if (gap > 0) result.gap = gap;
  const duplicateGap = gapCounts.reduce((sum, value) => sum + value, 0) - gap;
  if (duplicateGap > 0) addAdjustment(state, "duplicateGapOccurrencesCollapsed", duplicateGap);
  for (const property of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft"]) {
    const count = source[property] ?? 0;
    if (count > 0) result[property] = count;
  }
  const structural = gap + ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].reduce((sum, property) => sum + (result[property] ?? 0), 0);
  const margins = ["marginTop", "marginRight", "marginBottom", "marginLeft"].reduce((sum, property) => sum + (result[property] ?? 0), 0);
  return { properties: result, count: structural + margins, structural, margins };
}

function normalizedSpacingEvidence(foundations: DesignFoundations, state: TokenNormalizationState): NormalizedEvidenceItem[] {
  const accepted: NormalizedEvidenceItem[] = [];
  for (const item of foundations.spacing) {
    const raw = item.value ?? item.key;
    const dimension = parseCssDimension(raw);
    if (!dimension || !["px", "rem", "em"].includes(dimension.unit)) {
      rejectEvidence(state, "spacing", item, /\s/.test(raw.trim()) ? "nonAtomicSpacing" : "unsupportedSpacingSyntax");
      continue;
    }
    if (dimension.value < 0) {
      rejectEvidence(state, "spacing", item, "negativeSpacing");
      continue;
    }
    if (dimension.value === 0) {
      rejectEvidence(state, "spacing", item, "zeroSpacing");
      continue;
    }
    if (dimension.unit === "px" && Math.abs(dimension.value - Math.round(dimension.value)) > 0.05) {
      rejectEvidence(state, "spacing", item, "subpixelLayoutArtifact");
      continue;
    }
    if (dimension.unit === "px" && dimension.value > 128) {
      rejectEvidence(state, "spacing", item, "layoutArtifact");
      continue;
    }
    const usage = normalizedSpacingProperties(item.properties, state);
    if (usage.count < 6 && item.coverage < 1) {
      rejectEvidence(state, "spacing", item, "lowSupport");
      continue;
    }
    if (usage.structural === 0 && usage.margins > 0 && (item.coverage < 1 && usage.count < 20 || usage.count < 8)) {
      rejectEvidence(state, "spacing", item, "contextualMargin");
      continue;
    }
    const value = dimension.unit === "px" && Math.abs(dimension.value - Math.round(dimension.value)) <= 0.05
      ? `${Math.round(dimension.value)}px`
      : stableDimension(dimension.value, dimension.unit);
    accepted.push({
      key: value,
      value,
      count: usage.count || item.count,
      pages: item.pages,
      coverage: item.coverage,
      confidence: evidenceConfidence(usage.count || item.count, item.coverage),
      properties: sortedRecord(usage.properties),
      rawValues: [raw]
    });
  }
  accepted.sort((a, b) => b.count - a.count || b.coverage - a.coverage || Number(numberFromCss(a.key) ?? 0) - Number(numberFromCss(b.key) ?? 0));
  state.normalizedCounts.spacing = accepted.length;
  return accepted;
}

function normalizedRadiusEvidence(foundations: DesignFoundations, state: TokenNormalizationState): NormalizedEvidenceItem[] {
  const merged = new Map<string, { items: FoundationEvidenceItem[]; rawValues: string[]; count: number }>();
  for (const item of foundations.radii) {
    const raw = item.value ?? item.key;
    const dimension = parseCssDimension(raw);
    if (!dimension || !["px", "rem", "em"].includes(dimension.unit)) {
      rejectEvidence(state, "radius", item, "nonAtomicRadius");
      continue;
    }
    if (dimension.value <= 0) {
      rejectEvidence(state, "radius", item, "zeroRadius");
      continue;
    }
    if (item.count < 6 && item.coverage < 1) {
      rejectEvidence(state, "radius", item, "lowSupportRadius");
      continue;
    }
    const full = dimension.unit === "px" && dimension.value >= 999;
    if (!full && dimension.unit === "px" && Math.abs(dimension.value - Math.round(dimension.value)) > 0.05) {
      rejectEvidence(state, "radius", item, "subpixelLayoutArtifact");
      continue;
    }
    const value = full ? "9999px" : dimension.unit === "px" ? `${Math.round(dimension.value)}px` : stableDimension(dimension.value, dimension.unit);
    if (full) addAdjustment(state, "fullRadiusValuesCanonicalized");
    const current = merged.get(value) ?? { items: [], rawValues: [], count: 0 };
    current.items.push(item);
    current.count += item.count;
    if (!current.rawValues.includes(raw)) current.rawValues.push(raw);
    merged.set(value, current);
  }
  const result = [...merged.entries()].map(([key, group]): NormalizedEvidenceItem => {
    const pages = normalizePages(group.items);
    const coverage = round(pages.length / Math.max(1, foundations.pages));
    return { key, value: key, count: group.count, pages, coverage, confidence: evidenceConfidence(group.count, coverage), rawValues: [...group.rawValues].sort() };
  }).sort((a, b) => b.count - a.count || Number(numberFromCss(a.key) ?? 0) - Number(numberFromCss(b.key) ?? 0));
  state.normalizedCounts.radius = result.length;
  return result;
}

function splitCssTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function transparentZeroShadow(layer: string): boolean {
  const color = layer.match(/^(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s+(.*)$/i);
  if (!color) return false;
  const parsed = canonicalCssColor(color[1]!);
  if (!parsed || parsed.alpha > 0.001) return false;
  const numbers = color[2]!.match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  return numbers.length >= 2 && numbers.every(value => Math.abs(value) <= 0.0001);
}

function normalizedShadowEvidence(foundations: DesignFoundations, state: TokenNormalizationState): NormalizedEvidenceItem[] {
  const merged = new Map<string, { items: FoundationEvidenceItem[]; rawValues: string[]; count: number }>();
  for (const item of foundations.shadows) {
    const raw = item.value ?? item.key;
    const layers = splitCssTopLevel(raw);
    const kept = layers.filter(layer => !transparentZeroShadow(layer));
    const removed = layers.length - kept.length;
    if (removed > 0) addAdjustment(state, "transparentShadowLayersRemoved", removed);
    if (kept.length === 0) {
      rejectEvidence(state, "shadow", item, "transparentShadow");
      continue;
    }
    const value = kept.join(", ");
    const current = merged.get(value) ?? { items: [], rawValues: [], count: 0 };
    current.items.push(item);
    current.count += item.count;
    if (!current.rawValues.includes(raw)) current.rawValues.push(raw);
    merged.set(value, current);
  }
  const result = [...merged.entries()].map(([key, group]): NormalizedEvidenceItem => {
    const pages = normalizePages(group.items);
    const coverage = round(pages.length / Math.max(1, foundations.pages));
    return { key, value: key, count: group.count, pages, coverage, confidence: evidenceConfidence(group.count, coverage), rawValues: [...group.rawValues].sort() };
  }).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  state.normalizedCounts.shadow = result.length;
  return result;
}

function dominantViewport(item: FoundationEvidenceItem): string {
  const entries = Object.entries(item.viewports ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0]?.[0] ?? "unknown";
}

function normalizedSizeEvidence(foundations: DesignFoundations, state: TokenNormalizationState): NormalizedEvidenceItem[] {
  const eligible = new Map<string, Array<{ item: FoundationEvidenceItem; dimension: CssDimension }>>();
  for (const item of foundations.containerWidths) {
    const raw = item.value ?? item.key;
    const dimension = parseCssDimension(raw);
    if (!dimension || dimension.unit !== "px" || Math.abs(dimension.value - Math.round(dimension.value)) > 0.05 || dimension.value < 280 || dimension.value > 2000) {
      rejectEvidence(state, "size", item, "layoutWidthArtifact");
      continue;
    }
    if (item.count < 2) {
      rejectEvidence(state, "size", item, "lowSupport");
      continue;
    }
    const viewport = dominantViewport(item);
    const list = eligible.get(viewport) ?? [];
    list.push({ item, dimension });
    eligible.set(viewport, list);
  }

  const viewportOrder = new Map(["desktop", "tablet", "mobile", "unknown"].map((value, index) => [value, index]));
  const selected: Array<{ item: FoundationEvidenceItem; dimension: CssDimension; viewport: string }> = [];
  for (const [viewport, values] of eligible) {
    values.sort((a, b) => b.item.count - a.item.count || b.item.coverage - a.item.coverage || b.dimension.value - a.dimension.value);
    values.forEach((entry, index) => {
      if (index < 3) selected.push({ ...entry, viewport });
      else rejectEvidence(state, "size", entry.item, "secondaryLayoutWidth");
    });
  }
  selected.sort((a, b) => (viewportOrder.get(a.viewport) ?? 99) - (viewportOrder.get(b.viewport) ?? 99) || b.item.count - a.item.count || b.dimension.value - a.dimension.value);
  const result = selected.map(({ item, dimension, viewport }): NormalizedEvidenceItem => ({
    key: `${Math.round(dimension.value)}px`,
    value: `${Math.round(dimension.value)}px`,
    count: item.count,
    pages: item.pages,
    coverage: item.coverage,
    confidence: evidenceConfidence(item.count, item.coverage),
    viewports: item.viewports ? sortedRecord(item.viewports) : viewport === "unknown" ? undefined : { [viewport]: item.count },
    rawValues: [item.value ?? item.key]
  }));
  state.normalizedCounts.size = result.length;
  return result;
}

const GENERIC_FONT_FAMILIES = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "arial", "helvetica"]);

function canonicalFontFamily(value: string): string {
  const seen = new Set<string>();
  const families = value.split(",").map(item => item.trim()).filter(Boolean).filter(item => {
    const key = item.replace(/^['"]|['"]$/g, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const primary = families.find(item => !GENERIC_FONT_FAMILIES.has(item.replace(/^['"]|['"]$/g, "").toLowerCase()));
  const generic = [...families].reverse().find(item => ["serif", "sans-serif", "monospace"].includes(item.replace(/^['"]|['"]$/g, "").toLowerCase())) ?? "sans-serif";
  if (primary) {
    const rawName = primary.replace(/^['"]|['"]$/g, "");
    const displayName = /\s/.test(rawName) ? `"${rawName}"` : rawName;
    return `${displayName}, ${generic.replace(/^['"]|['"]$/g, "").toLowerCase()}`;
  }
  return families.join(", ");
}

function canonicalLetterSpacing(value: string | undefined): string {
  if (!value || value.toLowerCase() === "normal") return "normal";
  const dimension = parseCssDimension(value);
  if (!dimension) return value.trim();
  if (dimension.unit === "%") return `${stableNumber(dimension.value / 100, 4)}em`;
  return stableDimension(dimension.value, dimension.unit);
}

function typographyLineHeightRatio(style: Record<string, string>): number | undefined {
  const fontSize = parseCssDimension(style.fontSize);
  const lineHeight = parseCssDimension(style.lineHeight);
  if (!fontSize || !lineHeight || fontSize.value <= 0 || fontSize.unit !== lineHeight.unit) return undefined;
  const ratio = lineHeight.value / fontSize.value;
  return Number.isFinite(ratio) ? stableNumber(ratio) : undefined;
}

function normalizedTypographyEvidence(foundations: DesignFoundations, state: TokenNormalizationState): NormalizedTypographyStyle[] {
  interface Group {
    items: FoundationEvidenceItem[];
    count: number;
    pages: Set<string>;
    ratio: number;
    style: Record<string, string>;
  }
  const groups = new Map<string, Group>();
  for (const item of foundations.typography) {
    const style = item.style ?? {};
    const family = style.fontFamily ? canonicalFontFamily(style.fontFamily) : undefined;
    const fontSize = parseCssDimension(style.fontSize);
    const fontWeight = style.fontWeight?.trim();
    const ratio = typographyLineHeightRatio(style);
    if (!family || !fontSize || !["px", "rem", "em"].includes(fontSize.unit) || !fontWeight || ratio === undefined) {
      rejectEvidence(state, "typography", item, "incompleteTypographyStyle");
      continue;
    }
    if (fontSize.unit === "px" && fontSize.value < 10) {
      rejectEvidence(state, "typography", item, "tinyTypographyArtifact");
      continue;
    }
    if (ratio < 0.8 || ratio > 2.2) {
      rejectEvidence(state, "typography", item, "lineHeightArtifact");
      continue;
    }
    const sizeValue = fontSize.unit === "px" && Math.abs(fontSize.value - Math.round(fontSize.value)) <= 0.05 ? `${Math.round(fontSize.value)}px` : stableDimension(fontSize.value, fontSize.unit);
    const letterSpacing = canonicalLetterSpacing(style.letterSpacing);
    const textTransform = style.textTransform?.toLowerCase() ?? "none";
    const groupKey = [family, sizeValue, fontWeight, ratio, letterSpacing, textTransform].join(" | ");
    const current = groups.get(groupKey) ?? {
      items: [], count: 0, pages: new Set<string>(), ratio,
      style: { fontFamily: family, fontSize: sizeValue, fontWeight, letterSpacing, textTransform, lineHeight: String(ratio) }
    };
    current.items.push(item);
    current.count += item.count;
    item.pages.forEach(page => current.pages.add(page));
    groups.set(groupKey, current);
    if (family !== style.fontFamily) addAdjustment(state, "fontFallbackStacksCanonicalized");
  }

  const result: NormalizedTypographyStyle[] = [];
  for (const [key, group] of groups) {
    const pages = [...group.pages].sort();
    const coverage = round(pages.length / Math.max(1, foundations.pages));
    const fontSize = numberFromCss(group.style.fontSize) ?? 16;
    const supported = group.count >= 6 || coverage >= 1 || fontSize >= 48 && group.count >= 3;
    if (!supported) {
      for (const item of group.items) rejectEvidence(state, "typography", item, "lowSupportTypography");
      continue;
    }
    if (group.items.length > 1) addAdjustment(state, "equivalentTypographyStylesMerged", group.items.length - 1);
    result.push({
      key,
      style: group.style,
      count: group.count,
      pages,
      coverage,
      confidence: evidenceConfidence(group.count, coverage),
      rawStyles: group.items.length,
      lineHeightRatios: { [String(group.ratio)]: group.count }
    });
  }
  result.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  state.normalizedCounts.typography = result.length;
  return result;
}

function primitiveFromNormalizedEvidence(
  items: NormalizedEvidenceItem[],
  group: PrimitiveTokenCandidate["group"],
  type: PrimitiveTokenCandidate["type"],
  prefix: string
): PrimitiveTokenCandidate[] {
  let genericIndex = 0;
  return items.map(item => {
    const isFullRadius = group === "radius" && item.value === "9999px";
    const id = isFullRadius ? "primitive.radius.full" : `primitive.${prefix}.${candidateName(genericIndex++)}`;
    return {
      id,
      group,
      type,
      value: item.value,
      confidence: item.confidence,
      evidence: {
        count: item.count,
        pages: item.pages,
        coverage: item.coverage,
        properties: item.properties,
        viewports: item.viewports,
        rawValues: item.rawValues
      }
    };
  });
}

interface DerivedTypographyValue {
  key: string;
  value: string | number;
  count: number;
  pages: Set<string>;
}

function deriveTypographyPrimitives(typography: NormalizedTypographyStyle[], pagesTotal: number): PrimitiveTokenCandidate[] {
  const categories: Array<{
    key: "fontFamily" | "fontSize" | "lineHeight" | "fontWeight" | "letterSpacing";
    group: PrimitiveTokenCandidate["group"];
    prefix: string;
    type: PrimitiveTokenCandidate["type"];
  }> = [
    { key: "fontFamily", group: "font.family", prefix: "font.family", type: "fontFamily" },
    { key: "fontSize", group: "font.size", prefix: "font.size", type: "dimension" },
    { key: "lineHeight", group: "font.lineHeight", prefix: "font.lineHeight", type: "number" },
    { key: "fontWeight", group: "font.weight", prefix: "font.weight", type: "number" },
    { key: "letterSpacing", group: "font.letterSpacing", prefix: "font.letterSpacing", type: "dimension" }
  ];
  const result: PrimitiveTokenCandidate[] = [];
  for (const category of categories) {
    const merged = new Map<string, DerivedTypographyValue>();
    for (const item of typography) {
      const raw = item.style[category.key];
      if (!raw || category.key === "letterSpacing" && raw === "normal") continue;
      const numeric = category.type === "number" ? Number(raw) : undefined;
      const value: string | number = numeric !== undefined && Number.isFinite(numeric) ? numeric : raw;
      const key = String(value);
      const current = merged.get(key) ?? { key, value, count: 0, pages: new Set<string>() };
      current.count += item.count;
      item.pages.forEach(page => current.pages.add(page));
      merged.set(key, current);
    }
    const values = [...merged.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    values.forEach((item, index) => {
      const coverage = round(item.pages.size / Math.max(1, pagesTotal));
      result.push({
        id: `primitive.${category.prefix}.${candidateName(index)}`,
        group: category.group,
        type: category.type,
        value: item.value,
        confidence: evidenceConfidence(item.count, coverage),
        evidence: { count: item.count, pages: [...item.pages].sort(), coverage }
      });
    });
  }
  return result;
}

function dominantColorRoleFromProperties(properties: Record<string, number> | undefined): { role: "text" | "surface" | "foreground"; share: number } | undefined {
  const source = properties ?? {};
  const buckets = {
    text: source.color ?? 0,
    surface: source.backgroundColor ?? 0,
    foreground: (source.fill ?? 0) + (source.stroke ?? 0)
  };
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  if (total === 0) return undefined;
  const entries = Object.entries(buckets).sort((a, b) => b[1] - a[1]) as Array<[keyof typeof buckets, number]>;
  const [role, count] = entries[0]!;
  const share = count / total;
  if (share < 0.62) return undefined;
  return { role, share };
}

function semanticCandidates(primitives: PrimitiveTokenCandidate[]): SemanticTokenCandidate[] {
  const results: SemanticTokenCandidate[] = [];
  const counters = new Map<string, number>();
  for (const primitive of primitives.filter(item => item.group === "color")) {
    const dominant = dominantColorRoleFromProperties(primitive.evidence.properties);
    if (!dominant) continue;
    const number = (counters.get(dominant.role) ?? 0) + 1;
    counters.set(dominant.role, number);
    const roleName = dominant.role === "foreground" ? "icon" : dominant.role;
    results.push({
      id: `semantic.color.${roleName}.candidate-${String(number).padStart(2, "0")}`,
      role: `color.${roleName}`,
      primitive: primitive.id,
      confidence: round(primitive.confidence * (0.55 + dominant.share * 0.35)),
      reason: `${Math.round(dominant.share * 100)}% of normalized meaningful color uses are ${dominant.role === "surface" ? "backgroundColor" : dominant.role}; inactive computed border colors are excluded before this inference.`,
      evidence: { count: primitive.evidence.count, pages: primitive.evidence.pages, properties: primitive.evidence.properties }
    });
  }

  const desktopSizes = primitives.filter(item => item.group === "size" && (item.evidence.viewports?.desktop ?? 0) > 0);
  const fallbackSizes = primitives.filter(item => item.group === "size");
  const widthPrimitive = (desktopSizes.length ? desktopSizes : fallbackSizes).sort((a, b) => b.evidence.count - a.evidence.count)[0];
  if (widthPrimitive && widthPrimitive.evidence.coverage >= 0.5) {
    results.push({
      id: "semantic.size.content.candidate-01",
      role: "size.content",
      primitive: widthPrimitive.id,
      confidence: round(widthPrimitive.confidence * 0.72),
      reason: "This is the strongest normalized centered-container width for the desktop (or best available) viewport; confirm that it represents the canonical content container.",
      evidence: { count: widthPrimitive.evidence.count, pages: widthPrimitive.evidence.pages }
    });
  }
  return results.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}

function typographyRole(style: Record<string, string>): string {
  const size = numberFromCss(style.fontSize) ?? 16;
  const transform = style.textTransform?.toLowerCase();
  if (transform === "uppercase" && size <= 18) return "label";
  if (size >= 48) return "display";
  if (size >= 28) return "heading";
  if (size >= 20) return "lead";
  if (size <= 14) return "small";
  return "body";
}

function typographyWeightName(weight: string | undefined): string {
  const numeric = Number(weight);
  if (!Number.isFinite(numeric)) return "regular";
  if (numeric >= 700) return "bold";
  if (numeric >= 600) return "semibold";
  if (numeric >= 500) return "medium";
  return "regular";
}

function typographyRoleName(style: Record<string, string>): string {
  const base = typographyRole(style);
  const size = Math.round(numberFromCss(style.fontSize) ?? 16);
  const weight = typographyWeightName(style.fontWeight);
  const tracked = style.letterSpacing && style.letterSpacing !== "normal" ? "-tracked" : "";
  const transformed = style.textTransform && style.textTransform !== "none" ? `-${style.textTransform}` : "";
  const lineHeight = style.lineHeight ? `-lh-${style.lineHeight.replace(".", "-")}` : "";
  return `${base}-${size}-${weight}${tracked}${transformed}${lineHeight}`;
}

function typographyCandidates(items: NormalizedTypographyStyle[]): TypographyCandidate[] {
  return items.map(item => ({
    id: `typography-${slug(typographyRoleName(item.style))}`,
    suggestedRole: typographyRoleName(item.style),
    confidence: round(item.confidence * 0.78),
    style: item.style,
    evidence: {
      count: item.count,
      pages: item.pages,
      coverage: item.coverage,
      rawStyles: item.rawStyles,
      lineHeightRatios: item.lineHeightRatios
    }
  }));
}

function normalizationReport(foundations: DesignFoundations, state: TokenNormalizationState): TokenNormalizationReport {
  const rawCounts: Record<TokenNormalizationCategory, number> = {
    color: foundations.colors.length,
    spacing: foundations.spacing.length,
    radius: foundations.radii.length,
    shadow: foundations.shadows.length,
    size: foundations.containerWidths.length,
    typography: foundations.typography.length
  };
  const rejectionCounts: Record<TokenNormalizationCategory, number> = { color: 0, spacing: 0, radius: 0, shadow: 0, size: 0, typography: 0 };
  const reasons: Record<string, number> = {};
  for (const rejection of state.rejected) {
    rejectionCounts[rejection.category] += 1;
    reasons[rejection.reason] = (reasons[rejection.reason] ?? 0) + 1;
  }
  const byCategory = {} as Record<TokenNormalizationCategory, TokenNormalizationCategorySummary>;
  for (const category of Object.keys(rawCounts) as TokenNormalizationCategory[]) {
    const raw = rawCounts[category];
    const normalized = state.normalizedCounts[category];
    const rejected = rejectionCounts[category];
    byCategory[category] = { raw, normalized, rejected, merged: Math.max(0, raw - rejected - normalized) };
  }
  const rawEvidenceValues = Object.values(rawCounts).reduce((sum, count) => sum + count, 0);
  const normalizedEvidenceGroups = Object.values(state.normalizedCounts).reduce((sum, count) => sum + count, 0);
  const rejectedEvidenceValues = state.rejected.length;
  const mergedEvidenceValues = Object.values(byCategory).reduce((sum, category) => sum + category.merged, 0);
  return {
    rawEvidenceValues,
    normalizedEvidenceGroups,
    rejectedEvidenceValues,
    mergedEvidenceValues,
    reasons: sortedRecord(reasons),
    adjustments: sortedRecord(state.adjustments),
    byCategory,
    rejected: [...state.rejected].sort((a, b) => a.category.localeCompare(b.category) || a.reason.localeCompare(b.reason) || b.count - a.count || a.value.localeCompare(b.value))
  };
}

export function buildTokenCandidates(foundations: DesignFoundations): {
  primitive: PrimitiveTokenCandidate[];
  semantic: SemanticTokenCandidate[];
  typography: TypographyCandidate[];
  normalization: TokenNormalizationReport;
} {
  const state = createNormalizationState();
  const colors = normalizedColorEvidence(foundations, state);
  const spacing = normalizedSpacingEvidence(foundations, state);
  const radii = normalizedRadiusEvidence(foundations, state);
  const shadows = normalizedShadowEvidence(foundations, state);
  const sizes = normalizedSizeEvidence(foundations, state);
  const typographyEvidence = normalizedTypographyEvidence(foundations, state);
  const typography = typographyCandidates(typographyEvidence);
  const primitive = [
    ...primitiveFromNormalizedEvidence(colors, "color", "color", "color"),
    ...primitiveFromNormalizedEvidence(spacing, "space", "dimension", "space"),
    ...primitiveFromNormalizedEvidence(radii, "radius", "dimension", "radius"),
    ...primitiveFromNormalizedEvidence(shadows, "shadow", "shadow", "shadow"),
    ...primitiveFromNormalizedEvidence(sizes, "size", "dimension", "size"),
    ...deriveTypographyPrimitives(typographyEvidence, foundations.pages)
  ];
  return { primitive, semantic: semanticCandidates(primitive), typography, normalization: normalizationReport(foundations, state) };
}

function dimensionCandidateNumber(candidate: PrimitiveTokenCandidate): number | undefined {
  return typeof candidate.value === "string" ? numberFromCss(candidate.value) : typeof candidate.value === "number" ? candidate.value : undefined;
}

function numericTokenKey(value: number): string {
  return stableNumber(value, 4).toString().replace("-", "neg-").replace(".", "-");
}

function proposedStatus(candidate: PrimitiveTokenCandidate, core: boolean, exception = false): FoundationProposalStatus {
  if (exception) return "exception";
  if (core && candidate.confidence >= 0.8) return "core";
  return "supporting";
}

function spacingBaseUnit(candidates: PrimitiveTokenCandidate[]): { value?: number; confidence: number } {
  const values = candidates
    .map(candidate => ({ candidate, value: dimensionCandidateNumber(candidate) }))
    .filter((item): item is { candidate: PrimitiveTokenCandidate; value: number } => item.value !== undefined && item.value > 0 && Math.abs(item.value - Math.round(item.value)) <= 0.01);
  const total = values.reduce((sum, item) => sum + item.candidate.evidence.count, 0);
  if (total === 0) return { confidence: 0 };
  for (const base of [8, 6, 5, 4, 3, 2]) {
    const matched = values.reduce((sum, item) => Math.abs(item.value / base - Math.round(item.value / base)) <= 0.01 ? sum + item.candidate.evidence.count : sum, 0);
    const share = matched / total;
    if (share >= 0.9) return { value: base, confidence: round(share) };
  }
  return { value: 1, confidence: 1 };
}

interface FoundationColorMetrics {
  candidate: PrimitiveTokenCandidate;
  rgb: [number, number, number, number];
  hue: number;
  saturation: number;
  lightness: number;
}

function rgbHsl([r8, g8, b8]: [number, number, number, number]): { hue: number; saturation: number; lightness: number } {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta <= 0.000001) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  return { hue, saturation, lightness };
}

function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return Math.min(delta, 360 - delta);
}

function colorMetrics(candidates: PrimitiveTokenCandidate[]): FoundationColorMetrics[] {
  const result: FoundationColorMetrics[] = [];
  for (const candidate of candidates) {
    const rgb = parseRgb(String(candidate.value));
    if (!rgb) continue;
    const hsl = rgbHsl(rgb);
    result.push({ candidate, rgb, ...hsl });
  }
  return result;
}

function colorBrandAnchor(items: FoundationColorMetrics[]): FoundationColorMetrics | undefined {
  const eligible = items.filter(item => item.rgb[3] >= 0.999 && item.saturation >= 0.52 && item.lightness >= 0.12 && item.lightness <= 0.82);
  return eligible.sort((a, b) => {
    const score = (item: FoundationColorMetrics) => {
      const properties = item.candidate.evidence.properties ?? {};
      const paint = (properties.backgroundColor ?? 0) + (properties.fill ?? 0) + (properties.stroke ?? 0);
      const buckets = [properties.color ?? 0, properties.backgroundColor ?? 0, (properties.fill ?? 0) + (properties.stroke ?? 0)].filter(value => value > 0).length;
      return Math.log10(item.candidate.evidence.count + 1) * item.saturation * (1 + Math.min(0.5, paint / Math.max(1, item.candidate.evidence.count))) * (buckets >= 2 ? 1.2 : 1);
    };
    return score(b) - score(a) || b.candidate.evidence.count - a.candidate.evidence.count;
  })[0];
}

function desiredShade(lightness: number): number {
  return Math.max(50, Math.min(950, Math.round(((1 - lightness) * 1000) / 50) * 50));
}

function unusedShade(desired: number, used: Set<number>): number {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  for (let offset = 50; offset <= 900; offset += 50) {
    for (const candidate of [desired + offset, desired - offset]) {
      if (candidate < 50 || candidate > 950 || used.has(candidate)) continue;
      used.add(candidate);
      return candidate;
    }
  }
  return desired;
}

function buildColorFoundation(candidates: PrimitiveTokenCandidate[]): { tokens: FoundationTokenProposal[]; sourcePaths: Map<string, string>; brandAnchor?: string } {
  const metrics = colorMetrics(candidates);
  const anchor = colorBrandAnchor(metrics);
  const brandMembers = new Set<string>();
  if (anchor) {
    for (const item of metrics) {
      if (item.rgb[3] >= 0.999 && item.saturation >= 0.52 && hueDistance(item.hue, anchor.hue) <= 40) brandMembers.add(item.candidate.id);
    }
  }
  const usedBrandShades = new Set<number>();
  const usedNeutralShades = new Set<number>();
  const sourcePaths = new Map<string, string>();
  let supportingIndex = 0;
  const tokens = [...metrics].sort((a, b) => b.candidate.evidence.count - a.candidate.evidence.count || String(a.candidate.value).localeCompare(String(b.candidate.value))).map(item => {
    const [r, g, b, alpha] = item.rgb;
    let path: string;
    let family: string;
    if (alpha < 0.999) {
      const alphaPercent = Math.round(alpha * 100);
      const base = r >= 250 && g >= 250 && b >= 250 ? "white" : r <= 5 && g <= 5 && b <= 5 ? "black" : `color-${String(++supportingIndex).padStart(2, "0")}`;
      path = `primitive.color.overlay.${base}-${alphaPercent}`;
      family = "overlay";
    } else if (r <= 2 && g <= 2 && b <= 2) {
      path = "primitive.color.black";
      family = "neutral endpoint";
    } else if (r >= 253 && g >= 253 && b >= 253) {
      path = "primitive.color.white";
      family = "neutral endpoint";
    } else if (brandMembers.has(item.candidate.id)) {
      const shade = unusedShade(desiredShade(item.lightness), usedBrandShades);
      path = `primitive.color.brand.${shade}`;
      family = "brand hue family";
    } else if (item.saturation <= 0.3 || item.lightness >= 0.9 || item.lightness <= 0.16 && item.saturation <= 0.5) {
      const shade = unusedShade(desiredShade(item.lightness), usedNeutralShades);
      path = `primitive.color.neutral.${shade}`;
      family = "neutral/ink family";
    } else {
      path = `primitive.color.support.${String(++supportingIndex).padStart(2, "0")}`;
      family = "supporting color";
    }
    sourcePaths.set(item.candidate.id, path);
    const core = alpha >= 0.999 && item.candidate.evidence.coverage >= 1;
    return {
      path,
      type: item.candidate.type,
      value: item.candidate.value,
      status: proposedStatus(item.candidate, core),
      confidence: round(item.candidate.confidence * (family === "supporting color" ? 0.82 : 0.9)),
      sources: [item.candidate.id],
      reason: `Observed color is assigned to the proposed ${family}; the name is a reviewable foundation name rather than production source truth.`
    } satisfies FoundationTokenProposal;
  });
  return { tokens, sourcePaths, brandAnchor: anchor ? sourcePaths.get(anchor.candidate.id) : undefined };
}

function buildDimensionScale(
  candidates: PrimitiveTokenCandidate[],
  prefix: string,
  options: { baseUnit?: number; maxCore?: number; fullRadius?: boolean } = {}
): FoundationTokenProposal[] {
  return [...candidates].sort((a, b) => (dimensionCandidateNumber(a) ?? 0) - (dimensionCandidateNumber(b) ?? 0)).map(candidate => {
    const value = dimensionCandidateNumber(candidate);
    const isFull = options.fullRadius && candidate.id === "primitive.radius.full";
    const key = isFull ? "full" : value === undefined ? slug(String(candidate.value)) : numericTokenKey(value);
    const baseAligned = !options.baseUnit || value !== undefined && Math.abs(value / options.baseUnit - Math.round(value / options.baseUnit)) <= 0.01;
    const oversized = options.maxCore !== undefined && value !== undefined && value > options.maxCore;
    const undersized = options.baseUnit !== undefined && value !== undefined && value < options.baseUnit;
    const core = candidate.evidence.coverage >= 1 && baseAligned && !oversized && !undersized;
    const exception = !isFull && (oversized || undersized);
    return {
      path: `${prefix}.${key}`,
      type: candidate.type,
      value: candidate.value,
      status: proposedStatus(candidate, core, exception),
      confidence: round(candidate.confidence * (core ? 0.94 : exception ? 0.72 : 0.84)),
      sources: [candidate.id],
      reason: isFull
        ? "Canonical full/pill radius retained as an explicit foundation token."
        : core
          ? "Observed value is well-supported across audited pages and fits the inferred core scale."
          : exception
            ? "Observed value is retained for fidelity but sits outside the inferred core scale."
            : "Observed value is useful but does not yet have enough cross-page/base-scale support to be a core token."
    };
  });
}

function shadowStrength(value: string | number): number {
  const numbers = String(value).match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?=px)/g)?.map(Number) ?? [];
  if (numbers.length < 2) return 0;
  const [x = 0, y = 0, blur = 0, spread = 0] = numbers.slice(-4);
  return Math.abs(x) + Math.abs(y) + Math.abs(blur) + Math.abs(spread);
}

function buildShadowFoundation(candidates: PrimitiveTokenCandidate[]): FoundationTokenProposal[] {
  const ordered = [...candidates].sort((a, b) => shadowStrength(a.value) - shadowStrength(b.value) || b.evidence.count - a.evidence.count);
  const labels = ordered.length === 1 ? ["default"] : ordered.length === 2 ? ["sm", "lg"] : ["sm", "md", "lg", "xl"];
  return ordered.map((candidate, index) => ({
    path: `primitive.shadow.${labels[index] ?? String(index + 1).padStart(2, "0")}`,
    type: candidate.type,
    value: candidate.value,
    status: proposedStatus(candidate, candidate.evidence.coverage >= 1),
    confidence: round(candidate.confidence * 0.88),
    sources: [candidate.id],
    reason: "Shadow is ordered by geometric strength; the scale label is proposed and keeps the exact normalized production value."
  }));
}

function buildFontFoundation(candidates: PrimitiveTokenCandidate[]): DesignFoundationProposal["primitive"]["font"] {
  const families = candidates.filter(candidate => candidate.group === "font.family");
  const familyTokens = families.map((candidate, index): FoundationTokenProposal => {
    const value = String(candidate.value).toLowerCase();
    const name = value.includes("monospace") ? "mono" : value.includes("serif") && !value.includes("sans-serif") ? "serif" : value.includes("sans-serif") ? "sans" : `family-${String(index + 1).padStart(2, "0")}`;
    return {
      path: `primitive.font.family.${name}`,
      type: candidate.type,
      value: candidate.value,
      status: proposedStatus(candidate, candidate.evidence.coverage >= 1),
      confidence: round(candidate.confidence * 0.96),
      sources: [candidate.id],
      reason: "Canonicalized production font stack is promoted to a stable family primitive."
    };
  });
  const sizes = buildDimensionScale(candidates.filter(candidate => candidate.group === "font.size"), "primitive.font.size");
  const weights = candidates.filter(candidate => candidate.group === "font.weight").sort((a, b) => Number(a.value) - Number(b.value)).map(candidate => ({
    path: `primitive.font.weight.${numericTokenKey(Number(candidate.value))}`,
    type: candidate.type,
    value: candidate.value,
    status: proposedStatus(candidate, candidate.evidence.coverage >= 1),
    confidence: round(candidate.confidence * 0.94),
    sources: [candidate.id],
    reason: "Observed font weight is retained as a numeric primitive; semantic meaning belongs to typography roles."
  } satisfies FoundationTokenProposal));
  const lineHeights = candidates.filter(candidate => candidate.group === "font.lineHeight").sort((a, b) => Number(a.value) - Number(b.value)).map(candidate => ({
    path: `primitive.font.lineHeight.${numericTokenKey(Number(candidate.value))}`,
    type: candidate.type,
    value: candidate.value,
    status: proposedStatus(candidate, candidate.evidence.coverage >= 1),
    confidence: round(candidate.confidence * 0.9),
    sources: [candidate.id],
    reason: "Unitless normalized line-height ratio is preserved exactly and named by value."
  } satisfies FoundationTokenProposal));
  const letterSpacing = candidates.filter(candidate => candidate.group === "font.letterSpacing").sort((a, b) => b.evidence.count - a.evidence.count).map((candidate, index) => {
    const raw = String(candidate.value);
    const name = index === 0 && candidate.value === "-0.01em" ? "tight" : raw.startsWith("-") ? `neg-${slug(raw.slice(1))}` : slug(raw);
    return ({
    path: `primitive.font.letterSpacing.${name}`,
    type: candidate.type,
    value: candidate.value,
    status: proposedStatus(candidate, candidate.evidence.coverage >= 1),
    confidence: round(candidate.confidence * 0.86),
    sources: [candidate.id],
    reason: "Observed tracking is kept exact; uncommon fixed-pixel tracking remains supporting until more pages confirm it."
  } satisfies FoundationTokenProposal);
  });
  return { family: familyTokens, size: sizes, weight: weights, lineHeight: lineHeights, letterSpacing };
}

function proposalPathMap(tokens: FoundationTokenProposal[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of tokens) for (const source of token.sources) map.set(source, token.path);
  return map;
}

function semanticColorFoundation(
  candidates: { primitive: PrimitiveTokenCandidate[]; semantic: SemanticTokenCandidate[] },
  colorTokens: FoundationTokenProposal[],
  brandAnchor: string | undefined
): FoundationSemanticProposal[] {
  const colorCandidates = candidates.primitive.filter(candidate => candidate.group === "color");
  const paths = proposalPathMap(colorTokens);
  const metrics = new Map(colorMetrics(colorCandidates).map(item => [item.candidate.id, item]));
  const result: FoundationSemanticProposal[] = [];
  const used = new Set<string>();
  const add = (path: string, primitiveId: string | undefined, confidence: number, reason: string) => {
    if (!primitiveId || used.has(path)) return;
    const primitive = paths.get(primitiveId);
    if (!primitive) return;
    used.add(path);
    result.push({ path, primitive, confidence: round(confidence), sources: [primitiveId], reason });
  };

  const semanticText = candidates.semantic.filter(item => item.role === "color.text").sort((a, b) => b.evidence.count - a.evidence.count || b.confidence - a.confidence);
  add("semantic.color.text.default", semanticText[0]?.primitive, (semanticText[0]?.confidence ?? 0) * 0.94, "Strongest conservative text-role candidate becomes the proposed default text color.");
  const neutralText = semanticText.filter(item => paths.get(item.primitive)?.includes(".neutral."));
  add("semantic.color.text.muted", neutralText[0]?.primitive, (neutralText[0]?.confidence ?? 0) * 0.88, "Strong cross-page neutral text candidate is proposed as muted text.");
  const subtle = [...neutralText].sort((a, b) => (metrics.get(b.primitive)?.lightness ?? 0) - (metrics.get(a.primitive)?.lightness ?? 0))[0];
  if (subtle?.primitive !== neutralText[0]?.primitive) add("semantic.color.text.subtle", subtle?.primitive, (subtle?.confidence ?? 0) * 0.82, "Lightest well-supported neutral text candidate is proposed as subtle text.");

  const white = colorCandidates.find(candidate => String(candidate.value).toLowerCase() === "#ffffff");
  if ((white?.evidence.properties?.color ?? 0) > 0) add("semantic.color.text.inverse", white?.id, (white?.confidence ?? 0) * 0.82, "Opaque white is observed as text and is proposed for inverse text on dark/accent surfaces.");
  if ((white?.evidence.properties?.backgroundColor ?? 0) > 0) add("semantic.color.surface.default", white?.id, (white?.confidence ?? 0) * 0.9, "Opaque white is observed as a real background and anchors the default surface role.");

  const surface = candidates.semantic.filter(item => item.role === "color.surface").sort((a, b) => b.evidence.count - a.evidence.count || b.confidence - a.confidence);
  const mutedSurface = surface.find(item => item.primitive !== white?.id && (metrics.get(item.primitive)?.rgb[3] ?? 1) >= 0.999);
  add("semantic.color.surface.muted", mutedSurface?.primitive, (mutedSurface?.confidence ?? 0) * 0.9, "Strongest opaque non-default surface candidate becomes the proposed muted surface.");
  const overlaySurface = surface.find(item => (metrics.get(item.primitive)?.rgb[3] ?? 1) < 0.999);
  add("semantic.color.surface.overlay", overlaySurface?.primitive, (overlaySurface?.confidence ?? 0) * 0.86, "Translucent background candidate is retained as an explicit overlay surface role.");

  if (brandAnchor) {
    const anchorId = [...paths.entries()].find(([, path]) => path === brandAnchor)?.[0];
    add("semantic.color.accent.default", anchorId, (colorCandidates.find(item => item.id === anchorId)?.confidence ?? 0) * 0.88, "Most credible saturated mixed-use hue anchors the proposed accent family.");
    const brandAlternates = colorCandidates.filter(item => item.id !== anchorId && paths.get(item.id)?.includes(".brand.")).sort((a, b) => (metrics.get(b.id)?.lightness ?? 0) - (metrics.get(a.id)?.lightness ?? 0));
    add("semantic.color.accent.secondary", brandAlternates[0]?.id, (brandAlternates[0]?.confidence ?? 0) * 0.78, "Lighter member of the inferred brand hue family is proposed as a secondary accent.");
    const darkest = [...brandAlternates, ...(anchorId ? colorCandidates.filter(item => item.id === anchorId) : [])].sort((a, b) => (metrics.get(a.id)?.lightness ?? 1) - (metrics.get(b.id)?.lightness ?? 1))[0];
    if (darkest?.id !== anchorId) add("semantic.color.accent.strong", darkest?.id, (darkest?.confidence ?? 0) * 0.76, "Darkest member of the inferred brand hue family is proposed as a strong accent/brand ink.");
  }

  const icon = [...colorCandidates].sort((a, b) => ((b.evidence.properties?.fill ?? 0) + (b.evidence.properties?.stroke ?? 0)) - ((a.evidence.properties?.fill ?? 0) + (a.evidence.properties?.stroke ?? 0)))[0];
  const iconPaint = (icon?.evidence.properties?.fill ?? 0) + (icon?.evidence.properties?.stroke ?? 0);
  if (icon && iconPaint >= 10) add("semantic.color.icon.default", icon.id, icon.confidence * 0.72, "Dominant SVG fill/stroke color is proposed as the default icon foreground; review brand/logo contamination before acceptance.");
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function buildLayoutFoundation(
  sizeCandidates: PrimitiveTokenCandidate[],
  sizeTokens: FoundationTokenProposal[],
  spacingCandidates: PrimitiveTokenCandidate[],
  spacingTokens: FoundationTokenProposal[]
): DesignFoundationProposal["layout"] {
  const sizePaths = proposalPathMap(sizeTokens);
  const spacingPaths = proposalPathMap(spacingTokens);
  const spacingByValue = new Map<string, { candidate: PrimitiveTokenCandidate; path: string }>();
  for (const candidate of spacingCandidates) {
    const path = spacingPaths.get(candidate.id);
    if (path) spacingByValue.set(String(candidate.value), { candidate, path });
  }
  const viewports = new Map<string, Array<{ candidate: PrimitiveTokenCandidate; width: number }>>();
  for (const candidate of sizeCandidates) {
    const width = dimensionCandidateNumber(candidate);
    if (width === undefined) continue;
    for (const [viewport, count] of Object.entries(candidate.evidence.viewports ?? {})) {
      if (count <= 0) continue;
      const values = viewports.get(viewport) ?? [];
      values.push({ candidate, width });
      viewports.set(viewport, values);
    }
  }
  for (const values of viewports.values()) values.sort((a, b) => b.width - a.width || b.candidate.evidence.count - a.candidate.evidence.count);

  const gutterValues: DesignFoundationProposal["layout"]["pageGutter"]["values"] = [];
  const wideEvidence: Array<{ viewport: string; viewportWidth: string; observedWidth: string; source: string }> = [];
  const wideCandidates: PrimitiveTokenCandidate[] = [];
  const viewportOrder = ["desktop", "tablet", "mobile", ...[...viewports.keys()].filter(key => !["desktop", "tablet", "mobile"].includes(key)).sort()];
  for (const viewport of viewportOrder) {
    const values = viewports.get(viewport);
    if (!values?.length) continue;
    const widest = values[0]!;
    wideCandidates.push(widest.candidate);
    const knownWidth = AUDIT_VIEWPORTS[viewport as keyof typeof AUDIT_VIEWPORTS]?.width;
    if (knownWidth) {
      wideEvidence.push({ viewport, viewportWidth: `${knownWidth}px`, observedWidth: `${widest.width}px`, source: widest.candidate.id });
      const gutter = (knownWidth - widest.width) / 2;
      if (gutter > 0 && Math.abs(gutter - Math.round(gutter)) <= 0.05) {
        const value = `${Math.round(gutter)}px`;
        const spacing = spacingByValue.get(value);
        gutterValues.push({ viewport, value, primitive: spacing?.path, source: widest.candidate.id, confirmedBySpacing: !!spacing });
      }
    }
  }
  const allGuttersConfirmed = gutterValues.length >= 2 && gutterValues.every(item => item.confirmedBySpacing);
  const gutterConfidence = gutterValues.length === 0 ? 0 : round((wideCandidates.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, wideCandidates.length)) * (allGuttersConfirmed ? 0.94 : 0.74));
  const pageGutter: DesignFoundationProposal["layout"]["pageGutter"] = {
    status: gutterValues.length >= 2 ? "proposed" : "unresolved",
    confidence: gutterConfidence,
    values: gutterValues,
    reason: gutterValues.length >= 2
      ? `The widest centered width at each known audit viewport yields a symmetric outer gutter${allGuttersConfirmed ? "; every derived gutter is independently present in the spacing evidence" : ""}.`
      : "Not enough viewport-specific centered-width evidence exists to infer a responsive page gutter."
  };

  const desktopWide = viewports.get("desktop")?.[0] ?? [...viewports.values()].flat()[0];
  const contentWidth = desktopWide && sizePaths.get(desktopWide.candidate.id) ? {
    primitive: sizePaths.get(desktopWide.candidate.id)!,
    max: `${desktopWide.width}px`,
    confidence: round(desktopWide.candidate.confidence * (wideEvidence.length >= 3 && allGuttersConfirmed ? 0.95 : 0.78)),
    reason: "The widest centered width forms one responsive outer-container family across viewports; its desktop value is proposed as the maximum content width while page gutter owns smaller viewport contraction.",
    responsiveEvidence: wideEvidence
  } : undefined;

  const maxRank = Math.max(0, ...[...viewports.values()].map(values => values.length));
  const innerContainerCandidates: DesignFoundationProposal["layout"]["innerContainerCandidates"] = [];
  for (let rank = 1; rank < maxRank; rank += 1) {
    const values: DesignFoundationProposal["layout"]["innerContainerCandidates"][number]["values"] = [];
    for (const viewport of viewportOrder) {
      const entry = viewports.get(viewport)?.[rank];
      const path = entry ? sizePaths.get(entry.candidate.id) : undefined;
      if (entry && path) values.push({ viewport, value: `${entry.width}px`, primitive: path, source: entry.candidate.id });
    }
    if (values.length > 0) innerContainerCandidates.push({
      tier: `inner-${rank}`,
      values,
      reason: "Additional recurring centered-width tier is preserved as layout evidence but is not promoted to size.content automatically."
    });
  }
  return {
    convention: "outer-gutter-inner-container",
    contentWidth,
    pageGutter,
    sectionSpacing: {
      status: "unresolved",
      confidence: 0,
      reason: "Section rhythm has not been evaluated against section-root evidence yet."
    },
    innerContainerCandidates
  };
}

function typographyDensity(lineHeight: number): "compact" | "default" | "relaxed" {
  if (lineHeight <= 1.25) return "compact";
  if (lineHeight <= 1.45) return "default";
  return "relaxed";
}

function typographyFoundationRole(style: Record<string, string>): string {
  const size = Math.round(numberFromCss(style.fontSize) ?? 16);
  const lineHeight = Number(style.lineHeight) || 1.2;
  const density = typographyDensity(lineHeight);
  const tracked = style.letterSpacing && style.letterSpacing !== "normal" ? "-tracked" : "";
  if (size <= 14) return `text.sm.${density}${tracked}`;
  if (size <= 16) return `text.md.${density}${tracked}`;
  if (size <= 18) return `text.lg.${density}${tracked}`;
  if (size <= 27) return `lead.${size}.${density}${tracked}`;
  if (size <= 47) return `heading.${size}.${density}${tracked}`;
  return `display.${size}.${density}${tracked}`;
}

function buildTypographyFoundation(
  typography: TypographyCandidate[],
  font: DesignFoundationProposal["primitive"]["font"],
  primitives: PrimitiveTokenCandidate[]
): FoundationTypographyRoleProposal[] {
  const allFontTokens = [...font.family, ...font.size, ...font.weight, ...font.lineHeight, ...font.letterSpacing];
  const paths = proposalPathMap(allFontTokens);
  const primitiveByGroupValue = new Map<string, PrimitiveTokenCandidate>();
  for (const primitive of primitives.filter(item => item.group.startsWith("font."))) primitiveByGroupValue.set(`${primitive.group}|${String(primitive.value)}`, primitive);
  const pathFor = (group: PrimitiveTokenCandidate["group"], value: string | number): string => {
    const primitive = primitiveByGroupValue.get(`${group}|${String(value)}`);
    return primitive ? paths.get(primitive.id) ?? `unresolved:${String(value)}` : `unresolved:${String(value)}`;
  };
  const groups = new Map<string, TypographyCandidate[]>();
  for (const candidate of typography) {
    const role = typographyFoundationRole(candidate.style);
    const values = groups.get(role) ?? [];
    values.push(candidate);
    groups.set(role, values);
  }
  const result: FoundationTypographyRoleProposal[] = [];
  for (const [role, values] of groups) {
    values.sort((a, b) => b.evidence.count - a.evidence.count || b.confidence - a.confidence || a.id.localeCompare(b.id));
    const primary = values[0]!;
    const lineHeight = Number(primary.style.lineHeight);
    const fontWeight = Number(primary.style.fontWeight);
    const letterSpacing = primary.style.letterSpacing && primary.style.letterSpacing !== "normal"
      ? pathFor("font.letterSpacing", primary.style.letterSpacing)
      : undefined;
    result.push({
      role,
      status: primary.evidence.coverage >= 1 && primary.confidence >= 0.62 ? "core" : "supporting",
      confidence: round(primary.confidence * 0.92),
      style: {
        fontFamily: pathFor("font.family", primary.style.fontFamily ?? "unknown"),
        fontSize: pathFor("font.size", primary.style.fontSize ?? "unknown"),
        fontWeight: pathFor("font.weight", Number.isFinite(fontWeight) ? fontWeight : primary.style.fontWeight ?? "unknown"),
        lineHeight: pathFor("font.lineHeight", Number.isFinite(lineHeight) ? lineHeight : primary.style.lineHeight ?? "unknown"),
        letterSpacing,
        textTransform: primary.style.textTransform && primary.style.textTransform !== "none" ? primary.style.textTransform : undefined
      },
      source: primary.id,
      alternates: values.slice(1).map(candidate => ({
        source: candidate.id,
        confidence: candidate.confidence,
        fontWeight: pathFor("font.weight", Number(candidate.style.fontWeight)),
        lineHeight: pathFor("font.lineHeight", Number(candidate.style.lineHeight)),
        letterSpacing: candidate.style.letterSpacing && candidate.style.letterSpacing !== "normal" ? pathFor("font.letterSpacing", candidate.style.letterSpacing) : undefined
      })),
      evidence: primary.evidence
    });
  }
  return result.sort((a, b) => {
    const aSize = Number(a.style.fontSize.match(/(?:size\.)(\d+)/)?.[1] ?? 0);
    const bSize = Number(b.style.fontSize.match(/(?:size\.)(\d+)/)?.[1] ?? 0);
    return aSize - bSize || a.role.localeCompare(b.role);
  });
}

export function buildFoundationProposal(candidates: {
  primitive: PrimitiveTokenCandidate[];
  semantic: SemanticTokenCandidate[];
  typography: TypographyCandidate[];
}, sectionRhythm?: SectionRhythmModel): DesignFoundationProposal {
  const colorCandidates = candidates.primitive.filter(candidate => candidate.group === "color");
  const spacingCandidates = candidates.primitive.filter(candidate => candidate.group === "space");
  const radiusCandidates = candidates.primitive.filter(candidate => candidate.group === "radius");
  const shadowCandidates = candidates.primitive.filter(candidate => candidate.group === "shadow");
  const sizeCandidates = candidates.primitive.filter(candidate => candidate.group === "size");
  const inferredBase = spacingBaseUnit(spacingCandidates);
  const color = buildColorFoundation(colorCandidates);
  const spacing = buildDimensionScale(spacingCandidates, "primitive.space", { baseUnit: inferredBase.value, maxCore: 64 });
  const radius = buildDimensionScale(radiusCandidates, "primitive.radius", { fullRadius: true });
  const shadow = buildShadowFoundation(shadowCandidates);
  const size = buildDimensionScale(sizeCandidates, "primitive.size");
  const font = buildFontFoundation(candidates.primitive);
  const layout = buildLayoutFoundation(sizeCandidates, size, spacingCandidates, spacing);
  const spacingPaths = proposalPathMap(spacing);
  const rhythmRecommended = sectionRhythm?.recommended;
  const rhythmPrimitive = rhythmRecommended ? spacingPaths.get(rhythmRecommended.primitiveCandidate) : undefined;
  layout.sectionSpacing = rhythmRecommended && rhythmPrimitive ? {
    status: "proposed",
    primitive: rhythmPrimitive,
    value: rhythmRecommended.value,
    confidence: rhythmRecommended.confidence,
    sourceCandidate: rhythmRecommended.primitiveCandidate,
    reason: `${rhythmRecommended.reason} Detailed evidence is retained in section-rhythm.json.`
  } : {
    status: "unresolved",
    confidence: sectionRhythm?.candidates[0]?.confidence ?? 0,
    reason: sectionRhythm?.status === "unresolved"
      ? "Section-root evidence does not yet identify one dominant reusable vertical rhythm. Review section-rhythm.json rather than choosing a large spacing value by frequency alone."
      : "No section-rhythm evidence was supplied to the foundation proposal."
  };
  const semantic = semanticColorFoundation(candidates, color.tokens, color.brandAnchor);
  if (layout.contentWidth) semantic.push({
    path: "semantic.size.content",
    primitive: layout.contentWidth.primitive,
    confidence: layout.contentWidth.confidence,
    sources: layout.contentWidth.responsiveEvidence.map(item => item.source),
    reason: "Responsive outer-container evidence supports this desktop maximum as the canonical content width."
  });
  semantic.sort((a, b) => a.path.localeCompare(b.path));
  const typography = buildTypographyFoundation(candidates.typography, font, candidates.primitive);
  const unresolved: DesignFoundationProposal["unresolved"] = [];
  unresolved.push({ area: "color.border", reason: "Active border evidence is intentionally unavailable because browser-default computed border colors are filtered; do not invent border semantics from inactive CSS." });
  if (layout.innerContainerCandidates.length > 0) unresolved.push({
    area: "layout.inner-containers",
    reason: "Multiple narrower centered-width tiers repeat across viewports. Keep them as layout candidates until sections/components prove which tiers are reusable.",
    candidates: layout.innerContainerCandidates.map(item => item.tier)
  });
  const spacingExceptions = spacing.filter(item => item.status === "exception");
  if (spacingExceptions.length > 0) unresolved.push({
    area: "space.exceptions",
    reason: "Large or sub-grid spacing values are preserved for fidelity but should not expand the core spacing scale without component/section evidence.",
    candidates: spacingExceptions.map(item => item.path)
  });
  if (layout.pageGutter.status === "unresolved") unresolved.push({ area: "layout.page-gutter", reason: layout.pageGutter.reason });
  if (!layout.contentWidth) unresolved.push({ area: "size.content", reason: "No reliable responsive outer-container family could be inferred." });
  if (typography.some(item => item.status === "supporting")) unresolved.push({
    area: "typography.page-specific",
    reason: "Some typography roles are supported by only part of the audited page set. Keep them as supporting roles until a third representative page confirms reuse.",
    candidates: typography.filter(item => item.status === "supporting").map(item => item.role)
  });
  if (layout.sectionSpacing.status === "unresolved") unresolved.push({
    area: "space.section",
    reason: layout.sectionSpacing.reason,
    candidates: sectionRhythm?.candidates.filter(item => item.strength !== "weak").map(item => item.value)
  });

  const primitiveTokens = [
    ...color.tokens,
    ...spacing,
    ...radius,
    ...shadow,
    ...size,
    ...font.family,
    ...font.size,
    ...font.weight,
    ...font.lineHeight,
    ...font.letterSpacing
  ];
  const summary = {
    primitiveTokens: primitiveTokens.length,
    corePrimitiveTokens: primitiveTokens.filter(item => item.status === "core").length,
    semanticRoles: semantic.length,
    typographyRoles: typography.length,
    unresolved: unresolved.length
  };
  return {
    model: {
      layers: ["evidence", "normalized-candidates", "foundation-proposal"],
      rule: "This model rationalizes candidate names, scales, responsive layout relationships, and typography roles without mutating raw evidence or SiteSpec Design System source. Every proposed token retains source candidate IDs for review."
    },
    primitive: {
      color: color.tokens,
      spacing: { baseUnit: inferredBase.value ? `${inferredBase.value}px` : undefined, baseUnitConfidence: inferredBase.confidence, tokens: spacing },
      radius,
      shadow,
      size,
      font
    },
    semantic,
    typography,
    layout,
    unresolved,
    summary
  };
}

function tokenize(value: string | undefined): Set<string> {
  if (!value) return new Set();
  const stop = new Set(["the", "and", "for", "with", "your", "our", "this", "that", "from", "into", "section", "div", "main"]);
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(token => token.length >= 3 && !stop.has(token)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function vectorSimilarity(a: Record<string, number> | undefined, b: Record<string, number> | undefined): number | undefined {
  if (!a || !b) return undefined;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (keys.length === 0) return undefined;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  if (aa === 0 && bb === 0) return 1;
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

function parseRgb(value: string | undefined): [number, number, number, number] | undefined {
  if (!value) return undefined;
  const rgb = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  const hex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) {
    const raw = hex[1]!;
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16), hex[2] ? parseInt(hex[2], 16) / 255 : 1];
  }
  return undefined;
}

function colorSimilarity(a: string | undefined, b: string | undefined): number | undefined {
  if (!a || !b) return undefined;
  if (a === b) return 1;
  const av = parseRgb(a);
  const bv = parseRgb(b);
  if (!av || !bv) return 0;
  const distance = Math.sqrt((av[0] - bv[0]) ** 2 + (av[1] - bv[1]) ** 2 + (av[2] - bv[2]) ** 2 + ((av[3] - bv[3]) * 255) ** 2);
  return clamp(1 - distance / 510);
}

function near(a: number, b: number, scale: number): number {
  return clamp(1 - Math.abs(a - b) / Math.max(scale, Math.abs(a), Math.abs(b), 1));
}

function sectionContentVector(section: AuditSection): Record<string, number> | undefined {
  if (!section.content) return undefined;
  return {
    headings: section.content.headings ?? 0,
    links: section.content.links ?? 0,
    buttons: section.content.buttons ?? 0,
    images: section.content.images ?? 0,
    videos: section.content.videos ?? 0,
    forms: section.content.forms ?? 0,
    lists: section.content.lists ?? 0
  };
}

function descendantVector(section: AuditSection): Record<string, number> | undefined {
  return section.structure?.descendantTags;
}

function categorical(a: string | undefined, b: string | undefined): number | undefined {
  if (!a || !b) return undefined;
  return a === b ? 1 : 0;
}

function typographySimilarity(a: AuditSection["headingStyle"], b: AuditSection["headingStyle"]): number | undefined {
  if (!a || !b) return undefined;
  const scores: number[] = [];
  const aSize = numberFromCss(a.fontSize);
  const bSize = numberFromCss(b.fontSize);
  if (aSize !== undefined && bSize !== undefined) scores.push(near(aSize, bSize, 24));
  const aLine = numberFromCss(a.lineHeight);
  const bLine = numberFromCss(b.lineHeight);
  if (aLine !== undefined && bLine !== undefined) scores.push(near(aLine, bLine, 32));
  for (const key of ["fontFamily", "fontWeight", "textTransform"] as const) {
    const score = categorical(a[key], b[key]);
    if (score !== undefined) scores.push(score);
  }
  return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : undefined;
}

export function compareSections(a: SectionObservation, b: SectionObservation): SectionSimilarity {
  const signals: Array<{ name: string; score: number | undefined; weight: number }> = [];
  signals.push({ name: "tag", score: categorical(a.section.tag, b.section.tag), weight: 0.08 });
  signals.push({ name: "content", score: vectorSimilarity(sectionContentVector(a.section), sectionContentVector(b.section)), weight: 0.22 });
  signals.push({ name: "structure", score: vectorSimilarity(descendantVector(a.section), descendantVector(b.section)) ?? (
    a.section.structure?.directChildTags && b.section.structure?.directChildTags
      ? jaccard(new Set(a.section.structure.directChildTags), new Set(b.section.structure.directChildTags))
      : undefined
  ), weight: 0.18 });

  const background = colorSimilarity(a.section.style?.backgroundColor ?? a.section.background, b.section.style?.backgroundColor ?? b.section.background);
  const radius = categorical(a.section.style?.borderRadius, b.section.style?.borderRadius);
  const display = categorical(a.section.style?.display, b.section.style?.display);
  const direction = categorical(a.section.style?.flexDirection, b.section.style?.flexDirection);
  const styleScores = [background, radius, display, direction].filter((value): value is number => value !== undefined);
  signals.push({ name: "style", score: styleScores.length ? styleScores.reduce((sum, value) => sum + value, 0) / styleScores.length : undefined, weight: 0.18 });

  const aWidth = a.section.box.width / Math.max(a.viewportWidth, 1);
  const bWidth = b.section.box.width / Math.max(b.viewportWidth, 1);
  const aspectA = a.section.box.height / Math.max(a.section.box.width, 1);
  const aspectB = b.section.box.height / Math.max(b.section.box.width, 1);
  signals.push({ name: "geometry", score: (near(aWidth, bWidth, 0.35) + near(aspectA, aspectB, 1.5)) / 2, weight: 0.18 });
  signals.push({ name: "headingTypography", score: typographySimilarity(a.section.headingStyle, b.section.headingStyle), weight: 0.10 });
  signals.push({ name: "label", score: jaccard(tokenize(`${a.section.label ?? ""} ${a.section.heading ?? ""}`), tokenize(`${b.section.label ?? ""} ${b.section.heading ?? ""}`)), weight: 0.06 });

  let totalWeight = 0;
  let weighted = 0;
  const out: Record<string, number> = {};
  for (const signal of signals) {
    if (signal.score === undefined) continue;
    out[signal.name] = round(signal.score);
    totalWeight += signal.weight;
    weighted += signal.score * signal.weight;
  }
  return { score: totalWeight > 0 ? round(weighted / totalWeight) : 0, signals: out };
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function averageSignals(comparisons: SectionSimilarity[]): Record<string, number> {
  const buckets = new Map<string, number[]>();
  for (const comparison of comparisons) {
    for (const [name, value] of Object.entries(comparison.signals)) {
      const values = buckets.get(name) ?? [];
      values.push(value);
      buckets.set(name, values);
    }
  }
  return Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, round(average(values))]));
}

function suggestedFamily(members: SectionObservation[]): { name?: string; confidence?: number } {
  const tags = members.map(member => member.section.tag?.toLowerCase());
  if (tags.every(tag => tag === "header")) return { name: "site-header", confidence: 0.99 };
  if (tags.every(tag => tag === "footer")) return { name: "site-footer", confidence: 0.99 };
  const texts = members.map(member => `${member.section.label ?? ""} ${member.section.heading ?? ""}`.toLowerCase());
  const rules: Array<[RegExp, string, number]> = [
    [/\b(testimonial|testimonials|review|reviews)\b/, "testimonials", 0.82],
    [/\b(case study|case studies|success stor|customer stor)\b/, "case-studies", 0.78],
    [/\b(faq|frequently asked|questions)\b/, "faq", 0.86],
    [/\b(metric|metrics|results|impact|numbers)\b/, "metrics", 0.72],
    [/\b(feature|features|benefit|benefits)\b/, "features", 0.66],
    [/\b(logos|trusted by|customers|clients)\b/, "logo-cloud", 0.62],
    [/\b(get started|book a demo|request a demo|start now|try now)\b/, "call-to-action", 0.62]
  ];
  const supported = rules
    .map(([pattern, name, confidence]) => {
      const support = texts.filter(text => pattern.test(text)).length / Math.max(texts.length, 1);
      return { name, confidence, support };
    })
    .filter(item => item.support >= 0.5)
    .sort((a, b) => b.support - a.support || b.confidence - a.confidence || a.name.localeCompare(b.name));
  if (supported[0]) {
    return {
      name: supported[0].name,
      confidence: round(supported[0].confidence * (0.75 + 0.25 * supported[0].support))
    };
  }

  const firstContent = members.every(member => {
    const ordinal = Number(member.section.auditId.match(/(\d+)$/)?.[1] ?? 99);
    return ordinal <= 2 || (ordinal <= 3 && member.section.headingStyle && (numberFromCss(member.section.headingStyle.fontSize) ?? 0) >= 36);
  });
  const hasH1Like = members.every(member => (member.section.content?.headings ?? (member.section.heading ? 1 : 0)) >= 1);
  if (firstContent && hasH1Like) return { name: "hero", confidence: 0.64 };
  return {};
}

export type ManualSectionIntent =
  | "site-header"
  | "site-footer"
  | "breadcrumbs"
  | "hero"
  | "hero-media"
  | "logo-cloud"
  | "product-media"
  | "feature-showcase"
  | "features"
  | "audience"
  | "lead-form"
  | "testimonials"
  | "case-studies"
  | "faq"
  | "metrics";

export interface ManualSectionIntentEvidence {
  name: ManualSectionIntent;
  confidence: number;
  source: "role" | "label" | "heading" | "structure";
}

function normalizedIntentText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Conservative semantic intent inferred only from reviewer-controlled labels,
 * strong headings, landmarks, or distinctive structure. It is intentionally
 * not a general text classifier: unknown is safer than a false family match.
 */
export function inferManualSectionIntent(section: AuditSection): ManualSectionIntentEvidence | undefined {
  if (section.source !== "manual") return undefined;
  if (section.role === "header" || section.tag === "header") return { name: "site-header", confidence: 1, source: "role" };
  if (section.role === "footer" || section.tag === "footer") return { name: "site-footer", confidence: 1, source: "role" };

  const label = normalizedIntentText(section.label);
  const heading = normalizedIntentText(section.heading);
  const labelMatches = (pattern: RegExp): boolean => pattern.test(label);
  const headingMatches = (pattern: RegExp): boolean => pattern.test(heading);

  if (labelMatches(/\b(?:bread|breab)crumbs?\b/)) return { name: "breadcrumbs", confidence: 0.99, source: "label" };

  if (labelMatches(/\b(hero (?:media|visual|image)|static head image|head image)\b/)) {
    return { name: "hero-media", confidence: 0.98, source: "label" };
  }
  if (label === "hero" || labelMatches(/^hero (?!media|visual|image)/)) return { name: "hero", confidence: 0.99, source: "label" };

  if (labelMatches(/\b(testimonials?|reviews?|rating)\b/) || headingMatches(/\b(loved by|testimonials?|customer reviews?|customers say)\b/)) {
    return { name: "testimonials", confidence: labelMatches(/\b(testimonials?|reviews?|rating)\b/) ? 0.97 : 0.88, source: labelMatches(/\b(testimonials?|reviews?|rating)\b/) ? "label" : "heading" };
  }

  if (labelMatches(/\b(faq|frequently asked)\b/) || heading === "faq" || headingMatches(/\bfrequently asked\b/)) {
    return { name: "faq", confidence: 0.99, source: labelMatches(/\b(faq|frequently asked)\b/) ? "label" : "heading" };
  }
  const descendantTags = section.structure?.descendantTags ?? {};
  if ((descendantTags.details ?? 0) >= 2 && (descendantTags.summary ?? 0) >= 2) {
    return { name: "faq", confidence: 0.9, source: "structure" };
  }

  if (labelMatches(/\b(success stor(?:y|ies)|case stud(?:y|ies)|customer stor(?:y|ies))\b/) || headingMatches(/\b(success stor(?:y|ies)|case stud(?:y|ies))\b/)) {
    return { name: "case-studies", confidence: labelMatches(/\b(success stor(?:y|ies)|case stud(?:y|ies)|customer stor(?:y|ies))\b/) ? 0.97 : 0.88, source: labelMatches(/\b(success stor(?:y|ies)|case stud(?:y|ies)|customer stor(?:y|ies))\b/) ? "label" : "heading" };
  }

  if (labelMatches(/\b(customer|client) logos?\b|\blogo cloud\b|^customers$|^clients$/) || headingMatches(/\b(trusted by|our customers|our clients)\b/)) {
    return { name: "logo-cloud", confidence: labelMatches(/\b(customer|client) logos?\b|\blogo cloud\b|^customers$|^clients$/) ? 0.97 : 0.84, source: labelMatches(/\b(customer|client) logos?\b|\blogo cloud\b|^customers$|^clients$/) ? "label" : "heading" };
  }

  if (labelMatches(/\b(request|book) (?:a )?demo\b|\bform\b|\bget started\b/)) {
    return { name: "lead-form", confidence: 0.96, source: "label" };
  }

  if (labelMatches(/\b(figures?|metrics?|statistics|stats|numbers)\b/) || headingMatches(/\bproduct impact\b/)) {
    return { name: "metrics", confidence: labelMatches(/\b(figures?|metrics?|statistics|stats|numbers)\b/) ? 0.96 : 0.82, source: labelMatches(/\b(figures?|metrics?|statistics|stats|numbers)\b/) ? "label" : "heading" };
  }

  if (labelMatches(/\bwho should use\b/) || headingMatches(/\bwho should use\b|\bwho is .+ for\b/)) {
    return { name: "audience", confidence: 0.97, source: labelMatches(/\bwho should use\b/) ? "label" : "heading" };
  }

  if (labelMatches(/\bengagement formats?\b|\bformat showcase\b/)) {
    return { name: "feature-showcase", confidence: 0.96, source: "label" };
  }
  if (labelMatches(/\bfeature blocks?\b|\bnumerable feature\b|^features?$|\bbenefits?\b|\bcapabilities\b/)) {
    return { name: "features", confidence: 0.96, source: "label" };
  }

  if (labelMatches(/\b(screencast|product showcase|product demo|demo video)\b/) || label === "carousel") {
    return { name: "product-media", confidence: 0.95, source: "label" };
  }
  if ((section.content?.videos ?? 0) >= 1 && (section.content?.forms ?? 0) === 0) {
    return { name: "product-media", confidence: 0.8, source: "structure" };
  }

  return undefined;
}

function pairKey(a: SectionObservation, b: SectionObservation): string {
  return `${a.page}:${a.section.auditId}|${b.page}:${b.section.auditId}`;
}

function canCompareForClustering(a: SectionObservation, b: SectionObservation): boolean {
  if (a.page !== b.page) return true;
  return a.section.source === "manual" && b.section.source === "manual";
}

const SAME_PAGE_MANUAL_SIMILARITY = 0.95;
const MANUAL_NAME_SUPPORT = 0.12;
const MANUAL_UNKNOWN_CROSS_PAGE_SIMILARITY = 0.86;

function manualCrossPageSemanticGate(a: SectionObservation, b: SectionObservation, similarity: SectionSimilarity, threshold: number): boolean {
  if (a.page === b.page || a.section.source !== "manual" || b.section.source !== "manual") return true;
  const left = inferManualSectionIntent(a.section);
  const right = inferManualSectionIntent(b.section);
  if (left && right) return left.name === right.name;

  const required = Math.max(MANUAL_UNKNOWN_CROSS_PAGE_SIMILARITY, threshold + 0.12);
  if (similarity.score < required) return false;
  return (similarity.signals.label ?? 0) >= MANUAL_NAME_SUPPORT;
}

function samePageManualThreshold(threshold: number): number {
  return Math.max(SAME_PAGE_MANUAL_SIMILARITY, threshold);
}

function manualNameSupport(a: SectionObservation, b: SectionObservation): number {
  return compareSections(a, b).signals.label ?? 0;
}

function hasRepeatedPage(group: SectionObservation[]): boolean {
  return new Set(group.map(item => item.page)).size < group.length;
}

function canShareCluster(left: SectionObservation[], right: SectionObservation[], threshold: number): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a.page !== b.page) continue;
      if (!canCompareForClustering(a, b)) return false;
      const similarity = compareSections(a, b);
      if (similarity.score < samePageManualThreshold(threshold)) return false;
      if ((similarity.signals.label ?? 0) < MANUAL_NAME_SUPPORT) return false;
    }
  }

  const crossPageManual = left.flatMap(a => right
    .filter(b => a.page !== b.page && a.section.source === "manual" && b.section.source === "manual")
    .map(b => [a, b, compareSections(a, b)] as const));
  if (crossPageManual.some(([a, b, similarity]) => !manualCrossPageSemanticGate(a, b, similarity, threshold))) return false;

  if (hasRepeatedPage(left) || hasRepeatedPage(right)) {
    const crossPage = left.flatMap(a => right.filter(b => a.page !== b.page).map(b => [a, b] as const));
    if (crossPage.length > 0 && !crossPage.some(([a, b]) => manualNameSupport(a, b) >= MANUAL_NAME_SUPPORT)) return false;
  }
  return true;
}

export function clusterSections(observations: SectionObservation[], threshold = 0.68): {
  clusters: SectionCluster[];
  unclustered: SectionObservation[];
} {
  const byPage = new Map(observations.map(item => [`${item.page}:${item.section.auditId}`, item]));
  const pairs: Array<{ a: SectionObservation; b: SectionObservation; similarity: SectionSimilarity }> = [];
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      const a = observations[i]!;
      const b = observations[j]!;
      if (!canCompareForClustering(a, b)) continue;
      const similarity = compareSections(a, b);
      const shell = [a.section.tag, b.section.tag].every(tag => tag === "header") || [a.section.tag, b.section.tag].every(tag => tag === "footer");
      const required = a.page === b.page
        ? samePageManualThreshold(threshold)
        : shell ? 0.52 : threshold;
      const samePageManual = a.page === b.page;
      if (
        similarity.score >= required
        && (!samePageManual || (similarity.signals.label ?? 0) >= MANUAL_NAME_SUPPORT)
        && manualCrossPageSemanticGate(a, b, similarity, threshold)
      ) {
        pairs.push({ a, b, similarity });
      }
    }
  }
  pairs.sort((x, y) => y.similarity.score - x.similarity.score || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));

  const groups: SectionObservation[][] = observations.map(item => [item]);
  const groupIndex = new Map<string, number>(observations.map((item, index) => [`${item.page}:${item.section.auditId}`, index]));

  const comparisonsFor = (left: SectionObservation[], right: SectionObservation[]): SectionSimilarity[] => {
    const result: SectionSimilarity[] = [];
    for (const a of left) for (const b of right) if (canCompareForClustering(a, b)) result.push(compareSections(a, b));
    return result;
  };

  for (const pair of pairs) {
    const keyA = `${pair.a.page}:${pair.a.section.auditId}`;
    const keyB = `${pair.b.page}:${pair.b.section.auditId}`;
    const ia = groupIndex.get(keyA)!;
    const ib = groupIndex.get(keyB)!;
    if (ia === ib) continue;
    const left = groups[ia]!;
    const right = groups[ib]!;
    if (!canShareCluster(left, right, threshold)) continue;
    const comparisons = comparisonsFor(left, right);
    if (!comparisons.length) continue;
    const shell = [...left, ...right].every(item => item.section.tag === "header") || [...left, ...right].every(item => item.section.tag === "footer");
    const required = shell ? 0.52 : threshold;
    if (average(comparisons.map(item => item.score)) < required) continue;
    const merged = [...left, ...right].sort((a, b) => a.page.localeCompare(b.page) || a.section.auditId.localeCompare(b.section.auditId));
    groups[ia] = merged;
    groups[ib] = [];
    for (const member of merged) groupIndex.set(`${member.page}:${member.section.auditId}`, ia);
  }

  const clusteredGroups = groups.filter(group => group.length >= 2 && (
    new Set(group.map(item => item.page)).size >= 2
    || group.every(item => item.section.source === "manual")
  ));
  clusteredGroups.sort((a, b) => {
    const aKey = a.map(item => `${item.page}:${item.section.auditId}`).join("|");
    const bKey = b.map(item => `${item.page}:${item.section.auditId}`).join("|");
    return aKey.localeCompare(bKey);
  });

  const clusteredKeys = new Set<string>();
  const clusters = clusteredGroups.map((members, index): SectionCluster => {
    members.forEach(member => clusteredKeys.add(`${member.page}:${member.section.auditId}`));
    const comparisons: SectionSimilarity[] = [];
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) comparisons.push(compareSections(members[i]!, members[j]!));
    const suggestion = suggestedFamily(members);
    const enhanced = members.every(member => !!member.section.content && !!member.section.structure && !!member.section.style);
    const sources = new Set(members.map(member => member.section.source ?? "automatic"));
    const segmentation = sources.size > 1 ? "mixed" : sources.has("manual") ? "manual" : "automatic";
    return {
      id: `cluster-${String(index + 1).padStart(3, "0")}`,
      suggestedFamily: suggestion.name,
      suggestedFamilyConfidence: suggestion.confidence,
      score: round(average(comparisons.map(item => item.score))),
      pages: [...new Set(members.map(item => item.page))].sort(),
      evidenceQuality: enhanced ? "enhanced" : "legacy",
      segmentation,
      members: members.map(member => ({
        page: member.page,
        sourceUrl: member.sourceUrl,
        auditId: member.section.auditId,
        label: member.section.label,
        selector: member.section.selector,
        selectors: member.section.selectors,
        screenshot: member.section.screenshot,
        screenshotClip: member.section.screenshotClip,
        source: member.section.source,
        semanticIntent: inferManualSectionIntent(member.section)
      })),
      signals: averageSignals(comparisons)
    };
  });

  const unclustered = [...byPage.values()].filter(item => !clusteredKeys.has(`${item.page}:${item.section.auditId}`));
  return { clusters, unclustered };
}

function componentRoleForFamily(family: string): ComponentFamilyRole | undefined {
  if (family === "site-header" || family === "site-footer") return undefined;
  if (family === "hero") return "intro";
  if (family === "breadcrumbs") return "utility";
  if (family === "logo-cloud" || family === "testimonials" || family === "case-studies" || family === "metrics") return "proof";
  if (family === "lead-form" || family === "call-to-action") return "conversion";
  return "content";
}

function componentVariantHint(label: string | undefined): { id: string; source: ComponentFamilyVariantProposal["source"] } {
  const value = normalizedIntentText(label).replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
  const rules: Array<[RegExp, string]> = [
    [/\bcarousel\b/, "carousel"],
    [/\bscreencast\b/, "screencast"],
    [/\bcentered\b/, "centered"],
    [/\bsplit\b/, "split"],
    [/\bstacked\b/, "stacked"],
    [/\bgrid\b/, "grid"]
  ];
  for (const [pattern, id] of rules) if (pattern.test(value)) return { id, source: "reviewer-label" };
  return { id: "default", source: "default" };
}

function contentRange(values: number[]): { min: number; max: number; average: number } {
  if (!values.length) return { min: 0, max: 0, average: 0 };
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    average: round(average(values))
  };
}

function familyPropHints(family: string, members: SectionObservation[]): ComponentFamilyPropHint[] {
  const hints: Array<Omit<ComponentFamilyPropHint, "presenceRatio" | "variantCoverage" | "requiredRecommendation"> & { predicate: (item: SectionObservation) => boolean }> = [];
  const ratio = (predicate: (item: SectionObservation) => boolean): number => round(members.filter(predicate).length / Math.max(1, members.length));
  const heading = (item: SectionObservation): boolean => (item.section.content?.headings ?? (item.section.heading ? 1 : 0)) > 0;
  const action = (item: SectionObservation): boolean => (item.section.content?.buttons ?? 0) > 0 || (item.section.content?.links ?? 0) > 0;
  const image = (item: SectionObservation): boolean => (item.section.content?.images ?? 0) > 0 || (item.section.content?.videos ?? 0) > 0;
  const form = (item: SectionObservation): boolean => (item.section.content?.forms ?? 0) > 0;
  const list = (item: SectionObservation): boolean => (item.section.content?.lists ?? 0) > 0 || (item.section.structure?.directChildren ?? 0) >= 3;
  const navigation = (item: SectionObservation): boolean => (item.section.content?.links ?? 0) > 0;
  const text = (item: SectionObservation): boolean => (item.section.content?.textLength ?? 0) >= 80;
  const headingRatio = ratio(heading);
  const actionRatio = ratio(action);
  const imageRatio = ratio(image);
  const formRatio = ratio(form);
  const listRatio = ratio(list);

  const intrinsicRequired = new Set<string>(
    family === "hero" ? ["title"]
      : family === "lead-form" ? ["form"]
        : family === "logo-cloud" || family === "testimonials" ? ["items"]
          : family === "features" ? ["title"]
            : family === "site-header" || family === "site-footer" || family === "breadcrumbs" ? ["navigation"]
              : []
  );

  if (family === "site-header" || family === "site-footer" || family === "breadcrumbs") {
    hints.push({ name: "navigation", kind: "navigation", confidence: family === "breadcrumbs" ? 0.98 : 0.92, reason: `${family} is a navigation-oriented family.`, predicate: navigation });
  }
  if (headingRatio >= 0.5) hints.push({ name: "title", kind: "string", confidence: round(0.7 + 0.25 * headingRatio), reason: `Headings are present in ${Math.round(headingRatio * 100)}% of observed instances.`, predicate: heading });
  if (family !== "breadcrumbs" && family !== "site-header" && family !== "site-footer") {
    const textRatio = ratio(text);
    if (textRatio >= 0.5) hints.push({ name: "text", kind: "string", confidence: round(0.6 + 0.25 * textRatio), reason: `Substantial text is present in ${Math.round(textRatio * 100)}% of observed instances.`, predicate: text });
  }
  if (actionRatio >= 0.5 || family === "hero" || family === "lead-form") hints.push({ name: "primaryAction", kind: "action", confidence: round(Math.max(0.68, 0.58 + 0.3 * actionRatio)), reason: "Links/buttons repeat strongly enough to model an action slot.", predicate: action });
  if (imageRatio >= 0.5 || family === "hero-media" || family === "product-media") hints.push({ name: "media", kind: "media", confidence: round(Math.max(0.72, 0.58 + 0.3 * imageRatio)), reason: "Media is a recurring part of the family structure.", predicate: image });
  if (formRatio >= 0.5 || family === "lead-form") hints.push({ name: "form", kind: "form", confidence: round(Math.max(0.9, 0.62 + 0.3 * formRatio)), reason: "Form structure is intrinsic to this family.", predicate: form });
  if (
    listRatio >= 0.5
    || ["logo-cloud", "testimonials", "case-studies", "metrics", "audience", "faq", "feature-showcase"].includes(family)
  ) {
    hints.push({ name: "items", kind: "items", confidence: round(Math.max(0.7, 0.58 + 0.28 * listRatio)), reason: "Repeated child/list structure suggests a typed item collection rather than independent scalar props.", predicate: list });
  }
  const variantGroups = new Map<string, SectionObservation[]>();
  for (const member of members) {
    const variant = componentVariantHint(member.section.label).id;
    const bucket = variantGroups.get(variant) ?? [];
    bucket.push(member);
    variantGroups.set(variant, bucket);
  }
  return hints.map(({ predicate, ...hint }) => {
    const presenceRatio = ratio(predicate);
    const variantCoverage = round([...variantGroups.values()].filter(bucket => bucket.length > 0 && bucket.every(predicate)).length / Math.max(1, variantGroups.size));
    const requiredRecommendation: ComponentFamilyPropHint["requiredRecommendation"] = intrinsicRequired.has(hint.name)
      && members.length >= 2
      && presenceRatio >= 0.75
      && variantCoverage >= 0.75
        ? "required"
        : "optional";
    return { ...hint, presenceRatio, variantCoverage, requiredRecommendation };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function familyAssignment(item: SectionObservation, cluster?: SectionCluster): { family?: string; intent?: ManualSectionIntentEvidence } {
  const intent = inferManualSectionIntent(item.section);
  if (intent && intent.confidence >= 0.8) return { family: intent.name, intent };
  if (cluster?.suggestedFamily && (cluster.suggestedFamilyConfidence ?? 0) >= 0.6) return { family: cluster.suggestedFamily, intent };
  return { intent };
}

export function buildComponentFamilyModel(
  observations: SectionObservation[],
  clusters: SectionCluster[],
  totalPages = Math.max(1, new Set(observations.map(item => item.page)).size),
  leafControlsObserved = false
): ComponentFamilyModel {
  const clusterByMember = new Map<string, SectionCluster>();
  for (const cluster of clusters) for (const member of cluster.members) clusterByMember.set(`${member.page}:${member.auditId}`, cluster);

  const groups = new Map<string, Array<{ item: SectionObservation; cluster?: SectionCluster; intent?: ManualSectionIntentEvidence }>>();
  const unresolvedSections: string[] = [];
  for (const item of observations) {
    const cluster = clusterByMember.get(`${item.page}:${item.section.auditId}`);
    const assignment = familyAssignment(item, cluster);
    if (!assignment.family) {
      if (item.section.source === "manual") unresolvedSections.push(`${item.page}:${item.section.auditId}`);
      continue;
    }
    const list = groups.get(assignment.family) ?? [];
    list.push({ item, cluster, intent: assignment.intent });
    groups.set(assignment.family, list);
  }

  const families: ComponentFamilyProposal[] = [...groups.entries()].map(([family, entries]) => {
    const items = entries.map(entry => entry.item);
    const pages = [...new Set(items.map(item => item.page))].sort();
    const pageCounts = new Map<string, number>();
    for (const item of items) pageCounts.set(item.page, (pageCounts.get(item.page) ?? 0) + 1);
    const repeatedWithinPage = [...pageCounts.values()].some(count => count >= 2);
    const crossPage = pages.length >= 2;
    const clusterIds = [...new Set(entries.map(entry => entry.cluster?.id).filter((value): value is string => !!value))].sort();
    const clusterScores = clusterIds.map(id => clusters.find(cluster => cluster.id === id)?.score ?? 0).filter(value => value > 0);
    const clusterSimilarity = clusterScores.length ? round(average(clusterScores)) : items.length >= 2 ? 0.55 : 0.25;
    const intentEntries = entries.map(entry => entry.intent).filter((value): value is ManualSectionIntentEvidence => !!value && value.name === family);
    const semanticIntentSupport = round(intentEntries.length / Math.max(1, entries.length));
    const semanticIntentConfidence = intentEntries.length ? round(average(intentEntries.map(intent => intent.confidence))) : 0;
    const recurrence = clamp(items.length / 3);
    const pageCoverage = round(pages.length / Math.max(1, totalPages));
    let confidence = round(clamp(
      0.45 * semanticIntentConfidence
      + 0.2 * clusterSimilarity
      + 0.15 * pageCoverage
      + 0.2 * recurrence
    ));
    const layer: ComponentFamilyLayer = family === "site-header" || family === "site-footer" ? "shell" : "section";
    if (layer === "shell" && crossPage) confidence = Math.max(confidence, 0.97);
    const core = (layer === "shell" && crossPage)
      || (crossPage && items.length >= 2 && semanticIntentSupport >= 0.5 && confidence >= 0.78)
      || (items.length >= 3 && repeatedWithinPage && clusterSimilarity >= 0.82 && semanticIntentConfidence >= 0.9 && confidence >= 0.78);
    const supporting = !core && items.length >= 2 && confidence >= 0.68;
    const status: ComponentFamilyStatus = core ? "core" : supporting ? "supporting" : "local";
    const role = componentRoleForFamily(family);

    const variantBuckets = new Map<string, { source: ComponentFamilyVariantProposal["source"]; members: SectionObservation[] }>();
    for (const item of items) {
      const hint = componentVariantHint(item.section.label);
      const bucket = variantBuckets.get(hint.id) ?? { source: hint.source, members: [] };
      bucket.members.push(item);
      if (hint.source === "reviewer-label") bucket.source = "reviewer-label";
      variantBuckets.set(hint.id, bucket);
    }
    const variants = [...variantBuckets.entries()].sort(([a], [b]) => a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)).map(([id, bucket]) => ({
      id,
      confidence: id === "default" ? confidence : round(Math.min(0.98, Math.max(0.74, confidence + 0.04))),
      source: bucket.source,
      members: bucket.members.map(item => ({ page: item.page, auditId: item.section.auditId, label: item.section.label })),
      reason: id === "default"
        ? "No explicit reviewer-controlled variant vocabulary was found for these instances."
        : `Reviewer labels explicitly repeat the ${id} presentation vocabulary.`
    }));

    const members: ComponentFamilyMember[] = entries.map(entry => {
      const hint = componentVariantHint(entry.item.section.label);
      return {
        page: entry.item.page,
        sourceUrl: entry.item.sourceUrl,
        auditId: entry.item.section.auditId,
        label: entry.item.section.label,
        source: entry.item.section.source,
        cluster: entry.cluster?.id,
        semanticIntent: entry.intent,
        variant: hint.id,
        selector: entry.item.section.selector,
        selectors: entry.item.section.selectors,
        screenshot: entry.item.section.screenshot
      };
    }).sort((a, b) => a.page.localeCompare(b.page) || a.auditId.localeCompare(b.auditId));

    const values = (key: keyof NonNullable<AuditSection["content"]>): number[] => items.map(item => Number(item.section.content?.[key] ?? 0));
    const reason = core
      ? crossPage
        ? "Reviewer-confirmed semantic intent repeats across representative pages with compatible structural/style clustering."
        : "The same reviewer-confirmed family repeats several times on one page with strong structural/style similarity."
      : supporting
        ? "The family repeats in reviewed DOM evidence, but cross-page reuse or structural support is not yet strong enough for a core family."
        : "The semantic intent is credible, but only one reviewed instance is available; keep it local/pending until more reuse evidence appears.";

    return {
      id: family,
      suggestedComponentId: family,
      layer,
      role,
      status,
      confidence,
      reason,
      evidence: {
        instances: items.length,
        pages,
        pageCoverage,
        crossPage,
        repeatedWithinPage,
        manualInstances: items.filter(item => item.section.source === "manual").length,
        semanticIntentSupport,
        semanticIntentConfidence,
        clusters: clusterIds,
        clusterSimilarity,
        observedContent: {
          headings: contentRange(values("headings")),
          links: contentRange(values("links")),
          buttons: contentRange(values("buttons")),
          images: contentRange(values("images")),
          forms: contentRange(values("forms")),
          lists: contentRange(values("lists"))
        }
      },
      variants,
      contractHints: {
        role,
        ...(family === "hero" || family === "site-header" || family === "site-footer" || family === "breadcrumbs" ? { maxPerPage: 1 } : {}),
        ...(family === "hero" ? { placement: "first" as const, pageHeading: true } : {}),
        props: familyPropHints(family, items)
      },
      members
    };
  }).sort((a, b) => {
    const statusOrder: Record<ComponentFamilyStatus, number> = { core: 0, supporting: 1, local: 2 };
    return statusOrder[a.status] - statusOrder[b.status] || b.confidence - a.confidence || a.id.localeCompare(b.id);
  });

  const localFamilies = families.filter(item => item.status === "local").map(item => item.id);
  const unresolved: ComponentFamilyModel["unresolved"] = [
    ...(!leafControlsObserved ? [{
      area: "leaf-controls",
      reason: "Current migration audit is section-oriented and does not retain enough direct element-level evidence to infer Button, Link, Input, Select, Badge, or Card families safely. Add a leaf UI inventory before materializing those primitives."
    }] : []),
    ...(localFamilies.length ? [{
      area: "local-section-families",
      reason: "High-confidence semantic labels exist, but these families have only one reviewed instance. Keep them pending/local until more representative pages confirm reuse.",
      families: localFamilies
    }] : []),
    ...(unresolvedSections.length ? [{
      area: "unclassified-sections",
      reason: "Some reviewed sections have no conservative semantic family assignment and should remain page composition until explicitly named or repeated.",
      families: unresolvedSections
    }] : [])
  ];
  const summary = {
    total: families.length,
    core: families.filter(item => item.status === "core").length,
    supporting: families.filter(item => item.status === "supporting").length,
    local: families.filter(item => item.status === "local").length,
    shell: families.filter(item => item.layer === "shell").length,
    section: families.filter(item => item.layer === "section").length,
    variants: families.reduce((sum, item) => sum + item.variants.length, 0),
    unresolved: unresolved.length
  };
  return {
    rule: "Component families are reviewer-visible architecture proposals, not generated component source. Manual semantic intent wins over generic cluster naming; reuse status depends on recurrence, cross-page evidence, and structural/style similarity. One-off sections remain local, and leaf UI controls are intentionally out of scope until direct element-level evidence is captured.",
    families,
    unresolved,
    coverage: {
      sectionFamilies: "modeled",
      shellFamilies: "modeled",
      leafControls: leafControlsObserved ? "observed" : "not-modeled",
      reason: leafControlsObserved
        ? "Section/shell families use reviewed section DOM evidence. Direct leaf UI evidence is available separately in ui-families.json and is not inferred from section descendant counts."
        : "Section/shell families use reviewed section DOM evidence. Leaf controls need a dedicated UI-element inventory rather than inference from descendant counts."
    },
    summary
  };
}

function unionSectionBoxes(boxes: Array<{ x: number; y: number; width: number; height: number }>): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function legacySectionRoots(section: AuditSection): AuditLayoutNode[] {
  if (section.roots?.length) return section.roots;
  if (!section.selector) return [];
  return [{
    selector: section.selector,
    tag: section.tag ?? "section",
    heading: section.heading,
    content: section.content,
    structure: section.structure,
    style: section.style,
    headingStyle: section.headingStyle,
    box: section.box
  }];
}

function sectionObservations(artifacts: AuditArtifact[]): SectionObservation[] {
  return artifacts.flatMap(artifact => {
    const page = pageId(artifact.sourceUrl);
    const viewportWidth = artifact.sections.viewport?.width ?? 1440;
    return artifact.sections.items.map(section => {
      const selectors = [...new Set((section.selectors?.length ? section.selectors : section.selector ? [section.selector] : []).filter(Boolean))];
      const viewports: Record<string, SectionViewportEvidence> = {};
      const viewportNames = [...new Set([
        ...Object.keys(artifact.sections.regions ?? {}),
        ...Object.keys(artifact.sections.manualRegions ?? {})
      ])];
      for (const viewport of viewportNames) {
        const regionSet = artifact.sections.regions?.[viewport];
        const manualSet = artifact.sections.manualRegions?.[viewport];
        const bySelector = new Map((regionSet?.items ?? []).map(item => [item.selector, item]));
        const byManualSelector = new Map((manualSet?.items ?? []).map(item => [item.sourceSelector, item]));
        const matches = selectors.map(selector => {
          const manual = section.source === "manual" ? byManualSelector.get(selector) : undefined;
          if (manual) return { item: manual.item, score: manual.score ?? 1 };
          const generic = bySelector.get(selector);
          return generic ? { item: generic, score: 1 } : undefined;
        }).filter((item): item is { item: AuditLayoutNode; score: number } => Boolean(item));
        const roots = matches.map(match => match.item);
        if (roots.length === 0) continue;
        const boundaryCandidates = section.source === "manual"
          ? selectors.map(selector => byManualSelector.get(selector)?.boundary).filter((item): item is AuditLayoutNode => Boolean(item))
          : [];
        const boundarySelectors = [...new Set(boundaryCandidates.map(item => item.selector))];
        const boundary = boundarySelectors.length === 1 ? boundaryCandidates[0] : undefined;
        const boundaryConfidenceValues = section.source === "manual"
          ? selectors.map(selector => byManualSelector.get(selector)?.boundaryConfidence).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
          : [];
        const fallbackViewport = AUDIT_VIEWPORTS[viewport as keyof typeof AUDIT_VIEWPORTS];
        viewports[viewport] = {
          viewport,
          width: Number(manualSet?.viewport?.width ?? regionSet?.viewport?.width ?? fallbackViewport?.width ?? viewportWidth),
          height: Number(manualSet?.viewport?.height ?? regionSet?.viewport?.height ?? fallbackViewport?.height ?? 0) || undefined,
          roots,
          box: unionSectionBoxes(roots.map(root => root.box)),
          matchedSelectors: roots.length,
          totalSelectors: Math.max(1, selectors.length),
          matchConfidence: round(average(matches.map(match => match.score))),
          boundary,
          boundaryConfidence: boundary ? round(average(boundaryConfidenceValues.length > 0 ? boundaryConfidenceValues : [1])) : undefined
        };
      }
      if (!viewports.desktop) {
        const roots = legacySectionRoots(section);
        if (roots.length > 0) {
          viewports.desktop = {
            viewport: "desktop",
            width: viewportWidth,
            height: artifact.sections.viewport?.height,
            roots,
            box: unionSectionBoxes(roots.map(root => root.box)),
            matchedSelectors: roots.length,
            totalSelectors: Math.max(1, selectors.length || roots.length)
          };
        }
      }
      return { page, sourceUrl: artifact.sourceUrl, section, viewportWidth, viewports };
    });
  });
}

function pixelValue(value: string | undefined): number | undefined {
  const parsed = parseCssDimension(value);
  if (!parsed || parsed.unit !== "px" || !Number.isFinite(parsed.value)) return undefined;
  return parsed.value;
}

function formatDimensionNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value, 3)).replace(/\.0+$/, "");
}

function sectionKey(item: SectionObservation): string {
  return `${item.page}:${item.section.auditId}`;
}

export function buildSectionRhythmModel(
  observations: SectionObservation[],
  clusters: SectionCluster[],
  primitives: PrimitiveTokenCandidate[]
): SectionRhythmModel {
  const rule = "Section rhythm is inferred from logical section boundaries. Reviewed manual groups first use the resolved nearest common-ancestor container at each viewport; when no reliable group boundary is available, the model falls back to the first root's top padding and last root's bottom padding. The same manual roots are resolved independently at every audited viewport. Global spacing inventory is only a cross-check, never a substitute for section-level viewport evidence.";
  const sectionObservations = observations.filter(item => item.section.role !== "header" && item.section.role !== "footer" && item.section.tag !== "header" && item.section.tag !== "footer");
  const pages = [...new Set(sectionObservations.map(item => item.page))].sort();
  const totalPages = Math.max(1, pages.length);
  const knownViewports = ["desktop", "tablet", "mobile"];
  const spacing = primitives.filter(item => item.group === "space" && typeof item.value === "string" && pixelValue(item.value) !== undefined);
  const primitiveByValue = new Map(spacing.map(item => [String(item.value), item]));
  const clusterByMember = new Map<string, SectionCluster>();
  for (const cluster of clusters) for (const member of cluster.members) clusterByMember.set(`${member.page}:${member.auditId}`, cluster);

  interface RhythmOccurrence {
    item: SectionObservation;
    viewport: string;
    balanced: boolean;
    paddingTop?: string;
    paddingBottom?: string;
    selectorCoverage: number;
    boundarySource: "common-ancestor" | "roots";
    boundarySelector?: string;
  }
  const occurrences = new Map<string, RhythmOccurrence[]>();
  for (const item of sectionObservations) {
    for (const [viewport, evidence] of Object.entries(item.viewports)) {
      if (evidence.roots.length === 0) continue;
      const roots = [...evidence.roots].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
      const firstRoot = roots[0];
      const lastRoot = roots[roots.length - 1];
      const boundaryTop = pixelValue(evidence.boundary?.style?.paddingTop);
      const boundaryBottom = pixelValue(evidence.boundary?.style?.paddingBottom);
      const boundaryHasVerticalSignal = (boundaryTop !== undefined && boundaryTop >= 24) || (boundaryBottom !== undefined && boundaryBottom >= 24);
      const canUseBoundary = Boolean(evidence.boundary) && boundaryHasVerticalSignal && (evidence.boundaryConfidence ?? 0) >= 0.45;
      const boundarySource: "common-ancestor" | "roots" = canUseBoundary ? "common-ancestor" : "roots";
      const topStyle = canUseBoundary ? evidence.boundary?.style?.paddingTop : firstRoot?.style?.paddingTop;
      const bottomStyle = canUseBoundary ? evidence.boundary?.style?.paddingBottom : lastRoot?.style?.paddingBottom;
      const top = pixelValue(topStyle);
      const bottom = pixelValue(bottomStyle);
      const topValue = top !== undefined && top >= 24 ? `${formatDimensionNumber(top)}px` : undefined;
      const bottomValue = bottom !== undefined && bottom >= 24 ? `${formatDimensionNumber(bottom)}px` : undefined;
      if (!topValue && !bottomValue) continue;
      const rootCoverage = (evidence.matchedSelectors / Math.max(1, evidence.totalSelectors)) * (evidence.matchConfidence ?? 1);
      const selectorCoverage = round(rootCoverage * (canUseBoundary ? evidence.boundaryConfidence ?? 1 : 1));
      const occurrenceBase = {
        item,
        viewport,
        paddingTop: topStyle,
        paddingBottom: bottomStyle,
        selectorCoverage,
        boundarySource,
        boundarySelector: canUseBoundary ? evidence.boundary?.selector : undefined
      };
      if (topValue && bottomValue && Math.abs((top ?? 0) - (bottom ?? 0)) <= 0.5) {
        const list = occurrences.get(topValue) ?? [];
        list.push({ ...occurrenceBase, balanced: true });
        occurrences.set(topValue, list);
        continue;
      }
      if (topValue) {
        const list = occurrences.get(topValue) ?? [];
        list.push({ ...occurrenceBase, balanced: false });
        occurrences.set(topValue, list);
      }
      if (bottomValue && bottomValue !== topValue) {
        const list = occurrences.get(bottomValue) ?? [];
        list.push({ ...occurrenceBase, balanced: false });
        occurrences.set(bottomValue, list);
      }
    }
  }

  const candidates: SectionRhythmCandidate[] = [];
  const rejected: SectionRhythmModel["rejected"] = [];
  for (const [value, raw] of occurrences) {
    const primitive = primitiveByValue.get(value);
    if (!primitive) continue;
    const unique = new Map<string, RhythmOccurrence>();
    for (const occurrence of raw) {
      const key = `${sectionKey(occurrence.item)}:${occurrence.viewport}`;
      const previous = unique.get(key);
      if (!previous || occurrence.balanced) unique.set(key, occurrence);
    }
    const viewportItems = [...unique.values()];
    const bySection = new Map<string, RhythmOccurrence[]>();
    for (const occurrence of viewportItems) {
      const key = sectionKey(occurrence.item);
      const list = bySection.get(key) ?? [];
      list.push(occurrence);
      bySection.set(key, list);
    }
    const logicalItems = [...bySection.values()].map(items => items[0]!).filter(Boolean);
    const itemPages = [...new Set(logicalItems.map(item => item.item.page))].sort();
    const pageCoverage = round(itemPages.length / totalPages);
    const balancedSectionKeys = [...bySection.entries()].filter(([, items]) => items.some(item => item.balanced)).map(([key]) => key);
    const balancedSections = balancedSectionKeys.length;
    const balancedRatio = round(balancedSections / Math.max(1, bySection.size));
    const responsiveSections = [...bySection.values()].filter(items => new Set(items.map(item => item.viewport)).size >= 2).length;
    const responsiveRatio = round(responsiveSections / Math.max(1, bySection.size));
    const selectorCoverage = round(average(viewportItems.map(item => item.selectorCoverage)));
    const sectionViewportNames = knownViewports.filter(viewport => viewportItems.some(item => item.viewport === viewport));
    const manualSections = logicalItems.filter(item => item.item.section.source === "manual").length;
    const clusterCounts = new Map<string, number>();
    for (const item of logicalItems) {
      const cluster = clusterByMember.get(sectionKey(item.item));
      if (cluster) clusterCounts.set(cluster.id, (clusterCounts.get(cluster.id) ?? 0) + 1);
    }
    const candidateClusters = [...clusterCounts.keys()].sort();
    const repeatedClusterEntries = [...clusterCounts.entries()].filter(([, count]) => count >= 2);
    const repeatedClusters = repeatedClusterEntries.length;
    const reusableRepeatedClusters = repeatedClusterEntries.filter(([id]) => {
      const cluster = clusters.find(item => item.id === id);
      return cluster?.suggestedFamily !== "hero" && cluster?.suggestedFamily !== "site-header" && cluster?.suggestedFamily !== "site-footer";
    }).length;

    const paddingTop = primitive.evidence.properties?.paddingTop ?? 0;
    const paddingBottom = primitive.evidence.properties?.paddingBottom ?? 0;
    const verticalCount = paddingTop + paddingBottom;
    const inventoryCount = Math.max(1, primitive.evidence.count);
    const verticalShare = round(verticalCount / inventoryCount);
    const inventoryViewportNames = knownViewports.filter(viewport => (primitive.evidence.viewports?.[viewport] ?? 0) > 0);
    const viewportCoverage = round(sectionViewportNames.length / knownViewports.length);
    const recurrence = clamp(bySection.size / 4);
    const clusterSignal = repeatedClusters > 0 ? 1 : candidateClusters.length > 0 ? 0.45 : 0;
    const confidence = round(clamp(
      0.18 * pageCoverage
      + 0.18 * balancedRatio
      + 0.1 * recurrence
      + 0.1 * clusterSignal
      + 0.09 * Math.min(1, verticalShare)
      + 0.11 * viewportCoverage
      + 0.12 * responsiveRatio
      + 0.06 * selectorCoverage
      + 0.06 * primitive.confidence
    ));
    const hasReusableEvidence = reusableRepeatedClusters > 0 || bySection.size >= 4;
    const strong = bySection.size >= 2
      && itemPages.length >= Math.min(2, totalPages)
      && balancedRatio >= 0.6
      && verticalShare >= 0.35
      && viewportCoverage >= 2 / 3
      && responsiveRatio >= 0.5
      && selectorCoverage >= 0.75
      && hasReusableEvidence
      && confidence >= 0.76;
    const supporting = !strong
      && bySection.size >= 2
      && balancedRatio >= 0.5
      && verticalShare >= 0.25
      && selectorCoverage >= 0.6
      && confidence >= 0.6;
    const strength: SectionRhythmCandidate["strength"] = strong ? "strong" : supporting ? "supporting" : "weak";
    const reason = strong
      ? "Logical section boundary padding repeats across pages and audited viewports, remains balanced at the section boundary, and is supported by reusable section evidence."
      : supporting
        ? "Logical section boundary padding repeats, but one or more cross-page, responsive, balance, or reuse signals are not strong enough for automatic canonical section spacing."
        : "The value is retained for review but lacks reusable cross-page and per-section viewport evidence required for canonical section spacing.";
    const candidate: SectionRhythmCandidate = {
      value,
      primitiveCandidate: primitive.id,
      confidence,
      strength,
      evidence: {
        sections: bySection.size,
        viewportOccurrences: viewportItems.length,
        pages: itemPages,
        pageCoverage,
        balancedSections,
        balancedRatio,
        responsiveSections,
        responsiveRatio,
        selectorCoverage,
        sectionViewports: sectionViewportNames,
        manualSections,
        clusters: candidateClusters,
        repeatedClusters,
        inventory: {
          count: primitive.evidence.count,
          paddingTop,
          paddingBottom,
          verticalShare,
          viewports: inventoryViewportNames,
          viewportCoverage
        },
        examples: viewportItems.slice(0, 18).map(item => ({
          page: item.item.page,
          viewport: item.viewport,
          auditId: item.item.section.auditId,
          label: item.item.section.label,
          source: item.item.section.source,
          cluster: clusterByMember.get(sectionKey(item.item))?.id,
          selector: item.item.section.selector,
          screenshot: item.item.section.screenshot,
          paddingTop: item.paddingTop,
          paddingBottom: item.paddingBottom,
          boundarySource: item.boundarySource,
          boundarySelector: item.boundarySelector
        }))
      },
      reason
    };
    candidates.push(candidate);
    if (strength === "weak") rejected.push({ value, primitiveCandidate: primitive.id, reason });
  }

  candidates.sort((a, b) => {
    const strengthRank = { strong: 0, supporting: 1, weak: 2 } as const;
    return strengthRank[a.strength] - strengthRank[b.strength]
      || b.confidence - a.confidence
      || b.evidence.sections - a.evidence.sections
      || (pixelValue(b.value) ?? 0) - (pixelValue(a.value) ?? 0);
  });
  const strong = candidates.filter(item => item.strength === "strong");
  const first = strong[0];
  const second = strong[1];
  const dominant = !!first && (!second
    || first.evidence.sections >= Math.ceil(second.evidence.sections * 1.5)
    || first.confidence >= second.confidence + 0.05
    || first.evidence.repeatedClusters > second.evidence.repeatedClusters
    || first.evidence.responsiveSections > second.evidence.responsiveSections);
  const recommended = dominant && first ? {
    value: first.value,
    primitiveCandidate: first.primitiveCandidate,
    confidence: first.confidence,
    reason: first.reason
  } : undefined;
  const recommendedPx = pixelValue(recommended?.value);
  const compactCandidates = recommendedPx === undefined ? [] : candidates
    .filter(item => item.strength !== "weak" && (pixelValue(item.value) ?? Number.POSITIVE_INFINITY) <= recommendedPx * 0.8)
    .map(item => item.value);
  return {
    status: recommended ? "proposed" : "unresolved",
    rule,
    recommended,
    compactCandidates,
    candidates,
    rejected
  };
}

function shellCandidates(clusters: SectionCluster[], totalPages: number): Array<Record<string, unknown>> {
  const header = clusters.find(cluster => cluster.suggestedFamily === "site-header");
  const footer = clusters.find(cluster => cluster.suggestedFamily === "site-footer");
  const items: Array<Record<string, unknown>> = [];
  if (header) items.push({ role: "header", cluster: header.id, coverage: round(header.pages.length / totalPages), confidence: round(header.score * 0.95) });
  if (footer) items.push({ role: "footer", cluster: footer.id, coverage: round(footer.pages.length / totalPages), confidence: round(footer.score * 0.95) });
  if (header || footer) {
    const coverage = average([header, footer].filter(Boolean).map(cluster => (cluster as SectionCluster).pages.length / totalPages));
    items.unshift({
      id: "shell-candidate-01",
      suggestedId: "shared",
      confidence: round(0.65 + 0.25 * coverage),
      regions: { header: header?.id, footer: footer?.id },
      reason: "Shared landmark regions repeat across representative pages. Name the shell according to the site architecture during review."
    });
  }
  return items;
}

function mediaRole(item: AuditMediaItem): { role: string; confidence: number; reason: string } {
  const text = `${item.url ?? ""} ${item.alt ?? ""} ${item.title ?? ""} ${item.usages.map(usage => usage.selector).join(" ")}`.toLowerCase();
  const maxWidth = Math.max(item.naturalWidth ?? 0, ...item.usages.map(usage => usage.width));
  const maxHeight = Math.max(item.naturalHeight ?? 0, ...item.usages.map(usage => usage.height));
  if (item.kind === "video") return { role: "video", confidence: 0.99, reason: "Observed as a video resource." };
  if (/\blogo\b/.test(text)) return { role: "logo", confidence: 0.9, reason: "URL, alt/title, or selector contains a logo marker." };
  if ((maxWidth > 0 && maxWidth <= 96) && (maxHeight > 0 && maxHeight <= 96)) return { role: "icon", confidence: 0.78, reason: "Observed dimensions are icon-sized." };
  if (/screenshot|dashboard|editor|product|stories|message|banner|campaign|device|phone/.test(text) && maxWidth >= 320) {
    return { role: "product-shot", confidence: 0.76, reason: "Large media has product/UI vocabulary in its production evidence." };
  }
  if (item.kind === "inline-svg" || item.kind === "background-image") return { role: "illustration", confidence: 0.62, reason: "Observed as inline SVG or CSS background artwork; confirm whether it is decorative or content-bearing." };
  return { role: "content-image", confidence: 0.5, reason: "No stronger deterministic role signal was found." };
}

function buildMediaRoles(artifacts: AuditArtifact[]): Array<Record<string, unknown>> {
  const roleMap = new Map<string, { count: number; pages: Set<string>; confidence: number[]; examples: Array<Record<string, unknown>>; reasons: Set<string> }>();
  for (const artifact of artifacts) {
    const page = pageId(artifact.sourceUrl);
    for (const item of artifact.media.items) {
      const role = mediaRole(item);
      const current = roleMap.get(role.role) ?? { count: 0, pages: new Set<string>(), confidence: [], examples: [], reasons: new Set<string>() };
      current.count += 1;
      current.pages.add(page);
      current.confidence.push(role.confidence);
      current.reasons.add(role.reason);
      if (current.examples.length < 12) current.examples.push({
        page,
        kind: item.kind,
        url: item.url,
        alt: item.alt,
        usages: item.usages.slice(0, 3)
      });
      roleMap.set(role.role, current);
    }
  }
  return [...roleMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, item]) => ({
    role,
    count: item.count,
    pages: [...item.pages].sort(),
    coverage: round(item.pages.size / artifacts.length),
    confidence: round(average(item.confidence)),
    reasons: [...item.reasons].sort(),
    examples: item.examples
  }));
}

function relativeAuditPath(root: string, auditRoot: string): string {
  const value = relative(root, auditRoot);
  return value && !value.startsWith("..") ? value.replaceAll("\\", "/") : auditRoot.replaceAll("\\", "/");
}

export async function designAudits(options: MigrateDesignOptions): Promise<MigrateDesignResult> {
  const root = resolve(options.root ?? ".");
  const loaded = await loadInputs(options.audits, root);
  const output = resolveDesignOutputDirectory(root, loaded.host, options.output);
  await prepareDesignOutputDirectory(output);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design",
    status: "analyzing",
    site: loaded.host,
    output: "."
  }, null, 2)}\n`, "utf8");

  const foundations = aggregateAuditFoundations(loaded.artifacts);
  const tokens = buildTokenCandidates(foundations);
  const observations = sectionObservations(loaded.artifacts);
  const clustered = clusterSections(observations);
  const uiFamilies = buildUiFamilyModel(loaded.artifacts.map(artifact => ({
    page: pageId(artifact.sourceUrl),
    sourceUrl: artifact.sourceUrl,
    items: artifact.ui?.items ?? []
  })));
  const componentFamilies = buildComponentFamilyModel(observations, clustered.clusters, loaded.artifacts.length, uiFamilies.summary.observed > 0);
  const sectionRhythm = buildSectionRhythmModel(observations, clustered.clusters, tokens.primitive);
  const foundationProposal = buildFoundationProposal(tokens, sectionRhythm);
  const shells = shellCandidates(clustered.clusters, loaded.artifacts.length);
  const mediaRoles = buildMediaRoles(loaded.artifacts);

  const foundationsFile = "foundations.json";
  const tokensFile = "token-candidates.json";
  const foundationProposalFile = "foundation-proposal.json";
  const rhythmFile = "section-rhythm.json";
  const clustersFile = "section-clusters.json";
  const componentFamiliesFile = "component-families.json";
  const uiFamiliesFile = "ui-families.json";
  const shellsFile = "shell-candidates.json";
  const mediaFile = "media-roles.json";
  const reportFile = "report.json";

  await writeFile(join(output, foundationsFile), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design-foundations",
    site: loaded.host,
    audits: loaded.artifacts.map(artifact => ({ id: pageId(artifact.sourceUrl), sourceUrl: artifact.sourceUrl })),
    ...foundations
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, tokensFile), `${JSON.stringify({
    version: "0.2",
    type: "sitespec-migrate-design-token-candidates",
    site: loaded.host,
    rule: "Candidates are normalized evidence-backed proposals only. foundations.json remains exact production evidence; review normalization decisions and candidate names before editing design/tokens.json.",
    normalization: tokens.normalization,
    primitive: tokens.primitive,
    semantic: tokens.semantic,
    typography: tokens.typography
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, foundationProposalFile), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design-foundation-proposal",
    site: loaded.host,
    source: {
      foundations: foundationsFile,
      tokenCandidates: tokensFile,
      sectionRhythm: rhythmFile,
      pages: loaded.artifacts.map(artifact => ({ id: pageId(artifact.sourceUrl), sourceUrl: artifact.sourceUrl }))
    },
    rule: "This is a reviewable proposed token scale and Design System foundation model derived from normalized candidates plus section-rhythm evidence. It does not mutate design/tokens.json and must retain links back to candidate evidence.",
    ...foundationProposal
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, rhythmFile), `${JSON.stringify({
    version: "0.4",
    type: "sitespec-migrate-design-section-rhythm",
    site: loaded.host,
    source: {
      foundations: foundationsFile,
      tokenCandidates: tokensFile,
      sectionClusters: clustersFile,
      pages: loaded.artifacts.map(artifact => ({ id: pageId(artifact.sourceUrl), sourceUrl: artifact.sourceUrl }))
    },
    ...sectionRhythm
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, clustersFile), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design-section-clusters",
    site: loaded.host,
    threshold: 0.68,
    rule: "Clusters are structural/style similarity evidence, not automatic component boundaries. Cross-page manual matches are gated by conservative semantic intent inferred from reviewer labels, strong headings, landmarks, and distinctive structure.",
    clusters: clustered.clusters,
    unclustered: clustered.unclustered.map(item => ({
      page: item.page,
      sourceUrl: item.sourceUrl,
      auditId: item.section.auditId,
      label: item.section.label,
      selector: item.section.selector,
      selectors: item.section.selectors,
      screenshot: item.section.screenshot,
      screenshotClip: item.section.screenshotClip,
      source: item.section.source,
      semanticIntent: inferManualSectionIntent(item.section)
    }))
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, componentFamiliesFile), `${JSON.stringify({
    version: "0.2",
    type: "sitespec-migrate-design-component-families",
    site: loaded.host,
    source: {
      sectionClusters: clustersFile,
      foundationProposal: foundationProposalFile,
      pages: loaded.artifacts.map(artifact => ({ id: pageId(artifact.sourceUrl), sourceUrl: artifact.sourceUrl }))
    },
    ...componentFamilies
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, uiFamiliesFile), `${JSON.stringify({
    version: "0.2",
    type: "sitespec-migrate-design-ui-families",
    site: loaded.host,
    source: {
      pages: loaded.artifacts.map(artifact => ({ id: pageId(artifact.sourceUrl), sourceUrl: artifact.sourceUrl, auditUi: artifact.ui ? "ui-inventory.json" : null }))
    },
    ...uiFamilies
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, shellsFile), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design-shell-candidates",
    site: loaded.host,
    items: shells
  }, null, 2)}\n`, "utf8");
  await writeFile(join(output, mediaFile), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design-media-roles",
    site: loaded.host,
    rule: "Media roles are migration hints. Product/content assets remain site-owned unless the Design System explicitly owns brand/decorative assets.",
    items: mediaRoles
  }, null, 2)}\n`, "utf8");

  const foundationValues = foundations.colors.length + foundations.typography.length + foundations.radii.length + foundations.shadows.length + foundations.spacing.length + foundations.containerWidths.length;
  const clusteredSections = clustered.clusters.reduce((sum, cluster) => sum + cluster.members.length, 0);
  const { rejected: _normalizationRejected, ...tokenNormalization } = tokens.normalization;
  const result: MigrateDesignResult = {
    site: loaded.host,
    output,
    audits: loaded.artifacts.map(artifact => ({ sourceUrl: artifact.sourceUrl, path: relativeAuditPath(root, artifact.root) })),
    files: {
      report: reportFile,
      foundations: foundationsFile,
      tokenCandidates: tokensFile,
      foundationProposal: foundationProposalFile,
      sectionRhythm: rhythmFile,
      sectionClusters: clustersFile,
      componentFamilies: componentFamiliesFile,
      uiFamilies: uiFamiliesFile,
      shellCandidates: shellsFile,
      mediaRoles: mediaFile
    },
    summary: {
      pages: loaded.artifacts.length,
      manualSegmentPages: loaded.artifacts.filter(artifact => artifact.sections.source === "manual").length,
      foundationValues,
      primitiveTokenCandidates: tokens.primitive.length,
      semanticTokenCandidates: tokens.semantic.length,
      typographyCandidates: tokens.typography.length,
      foundationProposal: foundationProposal.summary,
      sectionRhythm: {
        status: sectionRhythm.status,
        candidates: sectionRhythm.candidates.length,
        strongCandidates: sectionRhythm.candidates.filter(item => item.strength === "strong").length,
        recommended: sectionRhythm.recommended?.value,
        confidence: sectionRhythm.recommended?.confidence ?? sectionRhythm.candidates[0]?.confidence ?? 0
      },
      sectionClusters: clustered.clusters.length,
      clusteredSections,
      unclusteredSections: clustered.unclustered.length,
      componentFamilies: componentFamilies.summary,
      uiFamilies: uiFamilies.summary,
      shellCandidates: shells.length,
      mediaRoleCandidates: mediaRoles.length,
      tokenNormalization
    }
  };

  await writeFile(join(output, reportFile), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-design",
    status: "complete",
    ...result,
    output: ".",
    nextActions: [
      "Treat foundations.json as immutable raw production evidence; inspect token-candidates.json normalization decisions instead of editing the raw evidence.",
      "Review token-candidates.json rejected evidence and normalized candidates; do not copy candidate names blindly into design/tokens.json.",
      "Review section-rhythm.json for section-root vertical rhythm evidence; one-sided page/header offsets are intentionally excluded from automatic space.section decisions.",
      "Review foundation-proposal.json as the rationalized token scale/design foundation layer, then run migrate foundation review to create the explicit accept/reject/pending decision artifact before materializing canonical tokens.",
      "Review section-clusters.json against manual segment clips or source section screenshots from the audits.",
      "Review component-families.json as the proposed shell/section component architecture, then run migrate components review before generating component contracts.",
      "Review ui-families.json as direct leaf UI evidence. Badge/Card remain candidates until explicitly reviewed; interactive visual states are not yet captured.",
      "Confirm shell-candidates.json and media-roles.json before scaffolding a Design System.",
      "Audit a third page later to test Design System coverage rather than overfitting the first two pages."
    ]
  }, null, 2)}\n`, "utf8");

  return result;
}

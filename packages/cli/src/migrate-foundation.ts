import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDesign, loadDesignSystemContract } from "@sitespec/core";
import type {
  DesignFoundationProposal,
  FoundationProposalStatus,
  FoundationSemanticProposal,
  FoundationTokenProposal,
  FoundationTypographyRoleProposal
} from "./migrate-design.js";

export type FoundationReviewPolicy = "conservative" | "manual" | "all";
export type FoundationReviewAction = "accept" | "reject" | "pending";
export type FoundationLayoutReviewAction = FoundationReviewAction | "provisional";

interface FoundationProposalDocument extends DesignFoundationProposal {
  version: string;
  type: "sitespec-migrate-design-foundation-proposal";
  site: string;
  source?: Record<string, unknown>;
  rule?: string;
}

export interface FoundationPrimitiveReviewDecision {
  source: string;
  path: string;
  status: FoundationProposalStatus;
  confidence: number;
  action: FoundationReviewAction;
  reason: string;
}

export interface FoundationSemanticReviewDecision {
  source: string;
  path: string;
  primitive: string;
  confidence: number;
  action: FoundationReviewAction;
  reason: string;
}

export interface FoundationTypographyReviewDecision {
  sourceRole: string;
  role: string;
  status: Exclude<FoundationProposalStatus, "exception">;
  confidence: number;
  action: FoundationReviewAction;
  reason: string;
}

export interface FoundationLayoutReviewDecision {
  contentWidth: {
    action: FoundationLayoutReviewAction;
    semanticPath: string;
    primitive: string | null;
    confidence: number;
    reason: string;
  };
  pageGutter: {
    action: FoundationLayoutReviewAction;
    semanticPath: string;
    primitivePath: string;
    type: "dimension";
    value: string | null;
    confidence: number;
    sources: string[];
    reason: string;
  };
  sectionSpacing: {
    action: FoundationLayoutReviewAction;
    semanticPath: string;
    primitive: string | null;
    candidates: Array<{ primitive: string; value: string | number; status: FoundationProposalStatus; confidence: number }>;
    reason: string;
    provisional?: {
      source: "target-design-system" | "sitespec-default-template";
      sourceFile: string;
      primitivePath: string;
      type: "dimension";
      value: string | number;
      reason: string;
    };
  };
}

export interface FoundationReviewDocument {
  version: "0.1" | "0.2";
  type: "sitespec-migrate-foundation-review";
  site: string;
  source: {
    proposal: string;
    proposalSha256: string;
    proposalVersion: string;
  };
  policy: FoundationReviewPolicy;
  rule: string;
  decisions: {
    primitive: FoundationPrimitiveReviewDecision[];
    semantic: FoundationSemanticReviewDecision[];
    typography: FoundationTypographyReviewDecision[];
    layout: FoundationLayoutReviewDecision;
  };
  unresolved: DesignFoundationProposal["unresolved"];
  summary: FoundationReviewSummary;
}

export interface FoundationReviewSummary {
  primitive: Record<FoundationReviewAction, number>;
  semantic: Record<FoundationReviewAction, number>;
  typography: Record<FoundationReviewAction, number>;
  layout: Record<FoundationLayoutReviewAction, number>;
  blocking: string[];
  provisional: string[];
}

export interface CreateFoundationReviewOptions {
  analysis: string;
  root?: string;
  output?: string;
  policy?: FoundationReviewPolicy;
  force?: boolean;
}

export interface CreateFoundationReviewResult {
  site: string;
  proposal: string;
  output: string;
  policy: FoundationReviewPolicy;
  summary: FoundationReviewSummary;
}

export interface MaterializeFoundationOptions {
  review: string;
  root?: string;
  output?: string;
  apply?: boolean;
  replace?: boolean;
}

export interface MaterializedFoundationToken {
  path: string;
  type: string;
  value: string | number;
  source: string;
  synthesized?: boolean;
  provisional?: boolean;
  provenance?: {
    status: "provisional";
    source: string;
    reason: string;
  };
}

export interface MaterializeFoundationResult {
  site: string;
  review: string;
  proposal: string;
  status: "ready" | "blocked";
  quality: "canonical" | "provisional";
  output: string;
  applied?: string;
  blockers: string[];
  warnings: string[];
  hints: string[];
  summary: {
    primitive: number;
    semantic: number;
    typographyRoles: number;
    synthesizedPrimitive: number;
    provisionalTokens: number;
    carriedSemanticTokens: number;
  };
}

export class MigrateFoundationError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateFoundationError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function relativeOrAbsolute(from: string, to: string): string {
  const rel = relative(from, to);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? slash(rel) : slash(to);
}

function countActions<T extends { action: FoundationReviewAction }>(items: T[]): Record<FoundationReviewAction, number> {
  return {
    accept: items.filter(item => item.action === "accept").length,
    reject: items.filter(item => item.action === "reject").length,
    pending: items.filter(item => item.action === "pending").length
  };
}

function countLayoutActions<T extends { action: FoundationLayoutReviewAction }>(items: T[]): Record<FoundationLayoutReviewAction, number> {
  return {
    accept: items.filter(item => item.action === "accept").length,
    reject: items.filter(item => item.action === "reject").length,
    pending: items.filter(item => item.action === "pending").length,
    provisional: items.filter(item => item.action === "provisional").length
  };
}

function primitiveProposals(proposal: DesignFoundationProposal): FoundationTokenProposal[] {
  return [
    ...proposal.primitive.color,
    ...proposal.primitive.spacing.tokens,
    ...proposal.primitive.radius,
    ...proposal.primitive.shadow,
    ...proposal.primitive.size,
    ...proposal.primitive.font.family,
    ...proposal.primitive.font.size,
    ...proposal.primitive.font.weight,
    ...proposal.primitive.font.lineHeight,
    ...proposal.primitive.font.letterSpacing
  ];
}

function initialPrimitiveAction(item: FoundationTokenProposal, policy: FoundationReviewPolicy, inferredLayoutPrimitive?: string): FoundationReviewAction {
  if (policy === "manual") return "pending";
  if (policy === "all") return "accept";
  if (inferredLayoutPrimitive && item.path === inferredLayoutPrimitive) return "accept";
  return item.status === "core" ? "accept" : "pending";
}

function primitiveReferences(style: FoundationTypographyRoleProposal["style"]): string[] {
  return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing]
    .filter((value): value is string => typeof value === "string" && value.startsWith("primitive."));
}

function px(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/i);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value, 4)).replace(/\.0+$/, "");
}

function responsivePageGutterValue(proposal: FoundationProposalDocument): { value: string | null; sources: string[]; reason: string } {
  const values = proposal.layout.pageGutter.values;
  const widths = new Map((proposal.layout.contentWidth?.responsiveEvidence ?? []).map(item => [item.viewport, px(item.viewportWidth)]));
  const points = values.map(item => ({ viewport: item.viewport, width: widths.get(item.viewport), value: px(item.value), source: item.source }))
    .filter((item): item is { viewport: string; width: number; value: number; source: string } => item.width !== undefined && item.value !== undefined)
    .sort((a, b) => a.width - b.width);
  const sources = [...new Set(values.map(item => item.source))].sort();
  if (points.length < 2) return { value: null, sources, reason: "Responsive page gutter needs at least two viewport/value points." };
  if (points.some((point, index) => index > 0 && point.value < points[index - 1]!.value)) {
    return { value: null, sources, reason: "Observed page gutter is not monotonic across viewport widths, so no single safe responsive token is synthesized." };
  }
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  if (Math.abs(max - min) <= 0.01) return { value: `${formatNumber(min)}px`, sources, reason: "Observed page gutter is constant across audited viewports." };

  const ratios = [...new Set(points.map(point => round(point.value / point.width * 100, 6)))];
  let best: { ratio: number; error: number } | undefined;
  for (const ratio of ratios) {
    let error = 0;
    for (const point of points) {
      const predicted = Math.min(max, Math.max(min, point.width * ratio / 100));
      error = Math.max(error, Math.abs(predicted - point.value));
    }
    if (!best || error < best.error) best = { ratio, error };
  }
  if (best && best.error <= 0.5) {
    return {
      value: `clamp(${formatNumber(min)}px, ${formatNumber(best.ratio)}vw, ${formatNumber(max)}px)`,
      sources,
      reason: `Synthesized from audited viewport gutters; the clamp reproduces every observed gutter within ${formatNumber(best.error)}px.`
    };
  }
  return { value: null, sources, reason: "Audited page gutters cannot be represented faithfully by one safe clamp() expression; keep the layout decision pending." };
}

function sectionSpacingCandidates(proposal: FoundationProposalDocument): FoundationLayoutReviewDecision["sectionSpacing"]["candidates"] {
  const base = px(proposal.primitive.spacing.baseUnit) ?? 4;
  const minimum = Math.max(32, base * 8);
  return proposal.primitive.spacing.tokens
    .filter(item => px(item.value) !== undefined && (px(item.value) ?? 0) >= minimum)
    .sort((a, b) => (px(a.value) ?? 0) - (px(b.value) ?? 0))
    .map(item => ({
      primitive: item.path,
      value: item.value,
      status: item.status,
      confidence: item.confidence
    }));
}

function reviewBlockingSummary(review: Pick<FoundationReviewDocument, "decisions">): string[] {
  const blockers: string[] = [];
  if (review.decisions.layout.contentWidth.action !== "accept") blockers.push("layout.contentWidth");
  if (review.decisions.layout.pageGutter.action !== "accept") blockers.push("layout.pageGutter");
  const section = review.decisions.layout.sectionSpacing;
  const sectionAccepted = section.action === "accept" && !!section.primitive;
  const sectionProvisional = section.action === "provisional" && !!section.provisional;
  if (!sectionAccepted && !sectionProvisional) blockers.push("layout.sectionSpacing");
  return blockers;
}

function summarizeReview(review: Pick<FoundationReviewDocument, "decisions">): FoundationReviewSummary {
  const layout = [review.decisions.layout.contentWidth, review.decisions.layout.pageGutter, review.decisions.layout.sectionSpacing];
  return {
    primitive: countActions(review.decisions.primitive),
    semantic: countActions(review.decisions.semantic),
    typography: countActions(review.decisions.typography),
    layout: countLayoutActions(layout),
    blocking: reviewBlockingSummary(review),
    provisional: [
      review.decisions.layout.contentWidth.action === "provisional" ? "layout.contentWidth" : undefined,
      review.decisions.layout.pageGutter.action === "provisional" ? "layout.pageGutter" : undefined,
      review.decisions.layout.sectionSpacing.action === "provisional" ? "layout.sectionSpacing" : undefined
    ].filter((item): item is string => !!item)
  };
}

function validateProposal(value: unknown, file: string): FoundationProposalDocument {
  if (!isRecord(value) || value.type !== "sitespec-migrate-design-foundation-proposal" || typeof value.site !== "string" || !isRecord(value.primitive) || !Array.isArray(value.semantic) || !Array.isArray(value.typography) || !isRecord(value.layout)) {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_PROPOSAL_INVALID", `${file} is not a SiteSpec foundation proposal.`, { file });
  }
  return value as unknown as FoundationProposalDocument;
}

async function resolveProposalFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "foundation-proposal.json");
}

async function readProposal(input: string, root: string): Promise<{ file: string; raw: string; proposal: FoundationProposalDocument }> {
  const file = await resolveProposalFile(input, root);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_PROPOSAL_READ_FAILED", `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  try {
    return { file, raw, proposal: validateProposal(JSON.parse(raw), file) };
  } catch (error) {
    if (error instanceof MigrateFoundationError) throw error;
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_PROPOSAL_INVALID", `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
}

export function buildFoundationReview(proposal: FoundationProposalDocument, proposalFile: string, proposalRaw: string, outputFile: string, policy: FoundationReviewPolicy = "conservative"): FoundationReviewDocument {
  const inferredSectionSpacing = proposal.layout.sectionSpacing?.status === "proposed"
    && proposal.layout.sectionSpacing.confidence >= 0.78
    && proposal.layout.sectionSpacing.primitive
    ? proposal.layout.sectionSpacing.primitive
    : undefined;
  const primitive = primitiveProposals(proposal).map((item): FoundationPrimitiveReviewDecision => ({
    source: item.path,
    path: item.path,
    status: item.status,
    confidence: item.confidence,
    action: initialPrimitiveAction(item, policy, inferredSectionSpacing),
    reason: item.reason
  }));
  const primitiveActions = new Map(primitive.map(item => [item.source, item.action]));
  const semantic = proposal.semantic.map((item: FoundationSemanticProposal): FoundationSemanticReviewDecision => {
    const dependencyAccepted = primitiveActions.get(item.primitive) === "accept";
    const action: FoundationReviewAction = policy === "manual"
      ? "pending"
      : dependencyAccepted && (policy === "all" || item.confidence >= 0.7)
        ? "accept"
        : "pending";
    return { source: item.path, path: item.path, primitive: item.primitive, confidence: item.confidence, action, reason: item.reason };
  });
  const typography = proposal.typography.map((item: FoundationTypographyRoleProposal): FoundationTypographyReviewDecision => {
    const dependenciesAccepted = primitiveReferences(item.style).every(path => primitiveActions.get(path) === "accept");
    const action: FoundationReviewAction = policy === "manual"
      ? "pending"
      : dependenciesAccepted && (policy === "all" || item.status === "core")
        ? "accept"
        : "pending";
    return {
      sourceRole: item.role,
      role: item.role,
      status: item.status,
      confidence: item.confidence,
      action,
      reason: item.status === "core"
        ? "Core typography role is accepted only when every referenced primitive is accepted."
        : "Supporting typography role remains pending under the conservative review policy."
    };
  });

  const gutter = responsivePageGutterValue(proposal);
  const contentPrimitive = proposal.layout.contentWidth?.primitive ?? null;
  const contentAccepted = !!contentPrimitive && primitiveActions.get(contentPrimitive) === "accept";
  const contentAction: FoundationReviewAction = policy === "manual"
    ? "pending"
    : contentAccepted && (proposal.layout.contentWidth?.confidence ?? 0) >= 0.8
      ? "accept"
      : "pending";
  const gutterDependenciesAccepted = proposal.layout.pageGutter.values.every(item => !item.primitive || primitiveActions.get(item.primitive) === "accept");
  const gutterAction: FoundationReviewAction = policy === "manual"
    ? "pending"
    : proposal.layout.pageGutter.status === "proposed" && proposal.layout.pageGutter.confidence >= 0.8 && gutter.value !== null && gutterDependenciesAccepted
      ? "accept"
      : "pending";
  const sectionPrimitive = proposal.layout.sectionSpacing?.primitive ?? null;
  const sectionDependencyAccepted = !!sectionPrimitive && primitiveActions.get(sectionPrimitive) === "accept";
  const sectionAction: FoundationReviewAction = policy === "manual"
    ? "pending"
    : proposal.layout.sectionSpacing?.status === "proposed"
      && proposal.layout.sectionSpacing.confidence >= 0.78
      && sectionDependencyAccepted
      ? "accept"
      : "pending";

  const outputDir = dirname(outputFile);
  const document: FoundationReviewDocument = {
    version: "0.2",
    type: "sitespec-migrate-foundation-review",
    site: proposal.site,
    source: {
      proposal: relativeOrAbsolute(outputDir, proposalFile),
      proposalSha256: sha256(proposalRaw),
      proposalVersion: proposal.version
    },
    policy,
    rule: "This file is the explicit review boundary between inferred foundation proposals and canonical Design System source. Accepted decisions become canonical. A provisional layout decision may preserve an existing target token with explicit provenance while migration evidence remains unresolved. Pending decisions are never materialized silently.",
    decisions: {
      primitive,
      semantic,
      typography,
      layout: {
        contentWidth: {
          action: contentAction,
          semanticPath: "semantic.size.content",
          primitive: contentPrimitive,
          confidence: proposal.layout.contentWidth?.confidence ?? 0,
          reason: proposal.layout.contentWidth?.reason ?? "No content-width proposal is available."
        },
        pageGutter: {
          action: gutterAction,
          semanticPath: "semantic.space.page",
          primitivePath: "primitive.space.page",
          type: "dimension",
          value: gutter.value,
          confidence: proposal.layout.pageGutter.confidence,
          sources: gutter.sources,
          reason: gutter.value ? `${proposal.layout.pageGutter.reason} ${gutter.reason}` : gutter.reason
        },
        sectionSpacing: {
          action: sectionAction,
          semanticPath: "semantic.space.section",
          primitive: sectionPrimitive,
          candidates: sectionSpacingCandidates(proposal),
          reason: proposal.layout.sectionSpacing?.status === "proposed"
            ? proposal.layout.sectionSpacing.reason
            : "Required Design System layout token remains explicitly unresolved. Select an evidence-backed spacing primitive only after section-rhythm review; materialization will not invent this value."
        }
      }
    },
    unresolved: proposal.unresolved,
    summary: undefined as unknown as FoundationReviewSummary
  };
  document.summary = summarizeReview(document);
  return document;
}

async function targetSectionSpacingFallback(root: string, semanticPath: string): Promise<FoundationLayoutReviewDecision["sectionSpacing"]["provisional"] | undefined> {
  try {
    const contract = await loadDesignSystemContract(root);
    const manifest = contract.designSystem?.value;
    if (!manifest) return undefined;
    const semanticName = semanticPath.startsWith("semantic.") ? semanticPath.slice("semantic.".length) : semanticPath;
    if (manifest.layout.tokens.sectionSpacing !== semanticName) return undefined;
    const inspected = await inspectDesign(root);
    const semantic = inspected.design.semantic.find(token => token.path === semanticPath);
    if (!semantic?.alias || semantic.type !== "dimension") return undefined;
    const primitive = inspected.design.primitive.find(token => token.path === semantic.alias);
    if (!primitive || primitive.type !== "dimension") return undefined;
    return {
      source: "target-design-system",
      sourceFile: primitive.source,
      primitivePath: primitive.path,
      type: "dimension",
      value: primitive.value,
      reason: `Preserved from the target Design System (${semantic.path} -> ${primitive.path}) because migration evidence does not yet identify a canonical section rhythm.`
    };
  } catch {
    return undefined;
  }
}

function tokenNodeAtPath(document: unknown, path: string): Record<string, unknown> | undefined {
  if (!isRecord(document)) return undefined;
  let current: unknown = document;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return isRecord(current) ? current : undefined;
}

async function defaultTemplateSectionSpacingFallback(semanticPath: string): Promise<FoundationLayoutReviewDecision["sectionSpacing"]["provisional"] | undefined> {
  try {
    // @sitespec/template is ESM-only: its package exports expose the `import`
    // condition, not `require`. createRequire().resolve() therefore throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED even when the package is installed.
    // SiteSpec requires Node >=22, so use the native ESM resolver here.
    const templateEntry = fileURLToPath(import.meta.resolve("@sitespec/template"));
    const sourceFile = resolve(dirname(templateEntry), "../template/design/tokens.json");
    const parsed = JSON.parse(await readFile(sourceFile, "utf8")) as unknown;
    const semantic = tokenNodeAtPath(parsed, semanticPath);
    const semanticValue = semantic?.$value;
    if (semantic?.$type !== "dimension" || typeof semanticValue !== "string") return undefined;
    const alias = semanticValue.match(/^\{([^{}]+)\}$/)?.[1];
    if (!alias) return undefined;
    const primitive = tokenNodeAtPath(parsed, alias);
    const value = primitive?.$value;
    if (primitive?.$type !== "dimension" || (typeof value !== "string" && typeof value !== "number")) return undefined;
    return {
      source: "sitespec-default-template",
      sourceFile: "@sitespec/template/template/design/tokens.json",
      primitivePath: alias,
      type: "dimension",
      value,
      reason: `Temporarily preserved from the SiteSpec default template (${semanticPath} -> ${alias}) because migration evidence does not yet identify a canonical section rhythm. This fallback is explicitly provisional and should be replaced when stronger section evidence is available.`
    };
  } catch {
    return undefined;
  }
}

export async function createFoundationReview(options: CreateFoundationReviewOptions): Promise<CreateFoundationReviewResult> {
  const root = resolve(options.root ?? ".");
  const loaded = await readProposal(options.analysis, root);
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(loaded.file), "foundation-review.json");
  if (await exists(output) && !options.force) {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_REVIEW_EXISTS", `Foundation review already exists: ${output}. Use --force only when intentionally regenerating the review template.`, { output });
  }
  await mkdir(dirname(output), { recursive: true });
  const review = buildFoundationReview(loaded.proposal, loaded.file, loaded.raw, output, options.policy ?? "conservative");
  if (review.decisions.layout.sectionSpacing.action === "pending" && review.policy !== "manual") {
    const fallback = await targetSectionSpacingFallback(root, review.decisions.layout.sectionSpacing.semanticPath)
      ?? await defaultTemplateSectionSpacingFallback(review.decisions.layout.sectionSpacing.semanticPath);
    if (fallback) {
      review.decisions.layout.sectionSpacing.action = "provisional";
      review.decisions.layout.sectionSpacing.provisional = fallback;
      review.decisions.layout.sectionSpacing.reason = `${review.decisions.layout.sectionSpacing.reason} ${fallback.reason}`;
      review.summary = summarizeReview(review);
    }
  }
  await writeFile(output, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return { site: review.site, proposal: loaded.file, output, policy: review.policy, summary: review.summary };
}

function validateReview(value: unknown, file: string): FoundationReviewDocument {
  const invalid = (message: string): never => {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_REVIEW_INVALID", `${file} ${message}`, { file });
  };
  if (!isRecord(value) || value.type !== "sitespec-migrate-foundation-review" || (value.version !== "0.1" && value.version !== "0.2") || typeof value.site !== "string" || !isRecord(value.source) || !isRecord(value.decisions)) {
    return invalid("is not a SiteSpec foundation review.");
  }
  if (!Array.isArray(value.decisions.primitive) || !Array.isArray(value.decisions.semantic) || !Array.isArray(value.decisions.typography) || !isRecord(value.decisions.layout)) {
    return invalid("must contain primitive, semantic, typography, and layout decisions.");
  }
  const actions = new Set<FoundationReviewAction>(["accept", "reject", "pending"]);
  const layoutActions = new Set<FoundationLayoutReviewAction>(["accept", "reject", "pending", "provisional"]);
  for (const [group, items] of [["primitive", value.decisions.primitive], ["semantic", value.decisions.semantic], ["typography", value.decisions.typography]] as const) {
    for (const [index, item] of items.entries()) {
      if (!isRecord(item) || typeof item.action !== "string" || !actions.has(item.action as FoundationReviewAction)) {
        return invalid(`contains an invalid ${group}[${index}].action; expected accept, reject, or pending.`);
      }
    }
  }
  for (const field of ["contentWidth", "pageGutter", "sectionSpacing"] as const) {
    const item = value.decisions.layout[field];
    if (!isRecord(item) || typeof item.action !== "string" || !layoutActions.has(item.action as FoundationLayoutReviewAction)) {
      return invalid(`contains an invalid layout.${field}.action; expected accept, reject, pending, or provisional.`);
    }
    if (item.action === "provisional" && field !== "sectionSpacing") return invalid(`layout.${field}.action=provisional is not supported.`);
  }
  if ((value.decisions.layout.pageGutter as Record<string, unknown>).type !== "dimension") {
    return invalid("contains an invalid layout.pageGutter.type; expected dimension.");
  }
  const section = value.decisions.layout.sectionSpacing as Record<string, unknown>;
  if (section.action === "provisional") {
    const fallback = section.provisional;
    if (!isRecord(fallback) || (fallback.source !== "target-design-system" && fallback.source !== "sitespec-default-template") || typeof fallback.sourceFile !== "string" || typeof fallback.primitivePath !== "string" || fallback.type !== "dimension" || (typeof fallback.value !== "string" && typeof fallback.value !== "number") || typeof fallback.reason !== "string") {
      return invalid("contains an invalid layout.sectionSpacing.provisional fallback snapshot.");
    }
  }
  return value as unknown as FoundationReviewDocument;
}

async function resolveReviewFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "foundation-review.json");
}

async function readReview(input: string, root: string): Promise<{ file: string; review: FoundationReviewDocument; proposalFile: string; proposal: FoundationProposalDocument }> {
  const file = await resolveReviewFile(input, root);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_REVIEW_READ_FAILED", `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  let review: FoundationReviewDocument;
  try {
    review = validateReview(JSON.parse(raw), file);
  } catch (error) {
    if (error instanceof MigrateFoundationError) throw error;
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_REVIEW_INVALID", `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  const sourceProposal = review.source.proposal;
  if (typeof sourceProposal !== "string" || typeof review.source.proposalSha256 !== "string") {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_REVIEW_INVALID", `${file} is missing proposal provenance.`, { file });
  }
  const proposalFile = isAbsolute(sourceProposal) ? sourceProposal : resolve(dirname(file), sourceProposal);
  const loaded = await readProposal(proposalFile, root);
  const currentHash = sha256(loaded.raw);
  if (currentHash !== review.source.proposalSha256) {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_PROPOSAL_CHANGED", `Foundation proposal changed after this review was created. Regenerate or deliberately update the review before materializing.`, {
      review: file,
      proposal: proposalFile,
      expectedSha256: review.source.proposalSha256,
      actualSha256: currentHash
    });
  }
  if (review.site !== loaded.proposal.site) {
    throw new MigrateFoundationError("MIGRATE_FOUNDATION_SITE_MISMATCH", `Review site ${review.site} does not match proposal site ${loaded.proposal.site}.`, { review: file, proposal: proposalFile });
  }
  return { file, review, proposalFile, proposal: loaded.proposal };
}

function validTokenPath(path: string, layer: "primitive" | "semantic"): boolean {
  const parts = path.split(".");
  return parts.length >= 3 && parts[0] === layer && parts.slice(1).every(part => /^[a-zA-Z0-9_-]+$/.test(part));
}

function assignToken(root: Record<string, unknown>, token: MaterializedFoundationToken): void {
  const { path, type, value } = token;
  const parts = path.split(".").slice(1);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined) current[part] = {};
    else if (!isRecord(existing) || "$value" in existing) throw new MigrateFoundationError("MIGRATE_FOUNDATION_TOKEN_PATH_COLLISION", `Token path ${path} collides with another token/group.`);
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts.at(-1)!;
  if (current[leaf] !== undefined) throw new MigrateFoundationError("MIGRATE_FOUNDATION_TOKEN_PATH_COLLISION", `Duplicate canonical token path: ${path}`);
  const document: Record<string, unknown> = { $type: type, $value: value };
  if (token.provenance) {
    document.$extensions = {
      "org.sitespec.migration": token.provenance
    };
  }
  current[leaf] = document;
}

function proposalPrimitiveMap(proposal: FoundationProposalDocument): Map<string, FoundationTokenProposal> {
  return new Map(primitiveProposals(proposal).map(item => [item.path, item]));
}

function proposalSemanticMap(proposal: FoundationProposalDocument): Map<string, FoundationSemanticProposal> {
  return new Map(proposal.semantic.map(item => [item.path, item]));
}

function proposalTypographyMap(proposal: FoundationProposalDocument): Map<string, FoundationTypographyRoleProposal> {
  return new Map(proposal.typography.map(item => [item.role, item]));
}

function reviewPrimitiveMapping(review: FoundationReviewDocument, proposal: FoundationProposalDocument, blockers: string[]): { accepted: Map<string, { canonical: string; proposal: FoundationTokenProposal }>; tokens: MaterializedFoundationToken[] } {
  const bySource = proposalPrimitiveMap(proposal);
  const accepted = new Map<string, { canonical: string; proposal: FoundationTokenProposal }>();
  const canonicalPaths = new Set<string>();
  const tokens: MaterializedFoundationToken[] = [];
  for (const decision of review.decisions.primitive) {
    const source = bySource.get(decision.source);
    if (!source) {
      blockers.push(`primitive source missing: ${decision.source}`);
      continue;
    }
    if (decision.action !== "accept") continue;
    if (!validTokenPath(decision.path, "primitive")) {
      blockers.push(`invalid primitive path: ${decision.path}`);
      continue;
    }
    if (canonicalPaths.has(decision.path)) {
      blockers.push(`duplicate primitive path: ${decision.path}`);
      continue;
    }
    canonicalPaths.add(decision.path);
    accepted.set(decision.source, { canonical: decision.path, proposal: source });
    tokens.push({ path: decision.path, type: source.type, value: source.value, source: decision.source });
  }
  return { accepted, tokens };
}

function semanticAliasToken(path: string, primitiveCanonical: string, type: string, source: string): MaterializedFoundationToken {
  return { path, type, value: `{${primitiveCanonical}}`, source };
}

function provisionalTokenProvenance(source: string, reason: string): MaterializedFoundationToken["provenance"] {
  return { status: "provisional", source, reason };
}

function availablePrimitivePath(tokens: MaterializedFoundationToken[], preferred: string): string {
  if (!tokens.some(token => token.path === preferred)) return preferred;
  const parts = preferred.split(".");
  const leaf = parts.pop() ?? "value";
  const parent = parts.join(".");
  let index = 1;
  while (tokens.some(token => token.path === `${parent}.${leaf}-provisional${index === 1 ? "" : `-${index}`}`)) index += 1;
  return `${parent}.${leaf}-provisional${index === 1 ? "" : `-${index}`}`;
}

const TYPOGRAPHY_PROPERTY_NAMES: Array<[keyof FoundationTypographyRoleProposal["style"], string]> = [
  ["fontFamily", "family"],
  ["fontSize", "size"],
  ["fontWeight", "weight"],
  ["lineHeight", "lineHeight"],
  ["letterSpacing", "letterSpacing"]
];

function tokenTypeForStyleProperty(key: keyof FoundationTypographyRoleProposal["style"], primitive: FoundationTokenProposal): string {
  if (key === "fontFamily") return "fontFamily";
  if (key === "fontSize" || key === "letterSpacing") return "dimension";
  if (key === "fontWeight" || key === "lineHeight") return "number";
  return primitive.type;
}

function typographyTokenPath(role: string, property: string): string {
  const segments = role.split(".").map(segment => segment.trim()).filter(Boolean);
  return ["semantic", "font", "role", ...segments, property].join(".");
}

function buildMaterialization(review: FoundationReviewDocument, proposal: FoundationProposalDocument): {
  tokens: { primitive: MaterializedFoundationToken[]; semantic: MaterializedFoundationToken[] };
  blockers: string[];
  warnings: string[];
  typographyRoles: number;
} {
  const blockers = reviewBlockingSummary(review);
  const warnings: string[] = [];
  const primitiveResult = reviewPrimitiveMapping(review, proposal, blockers);
  const primitive = [...primitiveResult.tokens];
  const semantic: MaterializedFoundationToken[] = [];
  const canonicalSemanticPaths = new Map<string, MaterializedFoundationToken>();
  const proposalPrimitive = proposalPrimitiveMap(proposal);
  const proposalSemantic = proposalSemanticMap(proposal);
  const proposalTypography = proposalTypographyMap(proposal);

  function addSemantic(token: MaterializedFoundationToken): void {
    if (!validTokenPath(token.path, "semantic")) {
      blockers.push(`invalid semantic path: ${token.path}`);
      return;
    }
    const existing = canonicalSemanticPaths.get(token.path);
    if (existing) {
      if (existing.type === token.type && existing.value === token.value) return;
      blockers.push(`duplicate semantic path with conflicting aliases: ${token.path}`);
      return;
    }
    canonicalSemanticPaths.set(token.path, token);
    semantic.push(token);
  }

  for (const decision of review.decisions.semantic) {
    if (decision.action !== "accept") continue;
    const source = proposalSemantic.get(decision.source);
    if (!source) {
      blockers.push(`semantic source missing: ${decision.source}`);
      continue;
    }
    const target = primitiveResult.accepted.get(decision.primitive);
    if (!target) {
      blockers.push(`semantic ${decision.path} requires accepted primitive ${decision.primitive}`);
      continue;
    }
    const originalPrimitive = proposalPrimitive.get(source.primitive);
    if (originalPrimitive && originalPrimitive.type !== target.proposal.type) {
      blockers.push(`semantic ${decision.path} cannot change token type from ${originalPrimitive.type} to ${target.proposal.type}`);
      continue;
    }
    addSemantic(semanticAliasToken(decision.path, target.canonical, target.proposal.type, decision.source));
  }

  let typographyRoles = 0;
  for (const decision of review.decisions.typography) {
    if (decision.action !== "accept") continue;
    const source = proposalTypography.get(decision.sourceRole);
    if (!source) {
      blockers.push(`typography source missing: ${decision.sourceRole}`);
      continue;
    }
    let roleValid = true;
    const roleTokens: MaterializedFoundationToken[] = [];
    for (const [styleKey, property] of TYPOGRAPHY_PROPERTY_NAMES) {
      const primitiveSource = source.style[styleKey];
      if (!primitiveSource) continue;
      if (!primitiveSource.startsWith("primitive.")) {
        warnings.push(`typography ${decision.role}.${property} is not tokenized: ${primitiveSource}`);
        continue;
      }
      const target = primitiveResult.accepted.get(primitiveSource);
      if (!target) {
        blockers.push(`typography ${decision.role} requires accepted primitive ${primitiveSource}`);
        roleValid = false;
        continue;
      }
      roleTokens.push(semanticAliasToken(
        typographyTokenPath(decision.role, property),
        target.canonical,
        tokenTypeForStyleProperty(styleKey, target.proposal),
        `typography:${decision.sourceRole}`
      ));
    }
    if (!roleValid) continue;
    for (const token of roleTokens) addSemantic(token);
    typographyRoles += 1;
    if (source.style.textTransform && source.style.textTransform !== "none") {
      warnings.push(`typography ${decision.role} textTransform=${source.style.textTransform} remains role metadata because SiteSpec semantic tokens must alias primitives.`);
    }
  }

  const layout = review.decisions.layout;
  if (layout.contentWidth.action === "accept") {
    if (!layout.contentWidth.primitive) blockers.push("layout.contentWidth has no primitive selection");
    else {
      const target = primitiveResult.accepted.get(layout.contentWidth.primitive);
      if (!target) blockers.push(`layout.contentWidth requires accepted primitive ${layout.contentWidth.primitive}`);
      else if (target.proposal.type !== "dimension") blockers.push(`layout.contentWidth requires a dimension primitive, got ${target.proposal.type}`);
      else addSemantic(semanticAliasToken(layout.contentWidth.semanticPath, target.canonical, target.proposal.type, "layout.contentWidth"));
    }
  }

  if (layout.pageGutter.action === "accept") {
    if (!layout.pageGutter.value) blockers.push("layout.pageGutter has no materializable responsive value");
    else {
      if (!validTokenPath(layout.pageGutter.primitivePath, "primitive")) blockers.push(`invalid page-gutter primitive path: ${layout.pageGutter.primitivePath}`);
      else if (primitive.some(token => token.path === layout.pageGutter.primitivePath)) blockers.push(`page-gutter primitive path collides: ${layout.pageGutter.primitivePath}`);
      else {
        primitive.push({
          path: layout.pageGutter.primitivePath,
          type: layout.pageGutter.type,
          value: layout.pageGutter.value,
          source: "layout.pageGutter",
          synthesized: true
        });
        addSemantic(semanticAliasToken(layout.pageGutter.semanticPath, layout.pageGutter.primitivePath, layout.pageGutter.type, "layout.pageGutter"));
      }
    }
  }

  if (layout.sectionSpacing.action === "accept") {
    if (!layout.sectionSpacing.primitive) blockers.push("layout.sectionSpacing has no primitive selection");
    else {
      const target = primitiveResult.accepted.get(layout.sectionSpacing.primitive);
      if (!target) blockers.push(`layout.sectionSpacing requires accepted primitive ${layout.sectionSpacing.primitive}`);
      else if (target.proposal.type !== "dimension") blockers.push(`layout.sectionSpacing requires a dimension primitive, got ${target.proposal.type}`);
      else addSemantic(semanticAliasToken(layout.sectionSpacing.semanticPath, target.canonical, target.proposal.type, "layout.sectionSpacing"));
    }
  } else if (layout.sectionSpacing.action === "provisional") {
    const fallback = layout.sectionSpacing.provisional;
    if (!fallback) blockers.push("layout.sectionSpacing provisional decision is missing its fallback snapshot");
    else if (fallback.type !== "dimension") blockers.push(`layout.sectionSpacing provisional fallback must be a dimension, got ${fallback.type}`);
    else {
      let primitivePath = fallback.primitivePath;
      const collision = primitive.find(token => token.path === primitivePath);
      if (collision && (collision.type !== fallback.type || collision.value !== fallback.value)) {
        primitivePath = availablePrimitivePath(primitive, fallback.primitivePath);
      }
      if (!primitive.some(token => token.path === primitivePath)) {
        primitive.push({
          path: primitivePath,
          type: fallback.type,
          value: fallback.value,
          source: "layout.sectionSpacing:provisional",
          provisional: true,
          provenance: provisionalTokenProvenance(`${fallback.source}:${fallback.sourceFile}`, fallback.reason)
        });
      }
      addSemantic({
        ...semanticAliasToken(layout.sectionSpacing.semanticPath, primitivePath, fallback.type, "layout.sectionSpacing:provisional"),
        provisional: true,
        provenance: provisionalTokenProvenance(`${fallback.source}:${fallback.sourceFile}`, fallback.reason)
      });
      warnings.push(`layout.sectionSpacing is provisional: ${fallback.reason}`);
    }
  }

  return { tokens: { primitive, semantic }, blockers: [...new Set(blockers)].sort(), warnings: [...new Set(warnings)].sort(), typographyRoles };
}

function materializedTokenObject(tokens: { primitive: MaterializedFoundationToken[]; semantic: MaterializedFoundationToken[] }): Record<string, unknown> {
  const primitive: Record<string, unknown> = {};
  const semantic: Record<string, unknown> = {};
  for (const token of tokens.primitive.sort((a, b) => a.path.localeCompare(b.path))) assignToken(primitive, token);
  for (const token of tokens.semantic.sort((a, b) => a.path.localeCompare(b.path))) assignToken(semantic, token);
  return { primitive, semantic };
}

async function carryForwardTargetSemanticContract(
  root: string,
  review: FoundationReviewDocument,
  tokens: { primitive: MaterializedFoundationToken[]; semantic: MaterializedFoundationToken[] },
  warnings: string[]
): Promise<number> {
  let inspected: Awaited<ReturnType<typeof inspectDesign>>;
  try {
    const contract = await loadDesignSystemContract(root);
    if (!contract.designSystem) return 0;
    inspected = await inspectDesign(root);
  } catch {
    return 0;
  }

  const existingSemanticPaths = new Set(tokens.semantic.map(token => token.path));
  const existingPrimitive = new Map(tokens.primitive.map(token => [token.path, token]));
  const rejectedSemanticPaths = new Set(review.decisions.semantic.filter(item => item.action === "reject").map(item => item.path));
  const layout = review.decisions.layout;
  const disallowedLayoutPaths = new Set<string>();
  if (layout.contentWidth.action === "reject") disallowedLayoutPaths.add(layout.contentWidth.semanticPath);
  if (layout.pageGutter.action === "reject") disallowedLayoutPaths.add(layout.pageGutter.semanticPath);
  if (layout.sectionSpacing.action !== "accept" && layout.sectionSpacing.action !== "provisional") disallowedLayoutPaths.add(layout.sectionSpacing.semanticPath);

  const primitivesByPath = new Map(inspected.design.primitive.map(token => [token.path, token]));
  let carried = 0;
  const carriedNames: string[] = [];

  for (const semantic of inspected.design.semantic) {
    if (existingSemanticPaths.has(semantic.path) || rejectedSemanticPaths.has(semantic.path) || disallowedLayoutPaths.has(semantic.path)) continue;
    if (!semantic.alias) continue;
    const sourcePrimitive = primitivesByPath.get(semantic.alias);
    if (!sourcePrimitive || sourcePrimitive.type !== semantic.type) continue;

    let primitivePath = sourcePrimitive.path;
    const collision = existingPrimitive.get(primitivePath);
    if (collision && (collision.type !== sourcePrimitive.type || collision.value !== sourcePrimitive.value)) {
      primitivePath = availablePrimitivePath(tokens.primitive, primitivePath);
    }
    if (!existingPrimitive.has(primitivePath)) {
      const reason = `Preserved because the current Design System exposes ${semantic.path} and the migration review does not yet materialize a replacement for that semantic contract.`;
      const primitiveToken: MaterializedFoundationToken = {
        path: primitivePath,
        type: sourcePrimitive.type,
        value: sourcePrimitive.value,
        source: `target-semantic-contract:${sourcePrimitive.source}`,
        provisional: true,
        provenance: provisionalTokenProvenance(`target-semantic-contract:${sourcePrimitive.source}`, reason)
      };
      tokens.primitive.push(primitiveToken);
      existingPrimitive.set(primitivePath, primitiveToken);
    }

    const reason = `Preserved because the current Design System exposes ${semantic.path} and the migration review does not yet materialize a replacement for that semantic contract.`;
    tokens.semantic.push({
      path: semantic.path,
      type: semantic.type,
      value: `{${primitivePath}}`,
      source: `target-semantic-contract:${semantic.source}`,
      provisional: true,
      provenance: provisionalTokenProvenance(`target-semantic-contract:${semantic.source}`, reason)
    });
    existingSemanticPaths.add(semantic.path);
    carried += 1;
    carriedNames.push(semantic.name);
  }

  if (carried > 0) {
    const preview = carriedNames.slice(0, 8).join(", ");
    const suffix = carriedNames.length > 8 ? ` (+${carriedNames.length - 8} more)` : "";
    warnings.push(`Preserved ${carried} existing target semantic tokens provisionally so current components/shell keep their semantic API: ${preview}${suffix}.`);
  }
  return carried;
}

function layoutSemanticNames(review: FoundationReviewDocument): Record<"pageGutter" | "contentWidth" | "sectionSpacing", string> {
  const strip = (value: string): string => value.startsWith("semantic.") ? value.slice("semantic.".length) : value;
  return {
    pageGutter: strip(review.decisions.layout.pageGutter.semanticPath),
    contentWidth: strip(review.decisions.layout.contentWidth.semanticPath),
    sectionSpacing: strip(review.decisions.layout.sectionSpacing.semanticPath)
  };
}

async function projectApplyBlockers(
  root: string,
  review: FoundationReviewDocument,
  tokenObject: Record<string, unknown>,
  materializedSemantic: Map<string, MaterializedFoundationToken>
): Promise<string[]> {
  const blockers: string[] = [];
  const loaded = await loadDesignSystemContract(root);
  if (!loaded.designSystem || loaded.diagnostics.some(item => item.severity === "error")) {
    blockers.push("target project must contain a valid design-system.yaml before foundation tokens can be applied");
    return blockers;
  }
  const manifest = loaded.designSystem.value;
  const expectedLayout = layoutSemanticNames(review);
  for (const [field, name] of Object.entries(expectedLayout) as Array<[keyof typeof expectedLayout, string]>) {
    if (manifest.layout.tokens[field] !== name) blockers.push(`design-system.yaml layout.tokens.${field}=${manifest.layout.tokens[field]} does not match reviewed token ${name}`);
  }

  let currentDesign: Awaited<ReturnType<typeof inspectDesign>> | undefined;
  try {
    currentDesign = await inspectDesign(root);
    if (currentDesign.diagnostics.some(item => item.severity === "error")) {
      blockers.push("target project's current Design System must validate before canonical tokens can be replaced");
    }
  } catch (error) {
    blockers.push(`could not inspect target Design System compatibility: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (currentDesign) {
    const missingSemantic = currentDesign.design.semantic
      .map(token => token.name)
      .filter(name => !materializedSemantic.has(name))
      .sort();
    if (missingSemantic.length > 0) {
      const preview = missingSemantic.slice(0, 12).join(", ");
      const suffix = missingSemantic.length > 12 ? ` (+${missingSemantic.length - 12} more)` : "";
      blockers.push(`materialized tokens do not preserve the target semantic token contract: ${preview}${suffix}`);
    }
    const changedTypes = currentDesign.design.semantic
      .map(token => ({ current: token, next: materializedSemantic.get(token.name) }))
      .filter((pair): pair is { current: (typeof currentDesign.design.semantic)[number]; next: MaterializedFoundationToken } => !!pair.next && pair.current.type !== pair.next.type)
      .map(pair => `${pair.current.name} (${pair.current.type} -> ${pair.next.type})`)
      .sort();
    if (changedTypes.length > 0) {
      const preview = changedTypes.slice(0, 8).join(", ");
      const suffix = changedTypes.length > 8 ? ` (+${changedTypes.length - 8} more)` : "";
      blockers.push(`materialized tokens change target semantic token types: ${preview}${suffix}`);
    }
  }

  const acceptedFamilies: string[] = [];
  const primitive = tokenObject.primitive;
  if (isRecord(primitive) && isRecord(primitive.font) && isRecord(primitive.font.family)) {
    for (const value of Object.values(primitive.font.family)) {
      if (isRecord(value) && value.$type === "fontFamily" && typeof value.$value === "string") acceptedFamilies.push(value.$value.toLowerCase());
    }
  }
  if (acceptedFamilies.length > 0 && currentDesign) {
    const declared = currentDesign.design.fonts.families.map(item => item.family.toLowerCase());
    for (const stack of acceptedFamilies) {
      if (!declared.some(family => stack.includes(family))) blockers.push(`accepted font stack is not backed by design/fonts.yaml: ${stack}`);
    }
  }
  return blockers;
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.sitespec-tmp-${process.pid}`;
  await writeFile(temp, contents, "utf8");
  await rename(temp, file);
}

export async function materializeFoundationReview(options: MaterializeFoundationOptions): Promise<MaterializeFoundationResult> {
  const root = resolve(options.root ?? ".");
  const loaded = await readReview(options.review, root);
  const built = buildMaterialization(loaded.review, loaded.proposal);
  const carriedSemanticTokens = await carryForwardTargetSemanticContract(root, loaded.review, built.tokens, built.warnings);
  const tokenObject = materializedTokenObject(built.tokens);
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(loaded.file), "foundation-tokens.json");
  const blockers = [...built.blockers];
  if (options.apply) {
    const semanticTokens = new Map(built.tokens.semantic.map(token => [token.path.slice("semantic.".length), token]));
    blockers.push(...await projectApplyBlockers(root, loaded.review, tokenObject, semanticTokens));
  }
  const uniqueBlockers = [...new Set(blockers)].sort();
  const status: "ready" | "blocked" = uniqueBlockers.length === 0 ? "ready" : "blocked";
  const provisionalTokens = [...built.tokens.primitive, ...built.tokens.semantic].filter(item => item.provisional).length;
  const quality: "canonical" | "provisional" = provisionalTokens > 0 ? "provisional" : "canonical";
  const hints: string[] = [];
  if (uniqueBlockers.includes("layout.sectionSpacing")) {
    const sectionSpacing = loaded.proposal.layout.sectionSpacing;
    const rhythmSource = isRecord(loaded.proposal.source) && typeof loaded.proposal.source.sectionRhythm === "string"
      ? loaded.proposal.source.sectionRhythm
      : undefined;
    if (!rhythmSource) {
      hints.push(`Foundation proposal predates section-rhythm inference. Re-run migrate design for the representative audits, then regenerate ${basename(loaded.file)} with migrate foundation review --force.`);
    } else if (sectionSpacing?.status === "proposed" && sectionSpacing.primitive) {
      hints.push(`Section rhythm is already proposed as ${String(sectionSpacing.value ?? sectionSpacing.primitive)} (confidence ${sectionSpacing.confidence}), but the review still leaves layout.sectionSpacing unresolved. Regenerate the review with migrate foundation review ${JSON.stringify(dirname(loaded.proposalFile))} --force, then materialize again.`);
    } else {
      hints.push(`Section-rhythm analysis is unresolved. Inspect ${join(dirname(loaded.proposalFile), rhythmSource)}; materialization intentionally remains blocked until one reusable section-root rhythm is supported strongly enough or the review records an explicit decision.`);
    }
  }

  await atomicWrite(output, `${JSON.stringify(tokenObject, null, 2)}\n`);

  let applied: string | undefined;
  if (options.apply && status === "ready") {
    const contract = await loadDesignSystemContract(root);
    const target = join(root, contract.designSystem!.value.tokens.source);
    if (await exists(target) && !options.replace) {
      throw new MigrateFoundationError("MIGRATE_FOUNDATION_TOKENS_EXIST", `Canonical token source already exists: ${target}. Re-run with --replace only after reviewing the generated preview.`, { target, preview: output });
    }
    await atomicWrite(target, `${JSON.stringify(tokenObject, null, 2)}\n`);
    applied = target;
  }

  const result: MaterializeFoundationResult = {
    site: loaded.review.site,
    review: loaded.file,
    proposal: loaded.proposalFile,
    status,
    quality,
    output,
    applied,
    blockers: uniqueBlockers,
    warnings: [...new Set(built.warnings)].sort(),
    hints,
    summary: {
      primitive: built.tokens.primitive.length,
      semantic: built.tokens.semantic.length,
      typographyRoles: built.typographyRoles,
      synthesizedPrimitive: built.tokens.primitive.filter(item => item.synthesized).length,
      provisionalTokens,
      carriedSemanticTokens
    }
  };
  await atomicWrite(join(dirname(output), "foundation-materialization.json"), `${JSON.stringify({
    version: "0.2",
    type: "sitespec-migrate-foundation-materialization",
    ...result,
    review: relativeOrAbsolute(dirname(output), loaded.file),
    proposal: relativeOrAbsolute(dirname(output), loaded.proposalFile),
    output: basename(output),
    applied: applied ? slash(applied) : undefined
  }, null, 2)}\n`);
  return result;
}

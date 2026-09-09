import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { UiFamilyModel, UiFamilyProposal, UiFamilyRole, UiFamilyStatus } from "./migrate-ui.js";

export type UiReviewPolicy = "conservative" | "manual" | "all";
export type UiReviewAction = "accept" | "reject" | "pending";

interface UiFamilyProposalDocument extends UiFamilyModel {
  version: string;
  type: "sitespec-migrate-design-ui-families";
  site: string;
  source?: Record<string, unknown>;
}

export interface UiVariantReviewDecision {
  source: string;
  id: string;
  action: UiReviewAction;
  confidence: number;
  reason: string;
}

export interface UiFamilyReviewDecision {
  source: string;
  family: string;
  uiId: string;
  role: UiFamilyRole;
  status: UiFamilyStatus;
  eligibility: UiFamilyProposal["materialization"]["eligibility"];
  confidence: number;
  action: UiReviewAction;
  reason: string;
  defaultVariantSource?: string;
  variants: UiVariantReviewDecision[];
}

export interface UiReviewSummary {
  families: Record<UiReviewAction, number>;
  variants: Record<UiReviewAction, number>;
  autoEligible: number;
  reviewRequired: number;
  acceptedUiIds: string[];
}

export interface UiReviewDocument {
  version: "0.1" | "0.2";
  type: "sitespec-migrate-ui-review";
  site: string;
  source: {
    proposal: string;
    proposalSha256: string;
    proposalVersion: string;
  };
  policy: UiReviewPolicy;
  rule: string;
  decisions: {
    families: UiFamilyReviewDecision[];
  };
  unresolved: UiFamilyModel["unresolved"];
  summary: UiReviewSummary;
}

export interface CreateUiReviewOptions {
  analysis: string;
  root?: string;
  output?: string;
  policy?: UiReviewPolicy;
  force?: boolean;
}

export interface CreateUiReviewResult {
  site: string;
  proposal: string;
  output: string;
  policy: UiReviewPolicy;
  summary: UiReviewSummary;
}

export interface MaterializeUiContractsOptions {
  review: string;
  root?: string;
  output?: string;
}

export interface UiContractResult {
  site: string;
  status: "ready" | "partial" | "blocked";
  review: string;
  proposal: string;
  output: string;
  report: string;
  files: string[];
  blockers: string[];
  warnings: string[];
  summary: {
    acceptedFamilies: number;
    uiContracts: number;
    reviewRequiredAccepted: number;
    blockedFamilies: number;
  };
}

export class MigrateUiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateUiError";
    this.code = code;
    this.details = details;
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const UI_ROLES = new Set<UiFamilyRole>(["layout", "action", "content", "navigation", "feedback", "media", "typography"]);
const OUTPUT_MARKER = ".sitespec-ui-contracts.json";

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

function validateProposal(value: unknown, file: string): UiFamilyProposalDocument {
  if (
    !isRecord(value)
    || value.type !== "sitespec-migrate-design-ui-families"
    || typeof value.site !== "string"
    || !Array.isArray(value.families)
    || !Array.isArray(value.unresolved)
    || !isRecord(value.summary)
  ) {
    throw new MigrateUiError("MIGRATE_UI_PROPOSAL_INVALID", `${file} is not a SiteSpec UI-family proposal.`, { file });
  }
  for (const family of value.families) {
    if (!isRecord(family) || typeof family.id !== "string" || typeof family.suggestedUiId !== "string" || !Array.isArray(family.variants) || !isRecord(family.materialization)) {
      throw new MigrateUiError("MIGRATE_UI_PROPOSAL_INVALID", `${file} contains an invalid UI family.`, { file });
    }
  }
  return value as unknown as UiFamilyProposalDocument;
}

async function resolveProposalFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "ui-families.json");
}

async function resolveReviewFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "ui-review.json");
}

function initialAction(item: UiFamilyProposal, policy: UiReviewPolicy): UiReviewAction {
  if (policy === "manual") return "pending";
  if (policy === "all") return "accept";
  return item.status === "core" && item.materialization.eligibility === "auto" ? "accept" : "pending";
}

function variantAction(familyAction: UiReviewAction, policy: UiReviewPolicy): UiReviewAction {
  if (familyAction !== "accept") return familyAction === "reject" ? "reject" : "pending";
  if (policy === "manual") return "pending";
  return "accept";
}

function defaultVariantSource(family: UiFamilyProposal): string | undefined {
  const explicit = family.variants.find(variant => variant.id === "default");
  if (explicit) return explicit.id;
  return [...family.variants]
    .sort((a, b) => b.instances - a.instances || b.confidence - a.confidence || a.id.localeCompare(b.id))[0]?.id;
}

function countActions(items: Array<{ action: UiReviewAction }>): Record<UiReviewAction, number> {
  return {
    accept: items.filter(item => item.action === "accept").length,
    reject: items.filter(item => item.action === "reject").length,
    pending: items.filter(item => item.action === "pending").length
  };
}

function summarize(decisions: UiFamilyReviewDecision[]): UiReviewSummary {
  const variants = decisions.flatMap(item => item.variants);
  return {
    families: countActions(decisions),
    variants: countActions(variants),
    autoEligible: decisions.filter(item => item.eligibility === "auto").length,
    reviewRequired: decisions.filter(item => item.eligibility === "review-required").length,
    acceptedUiIds: decisions.filter(item => item.action === "accept").map(item => item.uiId).sort()
  };
}

export function validateUiReview(value: unknown, file = "ui-review.json"): UiReviewDocument {
  if (!isRecord(value) || value.type !== "sitespec-migrate-ui-review" || (value.version !== "0.1" && value.version !== "0.2") || typeof value.site !== "string" || !isRecord(value.source) || !isRecord(value.decisions) || !Array.isArray(value.decisions.families)) {
    throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `${file} is not a SiteSpec UI review.`, { file });
  }
  const allowedActions = new Set<UiReviewAction>(["accept", "reject", "pending"]);
  const seenIds = new Set<string>();
  for (const raw of value.decisions.families) {
    if (
      !isRecord(raw)
      || typeof raw.family !== "string"
      || typeof raw.uiId !== "string"
      || typeof raw.role !== "string"
      || !UI_ROLES.has(raw.role as UiFamilyRole)
      || typeof raw.action !== "string"
      || !allowedActions.has(raw.action as UiReviewAction)
      || !Array.isArray(raw.variants)
    ) {
      throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `${file} contains an invalid UI family decision.`, { file });
    }
    if (!ID_PATTERN.test(raw.uiId)) {
      throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `Invalid UI id "${raw.uiId}" in ${file}.`, { file, uiId: raw.uiId });
    }
    if (raw.action === "accept") {
      if (seenIds.has(raw.uiId)) {
        throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `Accepted UI id "${raw.uiId}" is duplicated in ${file}.`, { file, uiId: raw.uiId });
      }
      seenIds.add(raw.uiId);
    }
    const seenVariants = new Set<string>();
    for (const variant of raw.variants) {
      if (!isRecord(variant) || typeof variant.id !== "string" || typeof variant.action !== "string" || !allowedActions.has(variant.action as UiReviewAction)) {
        throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `${file} contains an invalid UI variant decision.`, { file, family: raw.family });
      }
      if (!ID_PATTERN.test(variant.id)) {
        throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `Invalid variant id "${variant.id}" in ${file}.`, { file, family: raw.family, variant: variant.id });
      }
      if (seenVariants.has(variant.id)) {
        throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `Variant id "${variant.id}" is duplicated for ${raw.family}.`, { file, family: raw.family, variant: variant.id });
      }
      seenVariants.add(variant.id);
    }
  }
  return value as unknown as UiReviewDocument;
}

export async function createUiReview(options: CreateUiReviewOptions): Promise<CreateUiReviewResult> {
  const root = resolve(options.root ?? ".");
  const policy = options.policy ?? "conservative";
  const proposalFile = await resolveProposalFile(options.analysis, root);
  if (!(await exists(proposalFile))) {
    throw new MigrateUiError("MIGRATE_UI_PROPOSAL_NOT_FOUND", `UI-family proposal not found: ${proposalFile}`, { proposal: proposalFile });
  }
  const raw = await readFile(proposalFile, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new MigrateUiError("MIGRATE_UI_PROPOSAL_INVALID", `Could not parse ${proposalFile}.`, { file: proposalFile });
  }
  const proposal = validateProposal(parsed, proposalFile);
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(proposalFile), "ui-review.json");
  if ((await exists(output)) && !options.force) {
    throw new MigrateUiError("MIGRATE_UI_REVIEW_EXISTS", `UI review already exists: ${output}. Use --force only when previous reviewer decisions may be replaced.`, { output });
  }

  const decisions = proposal.families.map((family): UiFamilyReviewDecision => {
    const action = initialAction(family, policy);
    const canonicalDefaultSource = defaultVariantSource(family);
    return {
      source: family.id,
      family: family.id,
      uiId: family.suggestedUiId,
      role: family.role,
      status: family.status,
      eligibility: family.materialization.eligibility,
      confidence: family.confidence,
      action,
      reason: family.materialization.reason,
      ...(canonicalDefaultSource ? { defaultVariantSource: canonicalDefaultSource } : {}),
      variants: family.variants.map(variant => {
        const canonicalId = variant.id === canonicalDefaultSource ? "default" : variant.id;
        return {
          source: variant.id,
          id: canonicalId,
          action: variantAction(action, policy),
          confidence: variant.confidence,
          reason: canonicalId === variant.id
            ? variant.reason
            : `${variant.reason} Chosen as the canonical default because it has the strongest observed reuse evidence among variants.`
        };
      })
    };
  });
  const summary = summarize(decisions);
  const document: UiReviewDocument = {
    version: "0.2",
    type: "sitespec-migrate-ui-review",
    site: proposal.site,
    source: {
      proposal: relativeOrAbsolute(dirname(output), proposalFile),
      proposalSha256: sha256(raw),
      proposalVersion: proposal.version
    },
    policy,
    rule: "Reuse status and materialization eligibility are separate decisions. Conservative review auto-accepts only core families backed by direct semantic/native element evidence. Candidate surfaces and form-control role gaps stay pending until explicitly reviewed. Every accepted UI family must expose a canonical default variant; when the source proposal has no default, the strongest observed variant is renamed to default while its source id remains in review provenance.",
    decisions: { families: decisions },
    unresolved: proposal.unresolved,
    summary
  };
  validateUiReview(document, output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { site: proposal.site, proposal: proposalFile, output, policy, summary };
}

async function prepareOutput(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length === 0) return;
    try {
      const marker = JSON.parse(await readFile(join(output, OUTPUT_MARKER), "utf8")) as { type?: string };
      if (marker.type === "sitespec-migrate-ui-contracts-output") {
        await rm(output, { recursive: true, force: true });
        return;
      }
    } catch {
      // Never remove an unowned directory implicitly.
    }
    throw new MigrateUiError("MIGRATE_UI_OUTPUT_NOT_OWNED", `UI contract output directory is not empty and is not owned by a previous migrate ui contracts run: ${output}`, { output });
  } catch (error) {
    if (error instanceof MigrateUiError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function yamlKey(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(value) ? value : JSON.stringify(value);
}

function yamlScalar(value: string | number | boolean | null): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function yamlDocument(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map(item => {
      if (item === null || typeof item !== "object") return `${pad}- ${yamlScalar(item as string | number | boolean | null)}`;
      const rendered = yamlDocument(item, indent + 2);
      const lines = rendered.split("\n");
      return `${pad}- ${lines[0]!.trimStart()}${lines.length > 1 ? `\n${lines.slice(1).join("\n")}` : ""}`;
    }).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([key, item]) => {
      if (item === null || typeof item !== "object") return `${pad}${yamlKey(key)}: ${yamlScalar(item as string | number | boolean | null)}`;
      if (Array.isArray(item) && item.length === 0) return `${pad}${yamlKey(key)}: []`;
      if (isRecord(item) && Object.keys(item).length === 0) return `${pad}${yamlKey(key)}: {}`;
      return `${pad}${yamlKey(key)}:\n${yamlDocument(item, indent + 2)}`;
    }).join("\n");
  }
  return `${pad}${yamlScalar(value as string | number | boolean | null)}`;
}

function propSchema(kind: "string" | "url" | "boolean"): Record<string, unknown> {
  if (kind === "boolean") return { type: "boolean" };
  return { type: "string", ...(kind === "url" ? { minLength: 1 } : {}) };
}

function buildUiManifest(decision: UiFamilyReviewDecision, family: UiFamilyProposal): { manifest: Record<string, unknown>; props: string[]; required: string[]; unresolved: string[] } {
  const variants = decision.variants.filter(item => item.action === "accept").map(item => item.id);
  if (variants.length === 0) {
    throw new MigrateUiError("MIGRATE_UI_VARIANT_REQUIRED", `Accepted UI family "${decision.family}" must keep at least one accepted variant.`, { family: decision.family, uiId: decision.uiId });
  }
  if (!variants.includes("default")) {
    throw new MigrateUiError("MIGRATE_UI_DEFAULT_VARIANT_REQUIRED", `Accepted UI family "${decision.family}" must map one accepted variant to canonical id "default". Re-run migrate ui review --force or edit ui-review.json explicitly.`, { family: decision.family, uiId: decision.uiId, variants });
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const hint of family.contractHints.props) {
    properties[hint.name] = propSchema(hint.kind);
    if (hint.required) required.push(hint.name);
  }
  const manifest: Record<string, unknown> = {
    specVersion: "0.5",
    ui: { id: decision.uiId, role: decision.role },
    description: `Proposed ${decision.uiId} UI primitive inferred from reviewed leaf DOM evidence.`,
    variants,
    props: {
      type: "object",
      additionalProperties: false,
      ...(required.length ? { required: [...new Set(required)].sort() } : {}),
      properties
    }
  };
  const unresolved = ["Hover/focus/active visual-state behavior is not inferred from the default-state leaf UI inventory."];
  if (family.materialization.eligibility === "review-required") {
    unresolved.push(`This family required explicit review before materialization: ${family.materialization.reason}`);
  }
  return { manifest, props: Object.keys(properties).sort(), required: [...new Set(required)].sort(), unresolved };
}

export async function materializeUiContracts(options: MaterializeUiContractsOptions): Promise<UiContractResult> {
  const root = resolve(options.root ?? ".");
  const reviewFile = await resolveReviewFile(options.review, root);
  if (!(await exists(reviewFile))) {
    throw new MigrateUiError("MIGRATE_UI_REVIEW_NOT_FOUND", `UI review not found: ${reviewFile}`, { review: reviewFile });
  }
  const reviewRaw = await readFile(reviewFile, "utf8");
  let reviewParsed: unknown;
  try { reviewParsed = JSON.parse(reviewRaw); } catch {
    throw new MigrateUiError("MIGRATE_UI_REVIEW_INVALID", `Could not parse ${reviewFile}.`, { file: reviewFile });
  }
  const review = validateUiReview(reviewParsed, reviewFile);
  const proposalFile = isAbsolute(review.source.proposal) ? review.source.proposal : resolve(dirname(reviewFile), review.source.proposal);
  if (!(await exists(proposalFile))) {
    throw new MigrateUiError("MIGRATE_UI_PROPOSAL_NOT_FOUND", `UI-family proposal referenced by the review was not found: ${proposalFile}`, { proposal: proposalFile });
  }
  const proposalRaw = await readFile(proposalFile, "utf8");
  if (sha256(proposalRaw) !== review.source.proposalSha256) {
    throw new MigrateUiError("MIGRATE_UI_REVIEW_STALE", "ui-review.json was created from a different ui-families.json. Re-run migrate ui review --force before proposing contracts.", { review: reviewFile, proposal: proposalFile });
  }
  let proposalParsed: unknown;
  try { proposalParsed = JSON.parse(proposalRaw); } catch {
    throw new MigrateUiError("MIGRATE_UI_PROPOSAL_INVALID", `Could not parse ${proposalFile}.`, { file: proposalFile });
  }
  const proposal = validateProposal(proposalParsed, proposalFile);
  const byFamily = new Map(proposal.families.map(item => [item.id, item]));
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(reviewFile), "ui-contracts");
  const report = join(dirname(output), "ui-contracts.json");
  await prepareOutput(output);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, OUTPUT_MARKER), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-ui-contracts-output" }, null, 2)}\n`, "utf8");

  const accepted = review.decisions.families.filter(item => item.action === "accept");
  const contracts: Array<Record<string, unknown>> = [];
  const files: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  let reviewRequiredAccepted = 0;

  for (const decision of accepted) {
    const family = byFamily.get(decision.source) ?? byFamily.get(decision.family);
    if (!family) {
      blockers.push(`${decision.uiId}: source family ${decision.family} is missing from ui-families.json`);
      continue;
    }
    try {
      const built = buildUiManifest(decision, family);
      const relativeFile = `${decision.uiId}/ui.yaml`;
      const file = join(output, relativeFile);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${yamlDocument(built.manifest)}\n`, "utf8");
      files.push(relativeFile);
      if (family.materialization.eligibility === "review-required") reviewRequiredAccepted += 1;
      contracts.push({
        family: decision.family,
        uiId: decision.uiId,
        role: decision.role,
        status: "proposed",
        confidence: decision.confidence,
        eligibility: family.materialization.eligibility,
        file: relativeFile,
        variants: decision.variants.filter(item => item.action === "accept").map(item => item.id),
        variantSources: decision.variants.filter(item => item.action === "accept").map(item => ({ source: item.source, id: item.id })),
        ...(decision.defaultVariantSource ? { defaultVariantSource: decision.defaultVariantSource } : {}),
        props: built.props,
        required: built.required,
        unresolved: built.unresolved,
        evidence: family.evidence
      });
    } catch (error) {
      if (error instanceof MigrateUiError) blockers.push(`${decision.uiId}: ${error.message}`);
      else throw error;
    }
  }

  if (reviewRequiredAccepted > 0) warnings.push(`${reviewRequiredAccepted} accepted UI families were materialized only because review explicitly overrode a review-required semantic boundary.`);
  if (proposal.unresolved.some(item => item.area === "interactive-states")) warnings.push("Interactive hover/focus/active state mapping remains unresolved and is not asserted in generated ui.yaml contracts.");
  const status: UiContractResult["status"] = contracts.length === 0 && blockers.length > 0 ? "blocked" : blockers.length > 0 ? "partial" : "ready";
  const document = {
    version: "0.2",
    type: "sitespec-migrate-ui-contracts",
    status,
    site: review.site,
    source: {
      review: relativeOrAbsolute(dirname(report), reviewFile),
      reviewSha256: sha256(reviewRaw),
      proposal: relativeOrAbsolute(dirname(report), proposalFile),
      proposalSha256: sha256(proposalRaw)
    },
    rule: "Generated ui.yaml files are schema-valid reviewable contracts only. Reuse strength is separate from semantic-boundary eligibility; implementations and interactive-state styling are not generated. Each materialized UI primitive has a canonical default variant, with observed source-to-canonical mappings retained in the report.",
    output: relativeOrAbsolute(dirname(report), output),
    contracts,
    blockers,
    warnings,
    summary: {
      acceptedFamilies: accepted.length,
      uiContracts: contracts.length,
      reviewRequiredAccepted,
      blockedFamilies: blockers.length
    }
  };
  await writeFile(report, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { site: review.site, status, review: reviewFile, proposal: proposalFile, output, report, files, blockers, warnings, summary: document.summary };
}

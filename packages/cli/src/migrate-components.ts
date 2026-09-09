import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ComponentFamilyLayer,
  ComponentFamilyModel,
  ComponentFamilyProposal,
  ComponentFamilyRole,
  ComponentFamilyStatus
} from "./migrate-design.js";

export type ComponentReviewPolicy = "conservative" | "manual" | "all";
export type ComponentReviewAction = "accept" | "reject" | "pending";

interface ComponentFamilyProposalDocument extends ComponentFamilyModel {
  version: string;
  type: "sitespec-migrate-design-component-families";
  site: string;
  source?: Record<string, unknown>;
}

export interface ComponentVariantReviewDecision {
  source: string;
  id: string;
  action: ComponentReviewAction;
  confidence: number;
  reason: string;
}

export interface ComponentFamilyReviewDecision {
  source: string;
  family: string;
  componentId: string;
  layer: ComponentFamilyLayer;
  role?: ComponentFamilyRole;
  status: ComponentFamilyStatus;
  confidence: number;
  action: ComponentReviewAction;
  reason: string;
  variants: ComponentVariantReviewDecision[];
}

export interface ComponentReviewSummary {
  families: Record<ComponentReviewAction, number>;
  variants: Record<ComponentReviewAction, number>;
  shell: Record<ComponentReviewAction, number>;
  section: Record<ComponentReviewAction, number>;
  acceptedComponentIds: string[];
  pendingLocalFamilies: string[];
}

export interface ComponentReviewDocument {
  version: "0.1";
  type: "sitespec-migrate-component-review";
  site: string;
  source: {
    proposal: string;
    proposalSha256: string;
    proposalVersion: string;
  };
  policy: ComponentReviewPolicy;
  rule: string;
  decisions: {
    families: ComponentFamilyReviewDecision[];
  };
  unresolved: ComponentFamilyModel["unresolved"];
  coverage: ComponentFamilyModel["coverage"];
  summary: ComponentReviewSummary;
}

export interface CreateComponentReviewOptions {
  analysis: string;
  root?: string;
  output?: string;
  policy?: ComponentReviewPolicy;
  force?: boolean;
}

export interface CreateComponentReviewResult {
  site: string;
  proposal: string;
  output: string;
  policy: ComponentReviewPolicy;
  summary: ComponentReviewSummary;
}

export interface MaterializeComponentContractsOptions {
  review: string;
  root?: string;
  output?: string;
}

export interface ComponentContractResult {
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
    sectionContracts: number;
    shellDeferred: number;
    blockedFamilies: number;
  };
}

export class MigrateComponentsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateComponentsError";
    this.code = code;
    this.details = details;
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

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
  const value = relative(from, to);
  return value && !value.startsWith("..") && !isAbsolute(value) ? slash(value) : slash(to);
}

function validateProposal(value: unknown, file: string): ComponentFamilyProposalDocument {
  if (
    !isRecord(value)
    || value.type !== "sitespec-migrate-design-component-families"
    || typeof value.site !== "string"
    || !Array.isArray(value.families)
    || !Array.isArray(value.unresolved)
    || !isRecord(value.coverage)
    || !isRecord(value.summary)
  ) {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_PROPOSAL_INVALID", `${file} is not a SiteSpec component-family proposal.`, { file });
  }
  for (const family of value.families) {
    if (!isRecord(family) || typeof family.id !== "string" || typeof family.suggestedComponentId !== "string" || !Array.isArray(family.variants)) {
      throw new MigrateComponentsError("MIGRATE_COMPONENTS_PROPOSAL_INVALID", `${file} contains an invalid component family.`, { file });
    }
  }
  return value as unknown as ComponentFamilyProposalDocument;
}

async function resolveProposalFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "component-families.json");
}

function initialAction(item: ComponentFamilyProposal, policy: ComponentReviewPolicy): ComponentReviewAction {
  if (policy === "manual") return "pending";
  if (policy === "all") return "accept";
  return item.status === "core" ? "accept" : "pending";
}

function variantAction(familyAction: ComponentReviewAction, policy: ComponentReviewPolicy): ComponentReviewAction {
  if (familyAction !== "accept") return familyAction === "reject" ? "reject" : "pending";
  if (policy === "manual") return "pending";
  return "accept";
}

function countActions(items: Array<{ action: ComponentReviewAction }>): Record<ComponentReviewAction, number> {
  return {
    accept: items.filter(item => item.action === "accept").length,
    reject: items.filter(item => item.action === "reject").length,
    pending: items.filter(item => item.action === "pending").length
  };
}

function summarize(decisions: ComponentFamilyReviewDecision[]): ComponentReviewSummary {
  const variants = decisions.flatMap(item => item.variants);
  return {
    families: countActions(decisions),
    variants: countActions(variants),
    shell: countActions(decisions.filter(item => item.layer === "shell")),
    section: countActions(decisions.filter(item => item.layer === "section")),
    acceptedComponentIds: decisions.filter(item => item.action === "accept").map(item => item.componentId).sort(),
    pendingLocalFamilies: decisions.filter(item => item.action === "pending" && item.status === "local").map(item => item.family).sort()
  };
}

export function validateComponentReview(value: unknown, file = "component-review.json"): ComponentReviewDocument {
  if (!isRecord(value) || value.type !== "sitespec-migrate-component-review" || value.version !== "0.1" || typeof value.site !== "string" || !isRecord(value.source) || !isRecord(value.decisions) || !Array.isArray(value.decisions.families)) {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `${file} is not a SiteSpec component review.`, { file });
  }
  const allowedActions = new Set<ComponentReviewAction>(["accept", "reject", "pending"]);
  const seenIds = new Set<string>();
  for (const raw of value.decisions.families) {
    if (!isRecord(raw) || typeof raw.family !== "string" || typeof raw.componentId !== "string" || typeof raw.action !== "string" || !allowedActions.has(raw.action as ComponentReviewAction) || !Array.isArray(raw.variants)) {
      throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `${file} contains an invalid family decision.`, { file });
    }
    if (!ID_PATTERN.test(raw.componentId)) {
      throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `Invalid component id "${raw.componentId}" in ${file}.`, { file, componentId: raw.componentId });
    }
    if (raw.action === "accept") {
      if (seenIds.has(raw.componentId)) {
        throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `Accepted component id "${raw.componentId}" is duplicated in ${file}.`, { file, componentId: raw.componentId });
      }
      seenIds.add(raw.componentId);
    }
    const seenVariants = new Set<string>();
    for (const variant of raw.variants) {
      if (!isRecord(variant) || typeof variant.id !== "string" || typeof variant.action !== "string" || !allowedActions.has(variant.action as ComponentReviewAction)) {
        throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `${file} contains an invalid variant decision.`, { file, family: raw.family });
      }
      if (!ID_PATTERN.test(variant.id)) {
        throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `Invalid variant id "${variant.id}" in ${file}.`, { file, family: raw.family, variant: variant.id });
      }
      if (seenVariants.has(variant.id)) {
        throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `Variant id "${variant.id}" is duplicated for ${raw.family}.`, { file, family: raw.family, variant: variant.id });
      }
      seenVariants.add(variant.id);
    }
  }
  return value as unknown as ComponentReviewDocument;
}

export async function createComponentReview(options: CreateComponentReviewOptions): Promise<CreateComponentReviewResult> {
  const root = resolve(options.root ?? ".");
  const policy = options.policy ?? "conservative";
  const proposalFile = await resolveProposalFile(options.analysis, root);
  if (!(await exists(proposalFile))) {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_PROPOSAL_NOT_FOUND", `Component-family proposal not found: ${proposalFile}`, { proposal: proposalFile });
  }
  const raw = await readFile(proposalFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_PROPOSAL_INVALID", `Could not parse ${proposalFile}.`, { file: proposalFile });
  }
  const proposal = validateProposal(parsed, proposalFile);
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(proposalFile), "component-review.json");
  if ((await exists(output)) && !options.force) {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_EXISTS", `Component review already exists: ${output}. Use --force only when previous reviewer decisions may be replaced.`, { output });
  }

  const decisions = proposal.families.map((family): ComponentFamilyReviewDecision => {
    const action = initialAction(family, policy);
    return {
      source: family.id,
      family: family.id,
      componentId: family.suggestedComponentId,
      layer: family.layer,
      role: family.role,
      status: family.status,
      confidence: family.confidence,
      action,
      reason: family.reason,
      variants: family.variants.map(variant => ({
        source: variant.id,
        id: variant.id,
        action: variantAction(action, policy),
        confidence: variant.confidence,
        reason: variant.reason
      }))
    };
  });
  const summary = summarize(decisions);
  const document: ComponentReviewDocument = {
    version: "0.1",
    type: "sitespec-migrate-component-review",
    site: proposal.site,
    source: {
      proposal: relativeOrAbsolute(dirname(output), proposalFile),
      proposalSha256: sha256(raw),
      proposalVersion: proposal.version
    },
    policy,
    rule: "Accepting a component family records an architecture decision only. It does not generate component source. Core families are accepted by the conservative policy; supporting/local families stay pending until additional reuse evidence or explicit reviewer intent justifies promotion. componentId and variant ids are reviewer-editable canonical names.",
    decisions: { families: decisions },
    unresolved: proposal.unresolved,
    coverage: proposal.coverage,
    summary
  };
  validateComponentReview(document, output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { site: proposal.site, proposal: proposalFile, output, policy, summary };
}

async function resolveReviewFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "component-review.json");
}

const CONTRACT_OUTPUT_MARKER = ".sitespec-component-contracts.json";

async function prepareComponentContractOutput(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length === 0) return;
    try {
      const marker = JSON.parse(await readFile(join(output, CONTRACT_OUTPUT_MARKER), "utf8")) as { type?: string };
      if (marker.type === "sitespec-migrate-component-contracts-output") {
        await rm(output, { recursive: true, force: true });
        return;
      }
    } catch {
      // A non-owned directory is never removed implicitly.
    }
    throw new MigrateComponentsError(
      "MIGRATE_COMPONENTS_OUTPUT_NOT_OWNED",
      `Component contract output directory is not empty and is not owned by a previous migrate components contracts run: ${output}`,
      { output }
    );
  } catch (error) {
    if (error instanceof MigrateComponentsError) throw error;
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

function propSchemaForHint(family: ComponentFamilyProposal, hint: ComponentFamilyProposal["contractHints"]["props"][number]): Record<string, unknown> {
  if (hint.kind === "string") return { type: "string" };
  if (hint.kind === "action") return { $ref: "urn:site-spec:0.5:type:action" };
  if (hint.kind === "media") return { $ref: "urn:site-spec:0.5:type:image" };
  if (hint.kind === "navigation") return { $ref: "urn:site-spec:0.5:type:navigation" };
  if (hint.kind === "items") return { type: "array", items: { type: "object", additionalProperties: true } };
  if (hint.kind === "form") return { type: "object", additionalProperties: true };
  return { type: "object", additionalProperties: true };
}

function requiredProp(family: ComponentFamilyProposal, hint: ComponentFamilyProposal["contractHints"]["props"][number]): boolean {
  if (hint.requiredRecommendation) return hint.requiredRecommendation === "required";
  const content = family.evidence.observedContent;
  if (hint.name === "title") return content.headings.min >= 1;
  if (hint.kind === "form") return content.forms.min >= 1;
  if (hint.kind === "media") return content.images.min >= 1;
  if (hint.kind === "action") return content.buttons.min >= 1;
  if (hint.kind === "items") return content.lists.min >= 1;
  if (hint.kind === "navigation") return content.links.min >= 1;
  return false;
}

function buildComponentManifest(
  decision: ComponentFamilyReviewDecision,
  family: ComponentFamilyProposal
): { manifest: Record<string, unknown>; props: string[]; required: string[]; unresolved: string[] } {
  const variants = decision.variants.filter(item => item.action === "accept").map(item => item.id);
  if (!variants.includes("default")) {
    throw new MigrateComponentsError(
      "MIGRATE_COMPONENTS_DEFAULT_VARIANT_REQUIRED",
      `Accepted section family "${decision.family}" must keep an accepted default variant before a valid component.yaml can be proposed.`,
      { family: decision.family, componentId: decision.componentId, variants }
    );
  }
  const role = decision.role ?? family.role;
  if (!role) {
    throw new MigrateComponentsError(
      "MIGRATE_COMPONENTS_ROLE_REQUIRED",
      `Accepted section family "${decision.family}" has no SiteSpec component role.`,
      { family: decision.family, componentId: decision.componentId }
    );
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const hint of family.contractHints.props) {
    properties[hint.name] = propSchemaForHint(family, hint);
    if (requiredProp(family, hint)) required.push(hint.name);
  }
  const props: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    ...(required.length ? { required: [...new Set(required)].sort() } : {}),
    properties
  };
  const rules = {
    ...(family.contractHints.maxPerPage ? { maxPerPage: family.contractHints.maxPerPage } : {}),
    ...(family.contractHints.placement ? { placement: family.contractHints.placement } : {})
  };
  const semantics = family.contractHints.pageHeading ? { pageHeading: true } : undefined;
  const manifest: Record<string, unknown> = {
    specVersion: "0.5",
    component: { id: decision.componentId, role },
    description: `Proposed ${decision.componentId} section contract inferred from reviewed migration evidence.`,
    variants,
    props,
    ...(Object.keys(rules).length ? { rules } : {}),
    ...(semantics ? { semantics } : {})
  };
  const unresolved = [
    "runtime.javascript is not inferred from static/default-state migration evidence.",
    "Theme vocabulary is not inferred yet; SiteSpec default-theme behavior remains implicit rather than being asserted as migration evidence."
  ];
  if (family.contractHints.props.some(item => item.kind === "items" || item.kind === "form")) {
    unresolved.push("Collection/form prop item schemas remain intentionally generic until repeated content shape evidence is captured.");
  }
  return { manifest, props: Object.keys(properties).sort(), required: [...new Set(required)].sort(), unresolved };
}

export async function materializeComponentContracts(options: MaterializeComponentContractsOptions): Promise<ComponentContractResult> {
  const root = resolve(options.root ?? ".");
  const reviewFile = await resolveReviewFile(options.review, root);
  if (!(await exists(reviewFile))) {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_NOT_FOUND", `Component review not found: ${reviewFile}`, { review: reviewFile });
  }
  const reviewRaw = await readFile(reviewFile, "utf8");
  let reviewParsed: unknown;
  try { reviewParsed = JSON.parse(reviewRaw); } catch {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_REVIEW_INVALID", `Could not parse ${reviewFile}.`, { file: reviewFile });
  }
  const review = validateComponentReview(reviewParsed, reviewFile);
  const proposalRef = review.source.proposal;
  const proposalFile = isAbsolute(proposalRef) ? proposalRef : resolve(dirname(reviewFile), proposalRef);
  if (!(await exists(proposalFile))) {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_PROPOSAL_NOT_FOUND", `Component-family proposal referenced by the review was not found: ${proposalFile}`, { proposal: proposalFile });
  }
  const proposalRaw = await readFile(proposalFile, "utf8");
  if (sha256(proposalRaw) !== review.source.proposalSha256) {
    throw new MigrateComponentsError(
      "MIGRATE_COMPONENTS_REVIEW_STALE",
      "component-review.json was created from a different component-families.json. Re-run migrate components review --force before proposing contracts.",
      { review: reviewFile, proposal: proposalFile }
    );
  }
  let proposalParsed: unknown;
  try { proposalParsed = JSON.parse(proposalRaw); } catch {
    throw new MigrateComponentsError("MIGRATE_COMPONENTS_PROPOSAL_INVALID", `Could not parse ${proposalFile}.`, { file: proposalFile });
  }
  const proposal = validateProposal(proposalParsed, proposalFile);
  const byFamily = new Map(proposal.families.map(item => [item.id, item]));
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(reviewFile), "component-contracts");
  const report = join(dirname(output), "component-contracts.json");
  await prepareComponentContractOutput(output);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, CONTRACT_OUTPUT_MARKER), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-component-contracts-output" }, null, 2)}\n`, "utf8");

  const accepted = review.decisions.families.filter(item => item.action === "accept");
  const contracts: Array<Record<string, unknown>> = [];
  const shells: Array<Record<string, unknown>> = [];
  const files: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const decision of accepted) {
    const family = byFamily.get(decision.source) ?? byFamily.get(decision.family);
    if (!family) {
      blockers.push(`${decision.componentId}: source family ${decision.family} is missing from component-families.json`);
      continue;
    }
    if (decision.layer === "shell") {
      shells.push({
        family: decision.family,
        id: decision.componentId,
        status: "deferred",
        confidence: decision.confidence,
        reason: "SiteSpec shell families are materialized through design-system.yaml shell packs and Astro shell entries, not components/*/component.yaml."
      });
      continue;
    }
    try {
      const built = buildComponentManifest(decision, family);
      const relativeFile = `${decision.componentId}/component.yaml`;
      const file = join(output, relativeFile);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${yamlDocument(built.manifest)}\n`, "utf8");
      files.push(relativeFile);
      contracts.push({
        family: decision.family,
        componentId: decision.componentId,
        role: decision.role ?? family.role,
        status: "proposed",
        confidence: decision.confidence,
        file: relativeFile,
        variants: decision.variants.filter(item => item.action === "accept").map(item => item.id),
        props: built.props,
        required: built.required,
        propEvidence: family.contractHints.props.map(item => ({
          name: item.name,
          kind: item.kind,
          confidence: item.confidence,
          presenceRatio: item.presenceRatio,
          variantCoverage: item.variantCoverage,
          requiredRecommendation: item.requiredRecommendation
        })),
        unresolved: built.unresolved,
        evidence: {
          instances: family.evidence.instances,
          pages: family.evidence.pages,
          clusters: family.evidence.clusters,
          members: family.members.map(item => ({ page: item.page, auditId: item.auditId, label: item.label, variant: item.variant, screenshot: item.screenshot }))
        }
      });
    } catch (error) {
      if (error instanceof MigrateComponentsError) blockers.push(`${decision.componentId}: ${error.message}`);
      else throw error;
    }
  }

  if (shells.length) warnings.push(`${shells.length} accepted shell families are deferred to the shell-pack stage; component.yaml is intentionally not generated for them.`);
  const status: ComponentContractResult["status"] = contracts.length === 0 && blockers.length > 0 ? "blocked" : blockers.length > 0 ? "partial" : "ready";
  const document = {
    version: "0.1",
    type: "sitespec-migrate-component-contracts",
    status,
    site: review.site,
    source: {
      review: relativeOrAbsolute(dirname(report), reviewFile),
      reviewSha256: sha256(reviewRaw),
      proposal: relativeOrAbsolute(dirname(report), proposalFile),
      proposalSha256: sha256(proposalRaw)
    },
    rule: "Generated component.yaml files are reviewable contract proposals only. They contain schema-valid section contracts for accepted section families; source implementations are not generated and shell families remain in the shell layer.",
    output: relativeOrAbsolute(dirname(report), output),
    contracts,
    shell: shells,
    blockers,
    warnings,
    summary: {
      acceptedFamilies: accepted.length,
      sectionContracts: contracts.length,
      shellDeferred: shells.length,
      blockedFamilies: blockers.length
    }
  };
  await writeFile(report, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return {
    site: review.site,
    status,
    review: reviewFile,
    proposal: proposalFile,
    output,
    report,
    files,
    blockers,
    warnings,
    summary: document.summary
  };
}

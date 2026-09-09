import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validateDesign } from "@sitespec/core";
import { validateComponentReview, type ComponentReviewDocument } from "./migrate-components.js";
import type { ComponentFamilyModel, ComponentFamilyProposal } from "./migrate-design.js";

export interface MaterializeShellContractsOptions {
  review: string;
  root?: string;
  output?: string;
}

export interface ShellContractResult {
  site: string;
  status: "ready" | "partial" | "blocked";
  review: string;
  proposal: string;
  output: string;
  blockers: string[];
  warnings: string[];
  summary: {
    acceptedShellFamilies: number;
    packs: number;
    headerRegions: number;
    footerRegions: number;
    otherRegions: number;
  };
}

export interface MaterializeDesignSystemStagingOptions {
  analysis: string;
  root?: string;
  output?: string;
  id?: string;
  name?: string;
  version?: string;
}

export interface DesignSystemStagingResult {
  site: string;
  status: "ready" | "partial" | "blocked";
  phase: "contract-staging" | "implementation-staging";
  output: string;
  report: string;
  files: string[];
  blockers: string[];
  warnings: string[];
  summary: {
    primitiveTokens?: number;
    semanticTokens?: number;
    provisionalTokens?: number;
    uiContracts: number;
    sectionContracts: number;
    shellPacks: number;
    implementationBlockers: number;
    fontBlockers: number;
  };
}

export class MigrateDesignSystemError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MigrateDesignSystemError";
    this.code = code;
    this.details = details;
  }
}

interface ComponentProposalDocument extends ComponentFamilyModel {
  version: string;
  type: "sitespec-migrate-design-component-families";
  site: string;
}

interface ContractReport {
  type: string;
  version: string;
  status: string;
  site: string;
  source?: {
    review?: string;
    reviewSha256?: string;
  };
  output?: string;
  contracts?: Array<Record<string, unknown>>;
  shell?: Array<Record<string, unknown>>;
  blockers?: string[];
  warnings?: string[];
  summary?: Record<string, unknown>;
}


interface ImplementationInferenceReport {
  version: string;
  type: "sitespec-migrate-implementation-inference";
  status: string;
  phase: "implementation-inference";
  site: string;
  source: {
    foundation: string; foundationSha256: string;
    components: string; componentsSha256: string;
    ui: string; uiSha256: string;
    shell: string; shellSha256: string;
    designReport?: string; designReportSha256?: string;
    evidenceSources?: Array<{ file: string; sha256: string }>;
  };
  output: string;
  files: string[];
  blockers?: string[];
  warnings?: string[];
  summary?: Record<string, unknown>;
}

interface FoundationMaterializationReport {
  type: "sitespec-migrate-foundation-materialization";
  version: string;
  site: string;
  status: string;
  quality?: string;
  review: string;
  proposal: string;
  output: string;
  blockers?: string[];
  warnings?: string[];
  summary?: {
    primitive?: number;
    semantic?: number;
    typographyRoles?: number;
    synthesizedPrimitive?: number;
    provisionalTokens?: number;
    carriedSemanticTokens?: number;
  };
}

interface ShellContractDocument {
  version: "0.1";
  type: "sitespec-migrate-shell-contracts";
  status: "ready" | "partial" | "blocked";
  site: string;
  source: {
    review: string;
    reviewSha256: string;
    proposal: string;
    proposalSha256: string;
  };
  rule: string;
  packs: Array<{
    id: string;
    status: "proposed";
    entry: string;
    files: string[];
    regions: Array<{
      family: string;
      id: string;
      region: "header" | "footer" | "other";
      file: string;
      confidence: number;
      pages: string[];
      instances: number;
      variants: string[];
    }>;
    unresolved: string[];
  }>;
  blockers: string[];
  warnings: string[];
  summary: ShellContractResult["summary"];
}

const STAGING_MARKER = ".sitespec-design-system-staging.json";
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

function validateComponentProposal(value: unknown, file: string): ComponentProposalDocument {
  if (!isRecord(value) || value.type !== "sitespec-migrate-design-component-families" || typeof value.site !== "string" || !Array.isArray(value.families)) {
    throw new MigrateDesignSystemError("MIGRATE_SHELL_PROPOSAL_INVALID", `${file} is not a SiteSpec component-family proposal.`, { file });
  }
  return value as unknown as ComponentProposalDocument;
}

async function resolveReviewFile(input: string, root: string): Promise<string> {
  const resolved = isAbsolute(input) ? input : resolve(root, input);
  if (basename(resolved).endsWith(".json")) return resolved;
  return join(resolved, "component-review.json");
}

function shellRegion(family: string, id: string): "header" | "footer" | "other" {
  const value = `${family} ${id}`.toLowerCase();
  if (value.includes("header")) return "header";
  if (value.includes("footer")) return "footer";
  return "other";
}

function shellFile(region: "header" | "footer" | "other", id: string): string {
  if (region === "header") return "shell/Header.astro";
  if (region === "footer") return "shell/Footer.astro";
  return `shell/${id.replace(/(^|-)([a-z])/g, (_match, _prefix: string, letter: string) => letter.toUpperCase())}.astro`;
}

export async function materializeShellContracts(options: MaterializeShellContractsOptions): Promise<ShellContractResult> {
  const root = resolve(options.root ?? ".");
  const reviewFile = await resolveReviewFile(options.review, root);
  if (!(await exists(reviewFile))) {
    throw new MigrateDesignSystemError("MIGRATE_SHELL_REVIEW_NOT_FOUND", `Component review not found: ${reviewFile}`, { review: reviewFile });
  }
  const reviewRaw = await readFile(reviewFile, "utf8");
  let reviewParsed: unknown;
  try { reviewParsed = JSON.parse(reviewRaw); } catch {
    throw new MigrateDesignSystemError("MIGRATE_SHELL_REVIEW_INVALID", `Could not parse ${reviewFile}.`, { file: reviewFile });
  }
  const review: ComponentReviewDocument = validateComponentReview(reviewParsed, reviewFile);
  const proposalFile = isAbsolute(review.source.proposal) ? review.source.proposal : resolve(dirname(reviewFile), review.source.proposal);
  if (!(await exists(proposalFile))) {
    throw new MigrateDesignSystemError("MIGRATE_SHELL_PROPOSAL_NOT_FOUND", `Component-family proposal referenced by the review was not found: ${proposalFile}`, { proposal: proposalFile });
  }
  const proposalRaw = await readFile(proposalFile, "utf8");
  if (sha256(proposalRaw) !== review.source.proposalSha256) {
    throw new MigrateDesignSystemError("MIGRATE_SHELL_REVIEW_STALE", "component-review.json was created from a different component-families.json. Re-run migrate components review --force before proposing shell contracts.", { review: reviewFile, proposal: proposalFile });
  }
  let proposalParsed: unknown;
  try { proposalParsed = JSON.parse(proposalRaw); } catch {
    throw new MigrateDesignSystemError("MIGRATE_SHELL_PROPOSAL_INVALID", `Could not parse ${proposalFile}.`, { file: proposalFile });
  }
  const proposal = validateComponentProposal(proposalParsed, proposalFile);
  const byFamily = new Map(proposal.families.map(item => [item.id, item]));
  const accepted = review.decisions.families.filter(item => item.action === "accept" && item.layer === "shell");
  const blockers: string[] = [];
  const warnings: string[] = [];
  const regions: ShellContractDocument["packs"][number]["regions"] = [];

  for (const decision of accepted) {
    const family: ComponentFamilyProposal | undefined = byFamily.get(decision.source) ?? byFamily.get(decision.family);
    if (!family) {
      blockers.push(`${decision.componentId}: source shell family ${decision.family} is missing from component-families.json`);
      continue;
    }
    const region = shellRegion(decision.family, decision.componentId);
    regions.push({
      family: decision.family,
      id: decision.componentId,
      region,
      file: shellFile(region, decision.componentId),
      confidence: decision.confidence,
      pages: family.evidence.pages,
      instances: family.evidence.instances,
      variants: decision.variants.filter(item => item.action === "accept").map(item => item.id)
    });
  }

  const headerRegions = regions.filter(item => item.region === "header").length;
  const footerRegions = regions.filter(item => item.region === "footer").length;
  const otherRegions = regions.filter(item => item.region === "other").length;
  if (accepted.length === 0) blockers.push("No accepted shell family is available for a SiteSpec shell pack.");
  if (headerRegions === 0) warnings.push("No accepted header family was identified; the default shell contract is incomplete until header architecture is reviewed.");
  if (footerRegions === 0) warnings.push("No accepted footer family was identified; the default shell contract is incomplete until footer architecture is reviewed.");
  if (otherRegions > 0) warnings.push(`${otherRegions} accepted shell regions could not be classified as header/footer and remain generic shell-region contracts.`);

  const files = ["shell/default.astro", ...regions.map(item => item.file)].filter((value, index, all) => all.indexOf(value) === index);
  const packs: ShellContractDocument["packs"] = accepted.length > 0 ? [{
    id: "default",
    status: "proposed",
    entry: "shell/default.astro",
    files,
    regions,
    unresolved: [
      "Astro shell implementations are not inferred from static contract evidence yet.",
      "Responsive navigation interactions, sticky behavior, and menu open/close state remain implementation evidence rather than shell-contract facts.",
      "The shell entry must render <slot /> and wire accepted header/footer regions once implementation inference is complete."
    ]
  }] : [];
  const summary: ShellContractResult["summary"] = {
    acceptedShellFamilies: accepted.length,
    packs: packs.length,
    headerRegions,
    footerRegions,
    otherRegions
  };
  const status: ShellContractResult["status"] = packs.length === 0 ? "blocked" : blockers.length > 0 || headerRegions === 0 || footerRegions === 0 ? "partial" : "ready";
  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(dirname(reviewFile), "shell-contracts.json");
  const document: ShellContractDocument = {
    version: "0.1",
    type: "sitespec-migrate-shell-contracts",
    status,
    site: review.site,
    source: {
      review: relativeOrAbsolute(dirname(output), reviewFile),
      reviewSha256: sha256(reviewRaw),
      proposal: relativeOrAbsolute(dirname(output), proposalFile),
      proposalSha256: sha256(proposalRaw)
    },
    rule: "Accepted shell families define shell-pack architecture only. Shell contracts name expected Astro entry/files and preserve evidence; they do not fabricate Header/Footer/default.astro implementations.",
    packs,
    blockers,
    warnings,
    summary
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { site: review.site, status, review: reviewFile, proposal: proposalFile, output, blockers, warnings, summary };
}

function parseJson<T>(raw: string, file: string, code: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new MigrateDesignSystemError(code, `Could not parse ${file}.`, { file }); }
}

function slugifySite(site: string): string {
  const base = site.replace(/^www\./, "").split(".")[0] ?? "migrated-design-system";
  const id = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  return ID_PATTERN.test(id) ? id : "migrated-design-system";
}

function contractOutputDir(reportFile: string, report: ContractReport): string {
  if (!report.output) return dirname(reportFile);
  return isAbsolute(report.output) ? report.output : resolve(dirname(reportFile), report.output);
}

async function assertReportReviewCurrent(reportFile: string, report: ContractReport, code: string): Promise<void> {
  const source = report.source;
  if (!source?.review || !source.reviewSha256) return;
  const reviewFile = isAbsolute(source.review) ? source.review : resolve(dirname(reportFile), source.review);
  if (!(await exists(reviewFile))) throw new MigrateDesignSystemError(code, `Review referenced by ${reportFile} was not found: ${reviewFile}`, { report: reportFile, review: reviewFile });
  const raw = await readFile(reviewFile, "utf8");
  if (sha256(raw) !== source.reviewSha256) {
    throw new MigrateDesignSystemError(code, `${basename(reportFile)} was created from an older review. Re-run its contract materialization before staging the Design System.`, { report: reportFile, review: reviewFile });
  }
}

async function prepareStagingOutput(output: string): Promise<void> {
  try {
    const entries = await readdir(output);
    if (entries.length === 0) return;
    try {
      const marker = parseJson<{ type?: string }>(await readFile(join(output, STAGING_MARKER), "utf8"), join(output, STAGING_MARKER), "MIGRATE_DESIGN_SYSTEM_OUTPUT_NOT_OWNED");
      if (marker.type === "sitespec-migrate-design-system-staging-output") {
        await rm(output, { recursive: true, force: true });
        return;
      }
    } catch (error) {
      if (error instanceof MigrateDesignSystemError && error.code !== "MIGRATE_DESIGN_SYSTEM_OUTPUT_NOT_OWNED") throw error;
    }
    throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_OUTPUT_NOT_OWNED", `Design System staging directory is not empty and is not owned by a previous migration staging run: ${output}`, { output });
  } catch (error) {
    if (error instanceof MigrateDesignSystemError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function copyTracked(source: string, target: string, output: string, files: string[]): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  files.push(slash(relative(output, target)));
}

function numericSummary(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function fontFamiliesFromTokens(raw: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (!isRecord(value)) return;
    if (value.$type === "fontFamily" && typeof value.$value === "string" && !/^\{[^}]+\}$/.test(value.$value)) {
      const family = value.$value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
      if (family) found.push(family);
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  if (isRecord(parsed) && isRecord(parsed.primitive)) walk(parsed.primitive);
  return [...new Set(found)];
}


async function assertImplementationSourceCurrent(reportFile: string, sourcePath: string, expectedSha: string, code: string): Promise<void> {
  const file = isAbsolute(sourcePath) ? sourcePath : resolve(dirname(reportFile), sourcePath);
  if (!(await exists(file))) throw new MigrateDesignSystemError(code, `Implementation inference source is missing: ${file}`, { report: reportFile, file });
  const raw = await readFile(file, "utf8");
  if (sha256(raw) !== expectedSha) throw new MigrateDesignSystemError(code, `implementation-inference.json is stale because ${basename(file)} changed. Re-run migrate implementations infer.`, { report: reportFile, file });
}

export async function materializeDesignSystemStaging(options: MaterializeDesignSystemStagingOptions): Promise<DesignSystemStagingResult> {
  const root = resolve(options.root ?? ".");
  const analysis = isAbsolute(options.analysis) ? options.analysis : resolve(root, options.analysis);
  const foundationReportFile = join(analysis, "foundation-materialization.json");
  const componentReportFile = join(analysis, "component-contracts.json");
  const uiReportFile = join(analysis, "ui-contracts.json");
  const shellReportFile = join(analysis, "shell-contracts.json");
  const implementationReportFile = join(analysis, "implementation-inference.json");
  const requiredReports = [foundationReportFile, componentReportFile, uiReportFile, shellReportFile];
  const missingReports: string[] = [];
  for (const file of requiredReports) if (!(await exists(file))) missingReports.push(file);
  if (missingReports.length > 0) {
    const next: string[] = [];
    if (missingReports.includes(foundationReportFile)) next.push(`npm run site -- migrate foundation review ${JSON.stringify(analysis)} --force`, `npm run site -- migrate foundation materialize ${JSON.stringify(join(analysis, "foundation-review.json"))}`);
    if (missingReports.includes(componentReportFile)) next.push(`npm run site -- migrate components review ${JSON.stringify(analysis)} --force`, `npm run site -- migrate components contracts ${JSON.stringify(join(analysis, "component-review.json"))}`);
    if (missingReports.includes(uiReportFile)) next.push(`npm run site -- migrate ui review ${JSON.stringify(analysis)} --force`, `npm run site -- migrate ui contracts ${JSON.stringify(join(analysis, "ui-review.json"))}`);
    if (missingReports.includes(shellReportFile)) next.push(`npm run site -- migrate shell contracts ${JSON.stringify(join(analysis, "component-review.json"))}`);
    throw new MigrateDesignSystemError(
      "MIGRATE_DESIGN_SYSTEM_INPUT_MISSING",
      `Design System materialization requires current reviewed migration artifacts. Missing:\n${missingReports.map(file => `  - ${file}`).join("\n")}${next.length ? `\nNext:\n${[...new Set(next)].map(command => `  ${command}`).join("\n")}` : ""}`,
      { missing: missingReports, next: [...new Set(next)] }
    );
  }

  const foundationReport = parseJson<FoundationMaterializationReport>(await readFile(foundationReportFile, "utf8"), foundationReportFile, "MIGRATE_DESIGN_SYSTEM_FOUNDATION_INVALID");
  const componentReport = parseJson<ContractReport>(await readFile(componentReportFile, "utf8"), componentReportFile, "MIGRATE_DESIGN_SYSTEM_COMPONENTS_INVALID");
  const uiReport = parseJson<ContractReport>(await readFile(uiReportFile, "utf8"), uiReportFile, "MIGRATE_DESIGN_SYSTEM_UI_INVALID");
  const shellReport = parseJson<ShellContractDocument>(await readFile(shellReportFile, "utf8"), shellReportFile, "MIGRATE_DESIGN_SYSTEM_SHELL_INVALID");
  const implementationReport = await exists(implementationReportFile)
    ? parseJson<ImplementationInferenceReport>(await readFile(implementationReportFile, "utf8"), implementationReportFile, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_INVALID")
    : undefined;
  if (foundationReport.type !== "sitespec-migrate-foundation-materialization") throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_FOUNDATION_INVALID", `${foundationReportFile} is not a foundation materialization report.`, { file: foundationReportFile });
  if (componentReport.type !== "sitespec-migrate-component-contracts") throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_COMPONENTS_INVALID", `${componentReportFile} is not a component contract report.`, { file: componentReportFile });
  if (uiReport.type !== "sitespec-migrate-ui-contracts") throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_UI_INVALID", `${uiReportFile} is not a UI contract report.`, { file: uiReportFile });
  if (shellReport.type !== "sitespec-migrate-shell-contracts") throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_SHELL_INVALID", `${shellReportFile} is not a shell contract report.`, { file: shellReportFile });
  if (implementationReport && implementationReport.type !== "sitespec-migrate-implementation-inference") throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_INVALID", `${implementationReportFile} is not an implementation inference report.`, { file: implementationReportFile });
  const sites = [foundationReport.site, componentReport.site, uiReport.site, shellReport.site, ...(implementationReport ? [implementationReport.site] : [])];
  if (new Set(sites).size !== 1) throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_SITE_MISMATCH", `Migration artifacts belong to different sites: ${sites.join(", ")}`, { sites });
  await assertReportReviewCurrent(componentReportFile, componentReport, "MIGRATE_DESIGN_SYSTEM_COMPONENTS_STALE");
  await assertReportReviewCurrent(uiReportFile, uiReport, "MIGRATE_DESIGN_SYSTEM_UI_STALE");
  await assertReportReviewCurrent(shellReportFile, shellReport as unknown as ContractReport, "MIGRATE_DESIGN_SYSTEM_SHELL_STALE");
  if (implementationReport) {
    await assertImplementationSourceCurrent(implementationReportFile, implementationReport.source.foundation, implementationReport.source.foundationSha256, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE");
    await assertImplementationSourceCurrent(implementationReportFile, implementationReport.source.components, implementationReport.source.componentsSha256, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE");
    await assertImplementationSourceCurrent(implementationReportFile, implementationReport.source.ui, implementationReport.source.uiSha256, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE");
    await assertImplementationSourceCurrent(implementationReportFile, implementationReport.source.shell, implementationReport.source.shellSha256, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE");
    if (implementationReport.source.designReport && implementationReport.source.designReportSha256) {
      await assertImplementationSourceCurrent(implementationReportFile, implementationReport.source.designReport, implementationReport.source.designReportSha256, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE");
    }
    for (const evidence of implementationReport.source.evidenceSources ?? []) {
      await assertImplementationSourceCurrent(implementationReportFile, evidence.file, evidence.sha256, "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE");
    }
  }

  const foundationReviewFile = isAbsolute(foundationReport.review) ? foundationReport.review : resolve(dirname(foundationReportFile), foundationReport.review);
  if (await exists(foundationReviewFile)) {
    const foundationReviewRaw = await readFile(foundationReviewFile, "utf8");
    const foundationReview = parseJson<Record<string, unknown>>(foundationReviewRaw, foundationReviewFile, "MIGRATE_DESIGN_SYSTEM_FOUNDATION_INVALID");
    const source = isRecord(foundationReview.source) ? foundationReview.source : undefined;
    if (source && typeof source.proposal === "string" && typeof source.proposalSha256 === "string") {
      const proposalFile = isAbsolute(source.proposal) ? source.proposal : resolve(dirname(foundationReviewFile), source.proposal);
      if (!(await exists(proposalFile)) || sha256(await readFile(proposalFile, "utf8")) !== source.proposalSha256) {
        throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_FOUNDATION_STALE", "foundation-materialization.json is backed by a stale foundation review/proposal. Re-run migrate foundation review/materialize before staging the Design System.", { review: foundationReviewFile, proposal: proposalFile });
      }
    }
  }

  const output = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(root, options.output))
    : join(analysis, "design-system-staging");
  const report = join(analysis, "design-system-materialization.json");
  await prepareStagingOutput(output);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, STAGING_MARKER), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-design-system-staging-output" }, null, 2)}\n`, "utf8");

  const files: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const implementationBlockers: string[] = [];
  const fontBlockers: string[] = [];

  if (foundationReport.status !== "ready") blockers.push(`foundation materialization is ${foundationReport.status}; expected ready`);
  for (const blocker of foundationReport.blockers ?? []) blockers.push(`foundation: ${blocker}`);
  for (const warning of foundationReport.warnings ?? []) warnings.push(`foundation: ${warning}`);

  const foundationTokensFile = isAbsolute(foundationReport.output) ? foundationReport.output : resolve(dirname(foundationReportFile), foundationReport.output);
  if (!(await exists(foundationTokensFile))) blockers.push(`foundation token preview is missing: ${foundationTokensFile}`);
  else await copyTracked(foundationTokensFile, join(output, "design", "tokens.json"), output, files);

  const componentOutput = contractOutputDir(componentReportFile, componentReport);
  const componentIds: string[] = [];
  for (const contract of componentReport.contracts ?? []) {
    const componentId = typeof contract.componentId === "string" ? contract.componentId : undefined;
    const file = typeof contract.file === "string" ? contract.file : undefined;
    if (!componentId || !file) { blockers.push("component contract report contains an entry without componentId/file"); continue; }
    const source = join(componentOutput, file);
    if (!(await exists(source))) { blockers.push(`${componentId}: component.yaml preview is missing at ${source}`); continue; }
    await copyTracked(source, join(output, "components", componentId, "component.yaml"), output, files);
    componentIds.push(componentId);
  }
  for (const blocker of componentReport.blockers ?? []) blockers.push(`components: ${blocker}`);
  for (const warning of componentReport.warnings ?? []) warnings.push(`components: ${warning}`);

  const uiOutput = contractOutputDir(uiReportFile, uiReport);
  const uiIds: string[] = [];
  for (const contract of uiReport.contracts ?? []) {
    const uiId = typeof contract.uiId === "string" ? contract.uiId : undefined;
    const file = typeof contract.file === "string" ? contract.file : undefined;
    if (!uiId || !file) { blockers.push("UI contract report contains an entry without uiId/file"); continue; }
    const source = join(uiOutput, file);
    if (!(await exists(source))) { blockers.push(`${uiId}: ui.yaml preview is missing at ${source}`); continue; }
    await copyTracked(source, join(output, "ui", uiId, "ui.yaml"), output, files);
    uiIds.push(uiId);
  }
  for (const blocker of uiReport.blockers ?? []) blockers.push(`ui: ${blocker}`);
  for (const warning of uiReport.warnings ?? []) warnings.push(`ui: ${warning}`);

  const shellPacks = shellReport.packs ?? [];
  for (const blocker of shellReport.blockers ?? []) blockers.push(`shell: ${blocker}`);
  for (const warning of shellReport.warnings ?? []) warnings.push(`shell: ${warning}`);
  if (shellPacks.length === 0) blockers.push("No shell pack contract is available.");

  const expectedImplementationFiles = [
    ...componentIds.map(id => `components/${id}/index.astro`),
    ...uiIds.map(id => `ui/${id}/index.astro`),
    ...shellPacks.flatMap(pack => pack.files)
  ].filter((value, index, all) => all.indexOf(value) === index).sort();
  if (implementationReport) {
    const implementationOutput = isAbsolute(implementationReport.output) ? implementationReport.output : resolve(dirname(implementationReportFile), implementationReport.output);
    const available = new Set(implementationReport.files ?? []);
    for (const file of expectedImplementationFiles) {
      if (!available.has(file) || !(await exists(join(implementationOutput, file)))) {
        implementationBlockers.push(file);
        continue;
      }
      await copyTracked(join(implementationOutput, file), join(output, file), output, files);
    }
    for (const designFile of ["design/extensions.json", "design/fonts.yaml"]) {
      if (available.has(designFile) && await exists(join(implementationOutput, designFile))) await copyTracked(join(implementationOutput, designFile), join(output, designFile), output, files);
      else blockers.push(`implementation support file missing: ${designFile}`);
    }
    for (const blocker of implementationReport.blockers ?? []) blockers.push(`implementations: ${blocker}`);
    for (const warning of implementationReport.warnings ?? []) warnings.push(`implementations: ${warning}`);
  } else {
    implementationBlockers.push(...expectedImplementationFiles);
  }

  const tokenText = await (await exists(foundationTokensFile) ? readFile(foundationTokensFile, "utf8") : Promise.resolve(""));
  const uniqueFontFamilies = fontFamiliesFromTokens(tokenText);
  if (implementationReport && await exists(join(output, "design", "fonts.yaml"))) {
    if (uniqueFontFamilies.length) warnings.push(`Local font binaries are not materialized yet for: ${uniqueFontFamilies.join(", ")}. The Design System remains executable via the declared fallback font stack, but visual fidelity is partial.`);
  } else {
    fontBlockers.push(uniqueFontFamilies.length
      ? `design/fonts.yaml + local public/fonts assets are not materialized yet for: ${uniqueFontFamilies.join(", ")}`
      : "design/fonts.yaml + local public/fonts assets are not materialized yet");
  }

  const site = foundationReport.site;
  const designSystemId = options.id ?? slugifySite(site);
  const designSystemName = options.name ?? `${site} migrated Design System`;
  const designSystemVersion = options.version ?? "0.1.0-migration";
  if (!ID_PATTERN.test(designSystemId)) throw new MigrateDesignSystemError("MIGRATE_DESIGN_SYSTEM_ID_INVALID", `Invalid Design System id "${designSystemId}".`, { id: designSystemId });
  const defaultShell = shellPacks[0];
  const manifest = {
    specVersion: "0.5",
    designSystem: {
      id: designSystemId,
      name: designSystemName,
      version: designSystemVersion,
      description: implementationReport ? `Executable implementation staging pack inferred from reviewed migration evidence for ${site}. Local font assets and unobserved interaction states remain explicit follow-up work.` : `Contract staging pack inferred from reviewed migration evidence for ${site}. Implementations and font assets remain explicit follow-up work.`
    },
    tokens: {
      source: "design/tokens.json",
      extension: "design/extensions.json",
      rules: { primitive: "additive", semantic: "additive" }
    },
    fonts: { source: "design/fonts.yaml", assetsRoot: "public/fonts" },
    themes: { default: "default", items: { default: { label: "Default" } } },
    layout: {
      convention: "outer-gutter-inner-container",
      tokens: { pageGutter: "space.page", contentWidth: "size.content", sectionSpacing: "space.section" }
    },
    libraries: { ui: [...new Set(uiIds)].sort(), sections: [...new Set(componentIds)].sort(), presets: [] },
    shells: defaultShell ? {
      default: defaultShell.id,
      items: Object.fromEntries(shellPacks.map(pack => [pack.id, { entry: pack.entry, files: pack.files }]))
    } : {
      default: "default",
      items: { default: { entry: "shell/default.astro", files: ["shell/default.astro"] } }
    }
  };
  await writeFile(join(output, "design-system.yaml"), `${yamlDocument(manifest)}\n`, "utf8");
  files.push("design-system.yaml");

  if (implementationReport && implementationBlockers.length === 0 && (await exists(join(output, "design", "extensions.json"))) && (await exists(join(output, "design", "fonts.yaml")))) {
    const diagnostics = await validateDesign(output);
    for (const diagnostic of diagnostics.filter(item => item.severity === "error")) {
      const location = [diagnostic.file, diagnostic.path].filter(Boolean).join(":");
      const actual = diagnostic.actual === undefined ? "" : ` [${String(diagnostic.actual)}]`;
      blockers.push(`design validation: ${diagnostic.code}${location ? ` (${location})` : ""}: ${diagnostic.message}${actual}`);
    }
  }

  const uniqueImplementationBlockers = [...new Set(implementationBlockers)].sort();
  const uniqueFontBlockers = [...new Set(fontBlockers)].sort();
  blockers.push(...uniqueImplementationBlockers.map(file => `implementation missing: ${file}`));
  blockers.push(...uniqueFontBlockers);
  if ((componentReport.status !== "ready" && componentReport.status !== "partial") || (uiReport.status !== "ready" && uiReport.status !== "partial")) {
    blockers.push("one or more contract proposal reports are blocked");
  }
  if (shellReport.status === "blocked") blockers.push("shell contracts are blocked");
  warnings.push("Pending/rejected component and UI review decisions are intentionally excluded from the staging library and do not count as blockers.");
  warnings.push(implementationReport ? "Accepted Astro implementations are staged and design-linted. Pending review families remain excluded; local font assets and unobserved interactive states remain follow-up fidelity work." : "design-system.yaml is generated now so the next implementation phase has a concrete export contract; the staging directory is not installable until implementation/font blockers are resolved.");

  const uniqueBlockers = [...new Set(blockers)].sort();
  const uniqueWarnings = [...new Set(warnings)].sort();
  const hardContractBlockers = uniqueBlockers.filter(item => !item.startsWith("implementation missing:") && !item.startsWith("design/fonts.yaml"));
  const status: DesignSystemStagingResult["status"] = hardContractBlockers.length > 0 ? "blocked" : uniqueBlockers.length > 0 ? "partial" : "ready";
  const summary: DesignSystemStagingResult["summary"] = {
    primitiveTokens: numericSummary(foundationReport.summary, "primitive"),
    semanticTokens: numericSummary(foundationReport.summary, "semantic"),
    provisionalTokens: numericSummary(foundationReport.summary, "provisionalTokens"),
    uiContracts: uiIds.length,
    sectionContracts: componentIds.length,
    shellPacks: shellPacks.length,
    implementationBlockers: uniqueImplementationBlockers.length,
    fontBlockers: uniqueFontBlockers.length
  };
  const document = {
    version: "0.1",
    type: "sitespec-migrate-design-system-materialization",
    status,
    phase: implementationReport ? "implementation-staging" : "contract-staging",
    site,
    source: {
      foundation: relativeOrAbsolute(dirname(report), foundationReportFile),
      components: relativeOrAbsolute(dirname(report), componentReportFile),
      ui: relativeOrAbsolute(dirname(report), uiReportFile),
      shell: relativeOrAbsolute(dirname(report), shellReportFile),
      ...(implementationReport ? { implementation: relativeOrAbsolute(dirname(report), implementationReportFile) } : {})
    },
    output: relativeOrAbsolute(dirname(report), output),
    files: files.sort(),
    excluded: {
      rule: "Only accepted materialized contracts are exported. Pending/rejected review decisions remain outside the staging library.",
      ui: "See ui-review.json for pending/rejected UI families (for example heuristic Card).",
      components: "See component-review.json for pending/rejected supporting/local component families."
    },
    unresolved: {
      implementations: uniqueImplementationBlockers,
      fonts: uniqueFontBlockers,
      interactiveStates: "UI hover/focus/active state mapping remains unresolved until interactive-state capture exists.",
      shellRuntime: implementationReport ? "Static shell implementation is staged; responsive menu open/close behavior remains unresolved until interactive-state capture." : "Responsive navigation/runtime behavior remains unresolved until shell implementation inference."
    },
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    summary
  };
  await writeFile(report, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { site, status, phase: implementationReport ? "implementation-staging" : "contract-staging", output, report, files: files.sort(), blockers: uniqueBlockers, warnings: uniqueWarnings, summary };
}

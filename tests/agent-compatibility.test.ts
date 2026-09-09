import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

async function starter(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "acme");
  await initProject({ directory: root, name: "Acme" });
  return { temp, root };
}

test("sitespec init creates portable agent bootstrap instructions", async () => {
  const { temp, root } = await starter("site-spec-agent-bootstrap-");
  try {
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");

    assert.match(agents, /npm run site -- spec --json/);
    assert.match(agents, /npm run site -- validate --json/);
    assert.match(agents, /npm run site -- add component <id>/);
    assert.match(agents, /npm run site -- add ui <id>/);
    assert.match(agents, /Reusable section presets/);
    assert.match(agents, /Dynamic routes/);
    assert.match(agents, /Cross-site navigation/);
    assert.match(agents, /navigation:<id>/);
    assert.match(agents, /shell\/default\.astro/);
    assert.match(agents, /Visual styling and design tokens/);
    assert.match(agents, /npm run site -- spec design --json/);
    assert.match(agents, /npm run site -- spec design-system --json/);
    assert.match(agents, /semantic CSS variables/);
    assert.match(agents, /Global assets/);
    assert.match(agents, /npm run site -- spec assets --json/);
    assert.match(agents, /npm run site -- migrate audit https:\/\/example\.com --json/);
    assert.match(agents, /npm run site -- migrate segment/);
    assert.match(agents, /npm run site -- migrate design/);
    assert.match(agents, /npm run site -- migrate components review/);
    assert.match(agents, /npm run site -- migrate components contracts/);
    assert.match(agents, /npm run site -- migrate implementations infer/);
    assert.match(agents, /npm run site -- migrate foundation review/);
    assert.match(agents, /npm run site -- migrate foundation materialize/);
    assert.match(agents, /assets\.favicon/);
    assert.match(agents, /Never manually edit/);
    assert.match(gitignore, /\.sitespec\/audit\//);
    assert.match(gitignore, /\.sitespec\/migration\//);
    assert.equal(claude.trim(), "@AGENTS.md");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("site spec exposes a stable agent protocol", async () => {
  const { temp, root } = await starter("site-spec-agent-protocol-");
  try {
    const result = await inspectProject(root);
    const capabilities = result.capabilities as Record<string, boolean>;
    const agent = result.agent as {
      protocolVersion: string;
      workflow: Record<string, string>;
      rules: Record<string, boolean>;
      navigation: Record<string, string>;
      assets: { inspect: string; faviconRequired: boolean };
      media: { renderer: string; formats: string[] };
      seo: { generated: string[] };
      design: { inspect: string; model: string };
      designSystem: { inspect: string; inspectPack: string; install: string; pack: string; runtimeDependency: boolean };
      migration: { audit: string; segment: string; design: string; componentsReview: string; componentsContracts: string; uiReview: string; uiContracts: string; shellContracts: string; implementationsInfer: string; designSystemMaterialize: string; foundationReview: string; foundationMaterialize: string; output: string; auditOutput: string; designOutput: string; componentFamiliesOutput: string; componentReviewOutput: string; componentContractsOutput: string; uiFamiliesOutput: string; uiReviewOutput: string; uiContractsOutput: string; shellContractsOutput: string; implementationInferenceOutput: string; implementationPreviewOutput: string; designSystemStagingOutput: string; foundationReviewOutput: string; foundationTokensOutput: string; evidence: string[]; proposals: string[]; rule: string };
      generated: string[];
    };

    assert.equal(agent.protocolVersion, "7");
    assert.equal(capabilities.existingSiteAudit, true);
    assert.equal(capabilities.existingSiteManualSegmentation, true);
    assert.equal(capabilities.existingSiteDesignAnalysis, true);
    assert.equal(capabilities.existingSiteComponentReview, true);
    assert.equal(capabilities.existingSiteComponentContracts, true);
    assert.equal(capabilities.existingSiteShellContracts, true);
    assert.equal(capabilities.existingSiteImplementationInference, true);
    assert.equal(capabilities.existingSiteDesignSystemStaging, true);
    assert.equal(capabilities.existingSiteLeafUiAnalysis, true);
    assert.equal(capabilities.existingSiteFoundationReview, true);
    assert.equal(capabilities.existingSiteFoundationMaterialization, true);
    assert.equal(agent.workflow.inspect, "npm run site -- spec --json");
    assert.equal(agent.workflow.validate, "npm run site -- validate --json");
    assert.equal(agent.workflow.build, "npm run build");
    assert.equal(agent.workflow.inspectDesignSystem, "npm run site -- spec design-system --json");
    assert.equal(agent.workflow.inspectDesignSystemPack, "npm run site -- design-system --json");
    assert.equal(agent.workflow.auditExistingSite, "npm run site -- migrate audit <url> --json");
    assert.equal(agent.workflow.segmentExistingSite, "npm run site -- migrate segment <audit> --json");
    assert.equal(agent.workflow.analyzeExistingSiteDesign, "npm run site -- migrate design <audit...> --json");
    assert.equal(agent.workflow.reviewExistingSiteComponents, "npm run site -- migrate components review <analysis> --json");
    assert.equal(agent.workflow.proposeExistingSiteComponentContracts, "npm run site -- migrate components contracts <review> --json");
    assert.equal(agent.workflow.proposeExistingSiteShellContracts, "npm run site -- migrate shell contracts <component-review> --json");
    assert.equal(agent.workflow.reviewExistingSiteUi, "npm run site -- migrate ui review <analysis> --json");
    assert.equal(agent.workflow.proposeExistingSiteUiContracts, "npm run site -- migrate ui contracts <review> --json");
    assert.equal(agent.workflow.inferExistingSiteImplementations, "npm run site -- migrate implementations infer <analysis> --json");
    assert.equal(agent.workflow.stageExistingSiteDesignSystem, "npm run site -- migrate design-system materialize <analysis> --json");
    assert.equal(agent.workflow.reviewExistingSiteFoundation, "npm run site -- migrate foundation review <analysis> --json");
    assert.equal(agent.workflow.materializeExistingSiteFoundation, "npm run site -- migrate foundation materialize <review> --json");
    assert.equal(agent.rules.preferExistingComponents, true);
    assert.equal(agent.rules.sharedNavigationInSiteYaml, true);
    assert.equal(agent.rules.siteShellOwnsPersistentUi, true);
    assert.equal(agent.rules.semanticAssetsInSiteYaml, true);
    assert.equal(agent.rules.faviconRequired, true);
    assert.equal(agent.navigation.inspect, "npm run site -- spec navigation:<collection> --json");
    assert.equal(agent.assets.inspect, "npm run site -- spec assets --json");
    assert.equal(agent.media.renderer, "@site-generated/components/SiteImage.astro");
    assert.deepEqual(agent.media.formats, ["avif", "webp"]);
    assert.ok(agent.seo.generated.includes("llms.txt"));
    assert.equal(agent.design.inspect, "npm run site -- spec design --json");
    assert.match(agent.design.model, /primitive values -> semantic aliases/);
    assert.equal(agent.designSystem.inspect, "npm run site -- spec design-system --json");
    assert.equal(agent.designSystem.inspectPack, "npm run site -- design-system --json");
    assert.equal(agent.designSystem.install, "npm run site -- design-system install <pack> --replace");
    assert.equal(agent.designSystem.pack, "npm run site -- design-system pack <directory>");
    assert.equal(agent.designSystem.runtimeDependency, false);
    assert.equal(agent.migration.audit, "npm run site -- migrate audit <url> --json");
    assert.equal(agent.migration.segment, "npm run site -- migrate segment <audit> --json");
    assert.equal(agent.migration.design, "npm run site -- migrate design <audit...> --json");
    assert.equal(agent.migration.componentsReview, "npm run site -- migrate components review <analysis> --json");
    assert.equal(agent.migration.componentsContracts, "npm run site -- migrate components contracts <review> --json");
    assert.equal(agent.migration.uiReview, "npm run site -- migrate ui review <analysis> --json");
    assert.equal(agent.migration.uiContracts, "npm run site -- migrate ui contracts <review> --json");
    assert.equal(agent.migration.shellContracts, "npm run site -- migrate shell contracts <component-review> --json");
    assert.equal(agent.migration.implementationsInfer, "npm run site -- migrate implementations infer <analysis> --json");
    assert.equal(agent.migration.designSystemMaterialize, "npm run site -- migrate design-system materialize <analysis> --json");
    assert.equal(agent.migration.foundationReview, "npm run site -- migrate foundation review <analysis> --json");
    assert.equal(agent.migration.foundationMaterialize, "npm run site -- migrate foundation materialize <review> --json");
    assert.equal(agent.migration.output, ".sitespec/audit/<host>/<route>/");
    assert.equal(agent.migration.auditOutput, ".sitespec/audit/<host>/<route>/");
    assert.equal(agent.migration.designOutput, ".sitespec/migration/<host>/design/");
    assert.equal(agent.migration.componentFamiliesOutput, ".sitespec/migration/<host>/design/component-families.json");
    assert.equal(agent.migration.componentReviewOutput, ".sitespec/migration/<host>/design/component-review.json");
    assert.equal(agent.migration.componentContractsOutput, ".sitespec/migration/<host>/design/component-contracts/");
    assert.equal(agent.migration.uiFamiliesOutput, ".sitespec/migration/<host>/design/ui-families.json");
    assert.equal(agent.migration.uiReviewOutput, ".sitespec/migration/<host>/design/ui-review.json");
    assert.equal(agent.migration.uiContractsOutput, ".sitespec/migration/<host>/design/ui-contracts/");
    assert.equal(agent.migration.shellContractsOutput, ".sitespec/migration/<host>/design/shell-contracts.json");
    assert.equal(agent.migration.implementationInferenceOutput, ".sitespec/migration/<host>/design/implementation-inference.json");
    assert.equal(agent.migration.implementationPreviewOutput, ".sitespec/migration/<host>/design/implementation-preview/");
    assert.equal(agent.migration.designSystemStagingOutput, ".sitespec/migration/<host>/design/design-system-staging/");
    assert.equal(agent.migration.foundationReviewOutput, ".sitespec/migration/<host>/design/foundation-review.json");
    assert.equal(agent.migration.foundationTokensOutput, ".sitespec/migration/<host>/design/foundation-tokens.json");
    assert.ok(agent.migration.evidence.includes("computed design inventory"));
    assert.ok(agent.migration.evidence.includes("leaf UI inventory"));
    assert.ok(agent.migration.evidence.includes("manual visual segments"));
    assert.ok(agent.migration.proposals.includes("section clusters"));
    assert.ok(agent.migration.proposals.includes("component families"));
    assert.ok(agent.migration.proposals.includes("component review"));
    assert.ok(agent.migration.proposals.includes("component contracts"));
    assert.ok(agent.migration.proposals.includes("leaf UI families"));
    assert.ok(agent.migration.proposals.includes("leaf UI review"));
    assert.ok(agent.migration.proposals.includes("leaf UI contracts"));
    assert.ok(agent.migration.proposals.includes("shell contracts"));
    assert.ok(agent.migration.proposals.includes("design system contract staging"));
    assert.ok(agent.migration.proposals.includes("design system implementation staging"));
    assert.ok(agent.migration.proposals.includes("section rhythm"));
    assert.ok(agent.migration.proposals.includes("foundation proposal"));
    assert.ok(agent.migration.proposals.includes("foundation review"));
    assert.match(agent.migration.rule, /prefers completed manual segments/);
    assert.match(agent.migration.rule, /--apply --replace/);
    assert.equal(agent.assets.faviconRequired, true);
    assert.equal(agent.rules.editGeneratedFiles, false);
    assert.deepEqual(agent.generated, [".site/", "dist/"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("unknown component diagnostic tells an agent whether to reuse or create", async () => {
  const { temp, root } = await starter("site-spec-agent-component-repair-");
  try {
    const pageFile = join(root, "pages", "home.yaml");
    const source = await readFile(pageFile, "utf8");
    await writeFile(pageFile, source.replace("use: feature-grid", "use: feature-grdi"), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "SECTION_COMPONENT_UNKNOWN");
    assert.ok(diagnostic);
    assert.equal(diagnostic.actual, "feature-grdi");
    assert.ok(diagnostic.allowed?.includes("feature-grid"));
    assert.ok(diagnostic.suggestions?.some(item => item.action === "reuse-component" && item.candidates?.includes("feature-grid")));
    assert.ok(diagnostic.suggestions?.some(item => item.action === "create-component" && item.command === "npm run site -- add component feature-grdi"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("variant diagnostic includes allowed values and a deterministic repair", async () => {
  const { temp, root } = await starter("site-spec-agent-variant-repair-");
  try {
    const pageFile = join(root, "pages", "home.yaml");
    const source = await readFile(pageFile, "utf8");
    await writeFile(pageFile, source.replace("variant: split", "variant: splt"), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "COMPONENT_VARIANT_UNKNOWN");
    assert.ok(diagnostic);
    assert.equal(diagnostic.actual, "splt");
    assert.deepEqual(diagnostic.allowed, ["default", "centered", "split"]);
    assert.ok(diagnostic.suggestions?.some(item => item.action === "use-value" && item.value === "split"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("unknown prop diagnostic exposes the component vocabulary", async () => {
  const { temp, root } = await starter("site-spec-agent-prop-repair-");
  try {
    const pageFile = join(root, "pages", "home.yaml");
    const source = await readFile(pageFile, "utf8");
    const titleLine = source.match(/^      title: .+$/m)?.[0];
    assert.ok(titleLine);
    await writeFile(pageFile, source.replace(titleLine, `${titleLine}\n      titel: Typo`), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "COMPONENT_PROP_UNKNOWN");
    assert.ok(diagnostic);
    assert.equal(diagnostic.actual, "titel");
    assert.ok(diagnostic.allowed?.includes("title"));
    assert.ok(diagnostic.suggestions?.some(item => item.action === "rename-prop" && item.candidates?.includes("title")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

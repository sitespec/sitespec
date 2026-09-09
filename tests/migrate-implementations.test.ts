import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inferImplementations, MigrateImplementationError } from "../packages/cli/src/migrate-implementations.js";
import { materializeDesignSystemStaging } from "../packages/cli/src/migrate-design-system.js";

function layoutNode(selector: string, style: Record<string, string>) {
  return { selector, tag: "section", style, box: { x: 0, y: 0, width: 1440, height: 500 } };
}

function toKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}

function semanticCssVars(tree: unknown, prefix: string[] = []): Set<string> {
  const vars = new Set<string>();
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return vars;
  const record = tree as Record<string, unknown>;
  if ("$value" in record) {
    vars.add(`--${prefix.map(toKebab).join("-")}`);
    return vars;
  }
  for (const [key, value] of Object.entries(record)) {
    for (const item of semanticCssVars(value, [...prefix, key])) vars.add(item);
  }
  return vars;
}

function sectionFamily(id: string, role: string, confidence: number) {
  return {
    id, suggestedComponentId: id, layer: "section", role, status: "core", confidence, reason: `${id} repeated`,
    evidence: { instances: 2, pages: ["home", "stories"], pageCoverage: 1, crossPage: true, repeatedWithinPage: false, manualInstances: 2, semanticIntentSupport: 2, semanticIntentConfidence: 1, clusters: [], clusterSimilarity: confidence, observedContent: {} },
    variants: [{ id: "default", confidence, source: "default", members: [], reason: "default" }],
    contractHints: { role, props: [] },
    members: [
      { page: "home", sourceUrl: "https://example.com/", auditId: id, variant: "default" },
      { page: "stories", sourceUrl: "https://example.com/products/widget", auditId: id, variant: "default" }
    ]
  };
}

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-impl-"));
  const analysis = join(temp, ".sitespec", "migration", "example.com", "design");
  const home = join(temp, ".sitespec", "audit", "example.com", "home");
  const stories = join(temp, ".sitespec", "audit", "example.com", "stories");
  await mkdir(analysis, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(stories, { recursive: true });

  const tokens = {
    primitive: {
      color: {
        white: { $type: "color", $value: "#ffffff" },
        brand: { 500: { $type: "color", $value: "#1161e7" } },
        neutral: { 50: { $type: "color", $value: "#f3f7fa" }, 350: { $type: "color", $value: "#a1a4aa" }, 700: { $type: "color", $value: "#494f58" }, 900: { $type: "color", $value: "#101828" } }
      },
      space: {
        4: { $type: "dimension", $value: "4px" }, 8: { $type: "dimension", $value: "8px" }, 12: { $type: "dimension", $value: "12px" }, 16: { $type: "dimension", $value: "16px" },
        20: { $type: "dimension", $value: "20px" }, 24: { $type: "dimension", $value: "24px" }, 32: { $type: "dimension", $value: "32px" }, 40: { $type: "dimension", $value: "40px" },
        page: { $type: "dimension", $value: "24px" }, section: { $type: "dimension", $value: "96px" }
      },
      radius: { 10: { $type: "dimension", $value: "10px" } },
      size: { 1376: { $type: "dimension", $value: "1376px" } },
      font: {
        family: { sans: { $type: "fontFamily", $value: "\"Roboto Flex\", sans-serif" } },
        size: { 14: { $type: "dimension", $value: "14px" }, 16: { $type: "dimension", $value: "16px" }, 18: { $type: "dimension", $value: "18px" }, 32: { $type: "dimension", $value: "32px" }, 64: { $type: "dimension", $value: "64px" } },
        lineHeight: { 1: { $type: "number", $value: 1 }, 1.5: { $type: "number", $value: 1.5 } }
      }
    },
    semantic: {
      color: {
        accent: { default: { $type: "color", $value: "{primitive.color.brand.500}" } },
        surface: { default: { $type: "color", $value: "{primitive.color.white}" }, muted: { $type: "color", $value: "{primitive.color.neutral.50}" } },
        text: { default: { $type: "color", $value: "{primitive.color.neutral.900}" }, muted: { $type: "color", $value: "{primitive.color.neutral.700}" }, subtle: { $type: "color", $value: "{primitive.color.neutral.350}" } }
      },
      space: { page: { $type: "dimension", $value: "{primitive.space.page}" }, section: { $type: "dimension", $value: "{primitive.space.section}" } },
      size: { content: { $type: "dimension", $value: "{primitive.size.1376}" } }
    }
  };
  await writeFile(join(analysis, "foundation-tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`);
  await writeFile(join(analysis, "foundation-materialization.json"), `${JSON.stringify({
    version: "0.2", type: "sitespec-migrate-foundation-materialization", site: "example.com", status: "ready", quality: "provisional",
    review: "foundation-review.json", proposal: "foundation-proposal.json", output: "foundation-tokens.json", blockers: [], warnings: [],
    summary: { primitive: 24, semantic: 8, provisionalTokens: 2 }
  }, null, 2)}\n`);

  const componentFamilies = {
    version: "0.2", type: "sitespec-migrate-design-component-families", site: "example.com", rule: "fixture", unresolved: [], coverage: {}, summary: {},
    families: [
      { id: "site-header", suggestedComponentId: "site-header", layer: "shell", status: "core", confidence: .97, reason: "header", evidence: { instances: 2, pages: ["home", "stories"], pageCoverage: 1, crossPage: true, repeatedWithinPage: false, manualInstances: 2, semanticIntentSupport: 2, semanticIntentConfidence: 1, clusters: [], clusterSimilarity: 1, observedContent: {} }, variants: [{ id: "default", confidence: 1, source: "default", members: [], reason: "default" }], contractHints: { props: [] }, members: [{ page: "home", sourceUrl: "https://example.com/", auditId: "header", variant: "default" }, { page: "stories", sourceUrl: "https://example.com/products/widget", auditId: "header", variant: "default" }] },
      { id: "site-footer", suggestedComponentId: "site-footer", layer: "shell", status: "core", confidence: .97, reason: "footer", evidence: { instances: 2, pages: ["home", "stories"], pageCoverage: 1, crossPage: true, repeatedWithinPage: false, manualInstances: 2, semanticIntentSupport: 2, semanticIntentConfidence: 1, clusters: [], clusterSimilarity: 1, observedContent: {} }, variants: [{ id: "default", confidence: 1, source: "default", members: [], reason: "default" }], contractHints: { props: [] }, members: [{ page: "home", sourceUrl: "https://example.com/", auditId: "footer", variant: "default" }, { page: "stories", sourceUrl: "https://example.com/products/widget", auditId: "footer", variant: "default" }] },
      { id: "hero", suggestedComponentId: "hero", layer: "section", role: "intro", status: "core", confidence: .92, reason: "hero", evidence: { instances: 2, pages: ["home", "stories"], pageCoverage: 1, crossPage: true, repeatedWithinPage: false, manualInstances: 2, semanticIntentSupport: 2, semanticIntentConfidence: 1, clusters: [], clusterSimilarity: .9, observedContent: {} }, variants: [{ id: "default", confidence: .9, source: "default", members: [], reason: "default" }], contractHints: { role: "intro", pageHeading: true, props: [] }, members: [{ page: "home", sourceUrl: "https://example.com/", auditId: "hero", variant: "default" }, { page: "stories", sourceUrl: "https://example.com/products/widget", auditId: "hero", variant: "default" }] },
      sectionFamily("testimonials", "proof", .95),
      sectionFamily("logo-cloud", "proof", .91),
      sectionFamily("lead-form", "conversion", .9),
      sectionFamily("features", "content", .9)
    ]
  };
  await writeFile(join(analysis, "component-families.json"), `${JSON.stringify(componentFamilies, null, 2)}\n`);
  const uiFamilies = { version: "0.2", type: "sitespec-migrate-design-ui-families", site: "example.com", rule: "fixture", unresolved: [], summary: {}, families: [
    { id: "button", suggestedUiId: "button", sourceKinds: ["button"], role: "action", status: "core", materialization: { eligibility: "auto", reason: "direct" }, confidence: .92, reason: "button", evidence: { instances: 4, viewportOccurrences: 12, pages: ["home", "stories"], pageCoverage: 1, manualLinkedInstances: 4, manualLinkRatio: 1, styleClusters: 2, examples: [] }, variants: [{ id: "solid", confidence: .9, instances: 3, reason: "solid" }, { id: "ghost", confidence: .8, instances: 1, reason: "ghost" }], contractHints: { props: [] } },
    { id: "link", suggestedUiId: "link", sourceKinds: ["link"], role: "navigation", status: "core", materialization: { eligibility: "auto", reason: "direct" }, confidence: .94, reason: "link", evidence: { instances: 4, viewportOccurrences: 12, pages: ["home", "stories"], pageCoverage: 1, manualLinkedInstances: 4, manualLinkRatio: 1, styleClusters: 1, examples: [] }, variants: [{ id: "default", confidence: .9, instances: 4, reason: "default" }], contractHints: { props: [] } }
  ] };
  await writeFile(join(analysis, "ui-families.json"), `${JSON.stringify(uiFamilies, null, 2)}\n`);

  const componentContractsDir = join(analysis, "component-contracts");
  const uiContractsDir = join(analysis, "ui-contracts");
  for (const id of ["hero", "testimonials", "logo-cloud", "lead-form", "features"]) await mkdir(join(componentContractsDir, id), { recursive: true });
  await mkdir(join(uiContractsDir, "button"), { recursive: true });
  await mkdir(join(uiContractsDir, "link"), { recursive: true });
  await writeFile(join(componentContractsDir, "hero", "component.yaml"), `specVersion: "0.5"\ncomponent:\n  id: "hero"\n  role: "intro"\nvariants:\n  - "default"\nprops:\n  type: "object"\n  additionalProperties: false\n  required:\n    - "title"\n  properties:\n    title:\n      type: "string"\n    text:\n      type: "string"\n    primaryAction:\n      $ref: "urn:site-spec:0.5:type:action"\n`);
  await writeFile(join(componentContractsDir, "testimonials", "component.yaml"), `specVersion: "0.5"\ncomponent:\n  id: "testimonials"\n  role: "proof"\nvariants:\n  - "default"\nprops:\n  type: "object"\n  additionalProperties: false\n  properties:\n    items:\n      type: "array"\n      items:\n        type: "object"\n    media:\n      $ref: "urn:site-spec:0.5:type:image"\n    text:\n      type: "string"\n    title:\n      type: "string"\n`);
  await writeFile(join(componentContractsDir, "logo-cloud", "component.yaml"), `specVersion: "0.5"\ncomponent:\n  id: "logo-cloud"\n  role: "proof"\nvariants:\n  - "default"\nprops:\n  type: "object"\n  additionalProperties: false\n  properties:\n    items:\n      type: "array"\n      items:\n        type: "object"\n    media:\n      $ref: "urn:site-spec:0.5:type:image"\n`);
  await writeFile(join(componentContractsDir, "lead-form", "component.yaml"), `specVersion: "0.5"\ncomponent:\n  id: "lead-form"\n  role: "conversion"\nvariants:\n  - "default"\nprops:\n  type: "object"\n  additionalProperties: false\n  properties:\n    form:\n      type: "object"\n    media:\n      $ref: "urn:site-spec:0.5:type:image"\n    primaryAction:\n      $ref: "urn:site-spec:0.5:type:action"\n    text:\n      type: "string"\n    title:\n      type: "string"\n`);
  await writeFile(join(componentContractsDir, "features", "component.yaml"), `specVersion: "0.5"\ncomponent:\n  id: "features"\n  role: "content"\nvariants:\n  - "default"\nprops:\n  type: "object"\n  additionalProperties: false\n  required:\n    - "title"\n  properties:\n    media:\n      $ref: "urn:site-spec:0.5:type:image"\n    primaryAction:\n      $ref: "urn:site-spec:0.5:type:action"\n    text:\n      type: "string"\n    title:\n      type: "string"\n`);
  await writeFile(join(uiContractsDir, "button", "ui.yaml"), `specVersion: "0.5"\nui:\n  id: "button"\n  role: "action"\nvariants:\n  - "default"\n  - "ghost"\nprops:\n  type: "object"\n`);
  await writeFile(join(uiContractsDir, "link", "ui.yaml"), `specVersion: "0.5"\nui:\n  id: "link"\n  role: "navigation"\nvariants:\n  - "default"\nprops:\n  type: "object"\n`);
  await writeFile(join(analysis, "component-contracts.json"), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-component-contracts", status: "ready", site: "example.com", output: "component-contracts", contracts: [
    { family: "hero", componentId: "hero", role: "intro", confidence: .92, file: "hero/component.yaml", variants: ["default"], props: ["items", "primaryAction", "text", "title"], required: ["title"], unresolved: [] },
    { family: "testimonials", componentId: "testimonials", role: "proof", confidence: .95, file: "testimonials/component.yaml", variants: ["default"], props: ["items", "media", "text", "title"], required: [], unresolved: [] },
    { family: "logo-cloud", componentId: "logo-cloud", role: "proof", confidence: .91, file: "logo-cloud/component.yaml", variants: ["default"], props: ["items", "media"], required: [], unresolved: [] },
    { family: "lead-form", componentId: "lead-form", role: "conversion", confidence: .9, file: "lead-form/component.yaml", variants: ["default"], props: ["form", "media", "primaryAction", "text", "title"], required: [], unresolved: [] },
    { family: "features", componentId: "features", role: "content", confidence: .9, file: "features/component.yaml", variants: ["default"], props: ["media", "primaryAction", "text", "title"], required: ["title"], unresolved: [] }
  ], blockers: [], warnings: [] }, null, 2)}\n`);
  await writeFile(join(analysis, "ui-contracts.json"), `${JSON.stringify({ version: "0.2", type: "sitespec-migrate-ui-contracts", status: "ready", site: "example.com", output: "ui-contracts", contracts: [
    { family: "button", uiId: "button", role: "action", confidence: .92, file: "button/ui.yaml", variants: ["default", "ghost"], variantSources: [{ source: "solid", id: "default" }, { source: "ghost", id: "ghost" }], props: ["disabled", "href", "label"], required: [], unresolved: [] },
    { family: "link", uiId: "link", role: "navigation", confidence: .94, file: "link/ui.yaml", variants: ["default"], variantSources: [{ source: "default", id: "default" }], props: ["href", "label"], required: ["href", "label"], unresolved: [] }
  ], blockers: [], warnings: [] }, null, 2)}\n`);
  await writeFile(join(analysis, "shell-contracts.json"), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-shell-contracts", status: "ready", site: "example.com", packs: [{ id: "default", entry: "shell/default.astro", files: ["shell/default.astro", "shell/Header.astro", "shell/Footer.astro"], regions: [{ family: "site-header", id: "site-header", region: "header", file: "shell/Header.astro", confidence: .97 }, { family: "site-footer", id: "site-footer", region: "footer", file: "shell/Footer.astro", confidence: .97 }] }], blockers: [], warnings: [], summary: {} }, null, 2)}\n`);

  const uiItems = [
    { viewport: "desktop", kind: "button", selector: ".cta", tag: "a", text: "Start", href: "https://example.com", style: { display: "inline-flex", alignItems: "center", justifyContent: "center", color: "rgb(255, 255, 255)", backgroundColor: "rgb(17, 97, 231)", borderTopWidth: "1px", borderTopColor: "rgb(17, 97, 231)", borderRadius: "10px", paddingTop: "12px", paddingRight: "24px", paddingBottom: "12px", paddingLeft: "24px", fontSize: "16px", lineHeight: "24px" }, structure: { directChildren: 0, icons: 0, images: 0 }, box: { x: 0, y: 0, width: 120, height: 48 } },
    { viewport: "desktop", kind: "button", selector: ".ghost", tag: "a", text: "More", href: "https://example.com/more", style: { display: "inline-flex", alignItems: "center", justifyContent: "center", color: "rgb(16, 24, 40)", backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", borderTopColor: "rgb(16, 24, 40)", borderRadius: "10px", paddingTop: "12px", paddingRight: "24px", paddingBottom: "12px", paddingLeft: "24px", fontSize: "16px", lineHeight: "24px" }, structure: { directChildren: 0, icons: 0, images: 0 }, box: { x: 0, y: 0, width: 100, height: 48 } },
    { viewport: "desktop", kind: "link", selector: ".nav", tag: "a", text: "Docs", href: "https://example.com/docs", style: { display: "inline", color: "rgb(16, 24, 40)", backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", borderTopColor: "rgb(16, 24, 40)", borderRadius: "0px", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px", fontSize: "16px", lineHeight: "24px", textDecorationLine: "none" }, structure: { directChildren: 0, icons: 0, images: 0 }, box: { x: 0, y: 0, width: 50, height: 24 } }
  ];
  for (const auditRoot of [home, stories]) {
    await writeFile(join(auditRoot, "ui-inventory.json"), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-audit-ui-inventory", items: uiItems }, null, 2)}\n`);
    const sourceUrl = auditRoot === home ? "https://example.com/" : "https://example.com/products/widget";
    const viewportItems = [
      { auditId: "header", ...layoutNode("header", { display: "block", position: "sticky", color: "rgb(16, 24, 40)", backgroundColor: "rgb(255, 255, 255)" }) },
      { auditId: "hero", ...layoutNode("main > section:nth-of-type(1)", { display: "grid", color: "rgb(16, 24, 40)", backgroundColor: "rgb(255, 255, 255)", gridTemplateColumns: "1fr 1fr", gap: "32px" }) },
      { auditId: "logo-cloud", ...layoutNode("main > section:nth-of-type(2)", { display: "grid", color: "rgb(16, 24, 40)", backgroundColor: "rgb(243, 247, 250)", gridTemplateColumns: "repeat(4, 1fr)", gap: "24px" }) },
      { auditId: "features", ...layoutNode("main > section:nth-of-type(3)", { display: "grid", color: "rgb(16, 24, 40)", backgroundColor: "rgb(255, 255, 255)", gridTemplateColumns: "1fr 1fr", gap: "32px" }) },
      { auditId: "testimonials", ...layoutNode("main > section:nth-of-type(4)", { display: "grid", color: "rgb(16, 24, 40)", backgroundColor: "rgb(243, 247, 250)", gridTemplateColumns: "1fr", gap: "32px" }) },
      { auditId: "lead-form", ...layoutNode("main > section:nth-of-type(5)", { display: "grid", color: "rgb(16, 24, 40)", backgroundColor: "rgb(255, 255, 255)", gridTemplateColumns: "1fr 1fr", gap: "32px" }) },
      { auditId: "footer", ...layoutNode("footer", { display: "block", color: "rgb(73, 79, 88)", backgroundColor: "rgb(243, 247, 250)" }) }
    ];
    await writeFile(join(auditRoot, "sections.json"), `${JSON.stringify({ version: "0.4", sourceUrl, viewports: { desktop: { items: viewportItems }, mobile: { items: viewportItems.map(item => ({ ...item, style: { ...item.style, gridTemplateColumns: "none" } })) } }, manualRegions: {} }, null, 2)}\n`);
  }
  await writeFile(join(analysis, "report.json"), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-design", site: "example.com", audits: [{ sourceUrl: "https://example.com/", path: ".sitespec/audit/example.com/home" }, { sourceUrl: "https://example.com/products/widget", path: ".sitespec/audit/example.com/products-widget" }] }, null, 2)}\n`);
  return { temp, analysis };
}

test("implementation inference generates runnable accepted UI, section and shell files plus semantic extensions", async () => {
  const data = await fixture();
  try {
    const result = await inferImplementations({ analysis: data.analysis, root: data.temp });
    assert.equal(result.status, "ready");
    assert.equal(result.summary.uiImplementations, 2);
    assert.equal(result.summary.sectionImplementations, 5);
    assert.equal(result.summary.shellImplementations, 3);
    assert.ok(result.summary.semanticTokenExtensions >= 8);
    const button = await readFile(join(result.output, "ui", "button", "index.astro"), "utf8");
    assert.match(button, /data-ui="button"/);
    assert.match(button, /data-variant="default"/);
    assert.match(button, /var\(--space-control-y\)/);
    assert.doesNotMatch(button, /padding:\s*12px/);
    const hero = await readFile(join(result.output, "components", "hero", "index.astro"), "utf8");
    assert.match(hero, /data-component="hero"/);
    assert.match(hero, /var\(--space-section\)/);
    assert.match(hero, /background-color:/);
    assert.doesNotMatch(hero, /background:\s*transparent/);
    const testimonials = await readFile(join(result.output, "components", "testimonials", "index.astro"), "utf8");
    assert.match(testimonials, /<blockquote class="item-text">/);
    const logoCloud = await readFile(join(result.output, "components", "logo-cloud", "index.astro"), "utf8");
    assert.match(logoCloud, /data-component="logo-cloud"/);
    const leadForm = await readFile(join(result.output, "components", "lead-form", "index.astro"), "utf8");
    assert.match(leadForm, /type="submit"/);
    assert.doesNotMatch(leadForm, /<Button[^>]+Submit/);
    const features = await readFile(join(result.output, "components", "features", "index.astro"), "utf8");
    assert.match(features, /data-component="features"/);
    assert.match(await readFile(join(result.output, "shell", "Header.astro"), "utf8"), /data-site-shell="header"/);
    const extension = JSON.parse(await readFile(join(result.output, "design", "extensions.json"), "utf8"));
    assert.equal(extension.semantic.space.control.x.$value, "{primitive.space.24}");
    assert.equal(extension.semantic.color.accent.contrast.$value, "{primitive.color.white}");
    const baseTokens = JSON.parse(await readFile(join(data.analysis, "foundation-tokens.json"), "utf8"));
    const knownVars = new Set([
      ...semanticCssVars(baseTokens.semantic),
      ...semanticCssVars(extension.semantic)
    ]);
    const astroFiles = result.files.filter(file => file.endsWith(".astro"));
    for (const relativeFile of astroFiles) {
      const source = await readFile(join(result.output, relativeFile), "utf8");
      const styles = [...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map(match => match[1] ?? "").join("\n");
      assert.doesNotMatch(styles, /--primitive-/);
      assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\s*\(/i);
      assert.doesNotMatch(styles, /(?:margin|padding|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:\s*[^;]*(?:\d+(?:\.\d+)?(?:px|rem|em|vw|vh|%))/i);
      for (const match of styles.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
        const variable = match[1] ?? "";
        assert.ok(knownVars.has(variable), `unknown semantic variable in ${relativeFile}: ${variable}`);
      }
      for (const match of styles.matchAll(/border-radius\s*:\s*([^;]+);/gi)) {
        const value = (match[1] ?? "").trim();
        assert.ok(value === "0" || /^var\(--[a-z0-9-]+\)$/i.test(value), `border-radius must use a semantic variable or 0 in ${relativeFile}: ${value}`);
      }
    }
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

test("design system staging consumes implementation inference and becomes executable without Astro blockers", async () => {
  const data = await fixture();
  try {
    await inferImplementations({ analysis: data.analysis, root: data.temp });
    const result = await materializeDesignSystemStaging({ analysis: data.analysis, root: data.temp });
    assert.equal(result.phase, "implementation-staging");
    assert.equal(result.summary.implementationBlockers, 0);
    assert.equal(result.summary.fontBlockers, 0);
    assert.equal(result.status, "ready");
    assert.equal(await readFile(join(result.output, "ui", "button", "index.astro"), "utf8").then(() => true, () => false), true);
    assert.equal(await readFile(join(result.output, "components", "hero", "index.astro"), "utf8").then(() => true, () => false), true);
    assert.equal(await readFile(join(result.output, "shell", "default.astro"), "utf8").then(() => true, () => false), true);
    const report = JSON.parse(await readFile(result.report, "utf8"));
    assert.deepEqual(report.unresolved.implementations, []);
    assert.ok(report.warnings.some((item: string) => item.includes("Roboto Flex")));
    assert.equal(report.blockers.length, 0);
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});



test("design system staging rejects implementation evidence after an audited source changes", async () => {
  const data = await fixture();
  try {
    await inferImplementations({ analysis: data.analysis, root: data.temp });
    const sectionsFile = join(data.temp, ".sitespec", "audit", "example.com", "home", "sections.json");
    const raw = await readFile(sectionsFile, "utf8");
    await writeFile(sectionsFile, `${raw.trimEnd()}\n \n`);
    await assert.rejects(
      materializeDesignSystemStaging({ analysis: data.analysis, root: data.temp }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "MIGRATE_DESIGN_SYSTEM_IMPLEMENTATION_STALE")
    );
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

test("implementation inference refuses contract reports whose proposal source is stale", async () => {
  const data = await fixture();
  try {
    const reportFile = join(data.analysis, "component-contracts.json");
    const proposalFile = join(data.analysis, "component-families.json");
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const proposalRaw = await readFile(proposalFile, "utf8");
    report.source = {
      proposal: "component-families.json",
      proposalSha256: createHash("sha256").update(proposalRaw).digest("hex")
    };
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(proposalFile, `${proposalRaw.trimEnd()}\n \n`);
    await assert.rejects(
      inferImplementations({ analysis: data.analysis, root: data.temp }),
      (error: unknown) => error instanceof MigrateImplementationError && error.code === "MIGRATE_IMPLEMENTATIONS_COMPONENTS_STALE"
    );
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

test("implementation inference refuses to erase an unowned output directory", async () => {
  const data = await fixture();
  try {
    const output = join(data.analysis, "custom-implementation");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "keep.txt"), "keep");
    await assert.rejects(
      inferImplementations({ analysis: data.analysis, root: data.temp, output }),
      (error: unknown) => error instanceof MigrateImplementationError && error.code === "MIGRATE_IMPLEMENTATIONS_OUTPUT_NOT_OWNED"
    );
    assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

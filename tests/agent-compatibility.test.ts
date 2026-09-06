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
    assert.match(agents, /semantic CSS variables/);
    assert.match(agents, /Global assets/);
    assert.match(agents, /npm run site -- spec assets --json/);
    assert.match(agents, /assets\.favicon/);
    assert.match(agents, /Never manually edit/);
    assert.equal(claude.trim(), "@AGENTS.md");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("site spec exposes a stable agent protocol", async () => {
  const { temp, root } = await starter("site-spec-agent-protocol-");
  try {
    const result = await inspectProject(root);
    const agent = result.agent as {
      protocolVersion: string;
      workflow: Record<string, string>;
      rules: Record<string, boolean>;
      navigation: Record<string, string>;
      assets: { inspect: string; faviconRequired: boolean };
      design: { inspect: string; model: string };
      generated: string[];
    };

    assert.equal(agent.protocolVersion, "2");
    assert.equal(agent.workflow.inspect, "npm run site -- spec --json");
    assert.equal(agent.workflow.validate, "npm run site -- validate --json");
    assert.equal(agent.workflow.build, "npm run build");
    assert.equal(agent.rules.preferExistingComponents, true);
    assert.equal(agent.rules.sharedNavigationInSiteYaml, true);
    assert.equal(agent.rules.siteShellOwnsPersistentUi, true);
    assert.equal(agent.rules.semanticAssetsInSiteYaml, true);
    assert.equal(agent.rules.faviconRequired, true);
    assert.equal(agent.navigation.inspect, "npm run site -- spec navigation:<collection> --json");
    assert.equal(agent.assets.inspect, "npm run site -- spec assets --json");
    assert.equal(agent.design.inspect, "npm run site -- spec design --json");
    assert.match(agent.design.model, /primitive values -> semantic aliases/);
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
    await writeFile(pageFile, source.replace("title: A website that stays coherent as it evolves", "title: A website that stays coherent as it evolves\n      titel: Typo"), "utf8");

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

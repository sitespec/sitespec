import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";
import { loadProject } from "../packages/core/src/project.ts";
import { validateAstroComponentContracts } from "../packages/astro/src/index.ts";

async function starter(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "acme");
  await initProject({ directory: root, name: "Acme" });
  return { temp, root };
}

test("sitespec init exposes named navigation and a user-owned Site Shell", async () => {
  const { temp, root } = await starter("site-spec-navigation-init-");
  try {
    const spec = await inspectProject(root);
    const navigation = spec.navigation as Array<{ id: string; reference: string }>;
    const shell = spec.shell as { layout: string; exists: boolean; conventionalFiles: { header: { path: string; exists: boolean }; footer: { path: string; exists: boolean } } };

    assert.deepEqual(navigation.map(item => item.id), ["primary"]);
    assert.ok(navigation.some(item => item.reference === "navigation:primary"));
    assert.equal(shell.layout, "shell/default.astro");
    assert.equal(shell.exists, true);
    assert.equal(shell.conventionalFiles.header.path, "shell/Header.astro");
    assert.equal(shell.conventionalFiles.header.exists, true);
    assert.equal(shell.conventionalFiles.footer.path, "shell/Footer.astro");
    assert.equal(shell.conventionalFiles.footer.exists, true);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /Cross-site navigation/);
    assert.match(agents, /navigation:<id>/);
    assert.match(agents, /shell\/default\.astro/);
    assert.match(agents, /navigation-list/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("site spec can inspect a navigation collection directly", async () => {
  const { temp, root } = await starter("site-spec-navigation-inspect-");
  try {
    const result = await inspectProject(root, "navigation:primary");
    assert.equal(result.type, "navigation");
    const navigation = result.navigation as { id: string; reference: string; items: Array<{ id: string; href: string }> };
    assert.equal(navigation.id, "primary");
    assert.equal(navigation.reference, "navigation:primary");
    assert.deepEqual(navigation.items.map(item => item.id), ["home"]);
    const usage = result.usage as { shell: string; componentProp: { $ref: string } };
    assert.equal(usage.shell, "navigation.primary");
    assert.equal(usage.componentProp.$ref, "navigation:primary");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a page section can reuse a named navigation collection by reference", async () => {
  const { temp, root } = await starter("site-spec-navigation-ref-");
  try {
    const pageFile = join(root, "pages", "home.yaml");
    const source = await readFile(pageFile, "utf8");
    const addition = `\n  - id: page-navigation\n    use: navigation-list\n    variant: inline\n    props:\n      title: Explore\n      items:\n        $ref: navigation:primary\n`;
    await writeFile(pageFile, source.replace("\n  - id: final-cta", `${addition}\n  - id: final-cta`), "utf8");

    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    const section = result.site?.pages[0]?.sections.find(item => item.id === "page-navigation");
    const items = section?.props.items as Array<{ id: string; label: string; href: string }>;
    assert.deepEqual(items, [{ id: "home", label: "Home", href: "/" }]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("navigation route typos return deterministic repair candidates", async () => {
  const { temp, root } = await starter("site-spec-navigation-route-repair-");
  try {
    await writeFile(join(root, "pages", "pricing.yaml"), `specVersion: "0.2"\npage:\n  id: pricing\n  route: /pricing\n  archetype: marketing\nseo:\n  title: Pricing\nsections:\n  - id: intro\n    use: hero\n    props:\n      title: Pricing\n`, "utf8");
    const siteFile = join(root, "site.yaml");
    const source = await readFile(siteFile, "utf8");
    await writeFile(siteFile, source.replace("href: /\n", "href: /prcing\n"), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "NAVIGATION_LINK_INTERNAL_NOT_FOUND");
    assert.ok(diagnostic);
    assert.equal(diagnostic.actual, "/prcing");
    assert.ok(diagnostic.allowed?.includes("/pricing"));
    assert.ok(diagnostic.suggestions?.some(item => item.action === "use-route" && item.candidates?.includes("/pricing")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("unknown navigation references tell the agent which collections exist", async () => {
  const { temp, root } = await starter("site-spec-navigation-ref-repair-");
  try {
    const pageFile = join(root, "pages", "home.yaml");
    const source = await readFile(pageFile, "utf8");
    const addition = `\n  - id: page-navigation\n    use: navigation-list\n    props:\n      items:\n        $ref: navigation:primray\n`;
    await writeFile(pageFile, source.replace("\n  - id: final-cta", `${addition}\n  - id: final-cta`), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "NAVIGATION_REFERENCE_NOT_FOUND");
    assert.ok(diagnostic);
    assert.ok(diagnostic.allowed?.includes("navigation:primary"));
    assert.ok(diagnostic.suggestions?.some(item => item.action === "use-reference" && item.candidates?.includes("navigation:primary")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Site Shell is validated as user-owned persistent UI", async () => {
  const { temp, root } = await starter("site-spec-navigation-shell-contract-");
  try {
    let project = await loadProject(root);
    let diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(!diagnostics.some(item => item.code.startsWith("SHELL_")), JSON.stringify(diagnostics, null, 2));

    const shellFile = join(root, "shell", "default.astro");
    const source = await readFile(shellFile, "utf8");
    await writeFile(shellFile, source.replace("  <slot />", "  <p>Sections missing</p>"), "utf8");
    project = await loadProject(root);
    diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(diagnostics.some(item => item.code === "SHELL_SLOT_MISSING"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

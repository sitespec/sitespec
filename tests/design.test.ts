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

test("sitespec init creates primitive and semantic design token layers", async () => {
  const { temp, root } = await starter("site-spec-design-init-");
  try {
    const parsed = JSON.parse(await readFile(join(root, "design", "tokens.json"), "utf8")) as Record<string, unknown>;
    assert.ok(parsed.primitive);
    assert.ok(parsed.semantic);

    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("site spec design exposes semantic design vocabulary to agents", async () => {
  const { temp, root } = await starter("site-spec-design-inspect-");
  try {
    const result = await inspectProject(root, "design");
    assert.equal(result.type, "design");
    const design = result.design as {
      rules: { semanticTokensOnly: boolean; rawColors: boolean };
      categories: Record<string, string[]>;
      semantic: Array<{ name: string; cssVariable: string; alias?: string }>;
    };
    assert.equal(design.rules.semanticTokensOnly, true);
    assert.equal(design.rules.rawColors, false);
    assert.ok(design.categories.color?.includes("color.text.default"));
    assert.ok(design.semantic.some(token => token.cssVariable === "--color-text-default" && token.alias === "primitive.color.neutral900"));

    const agent = result.agent as { design: { inspect: string; model: string } };
    assert.equal(agent.design.inspect, "npm run site -- spec design --json");
    assert.match(agent.design.model, /primitive values -> semantic aliases/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("design lint rejects raw reusable color and spacing", async () => {
  const { temp, root } = await starter("site-spec-design-raw-");
  try {
    const file = join(root, "components", "cta", "index.astro");
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source.replace("background: var(--color-surface-muted);", "background: #fefefe;")
        .replace("margin-top: var(--space-stack-lg);", "margin-top: 24px;"),
      "utf8"
    );

    const result = await validateProject(root);
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_RAW_COLOR" && item.file === "components/cta/index.astro"));
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_RAW_SPACING" && item.file === "components/cta/index.astro"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("design lint rejects primitive token usage and unknown semantic tokens", async () => {
  const { temp, root } = await starter("site-spec-design-token-usage-");
  try {
    const header = join(root, "shell", "Header.astro");
    const source = await readFile(header, "utf8");
    await writeFile(
      header,
      source
        .replace("var(--color-border-default)", "var(--primitive-color-neutral200)")
        .replace("var(--space-stack-md)", "var(--space-does-not-exist)"),
      "utf8"
    );

    const result = await validateProject(root);
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_PRIMITIVE_TOKEN_USAGE" && item.file === "shell/Header.astro"));
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_UNKNOWN_TOKEN" && item.file === "shell/Header.astro"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("semantic tokens may not contain literal design values", async () => {
  const { temp, root } = await starter("site-spec-design-semantic-literal-");
  try {
    const file = join(root, "design", "tokens.json");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace('"{primitive.color.neutral900}"', '"#121212"'), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "DESIGN_SEMANTIC_LITERAL_FORBIDDEN");
    assert.ok(diagnostic);
    assert.equal(diagnostic.file, "design/tokens.json");
    assert.ok(diagnostic.suggestions?.some(item => item.action === "alias-primitive-token" && item.command === "npm run site -- spec design --json"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("design lint blocks common styling escape hatches", async () => {
  const { temp, root } = await starter("site-spec-design-escape-hatches-");
  try {
    const file = join(root, "shell", "Footer.astro");
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source
        .replace('<footer class="site-footer"', '<footer style="padding: 10px" class="site-footer"')
        .replace("<style>", '<link rel="stylesheet" href="/unsafe.css" />\n<style>\n  :root { --footer-gap: 24px; }'),
      "utf8"
    );

    const result = await validateProject(root);
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_INLINE_STYLE_FORBIDDEN" && item.file === "shell/Footer.astro"));
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_EXTERNAL_STYLESHEET_FORBIDDEN" && item.file === "shell/Footer.astro"));
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_LOCAL_CUSTOM_PROPERTY_FORBIDDEN" && item.file === "shell/Footer.astro"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

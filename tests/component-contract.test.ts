import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { addComponent } from "../packages/cli/src/add-component.ts";
import { loadProject } from "../packages/core/src/index.ts";
import { validateAstroComponentContracts } from "../packages/astro/src/index.ts";

async function projectWithStarter(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "acme");
  await initProject({ directory: root, name: "Acme" });
  return { temp, root };
}

test("npm run site -- add component creates a valid registered section scaffold", async () => {
  const { temp, root } = await projectWithStarter("site-spec-add-component-");
  try {
    const result = await addComponent({ root, id: "comparison-table", role: "content" });
    assert.deepEqual(result.files, [
      "components/comparison-table/component.yaml",
      "components/comparison-table/index.astro"
    ]);

    const project = await loadProject(root);
    assert.ok(project.registry.has("comparison-table"));
    assert.equal(project.registry.get("comparison-table")?.manifest.runtime?.javascript, false);

    const diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.deepEqual(diagnostics, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("npm run site -- add component refuses invalid ids and existing components", async () => {
  const { temp, root } = await projectWithStarter("site-spec-add-component-safe-");
  try {
    await assert.rejects(
      () => addComponent({ root, id: "Comparison Table" }),
      /Invalid component id/
    );
    await assert.rejects(
      () => addComponent({ root, id: "hero" }),
      /already exists/
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("component contract requires stable section identity markers", async () => {
  const { temp, root } = await projectWithStarter("site-spec-contract-identity-");
  try {
    const file = join(root, "components", "cta", "index.astro");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace(" data-theme={theme}", ""), "utf8");

    const project = await loadProject(root);
    const diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "COMPONENT_CONTRACT_IDENTITY_MISSING" && diagnostic.component === "cta"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("page-heading contract must match the Astro implementation", async () => {
  const { temp, root } = await projectWithStarter("site-spec-contract-heading-");
  try {
    const file = join(root, "components", "hero", "index.astro");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace("<h1>{props.title}</h1>", "<h2>{props.title}</h2>"), "utf8");

    const project = await loadProject(root);
    const diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "COMPONENT_CONTRACT_PAGE_HEADING_INVALID" && diagnostic.component === "hero"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("native images require alt attributes", async () => {
  const { temp, root } = await projectWithStarter("site-spec-contract-image-");
  try {
    const file = join(root, "components", "cta", "index.astro");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace("<h2>{props.title}</h2>", "<h2>{props.title}</h2>\n    <img src=\"/example.png\" />"), "utf8");

    const project = await loadProject(root);
    const diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "COMPONENT_CONTRACT_IMAGE_ALT_MISSING" && diagnostic.component === "cta"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("client JavaScript requires explicit runtime opt-in", async () => {
  const { temp, root } = await projectWithStarter("site-spec-contract-js-");
  try {
    const implementation = join(root, "components", "cta", "index.astro");
    await writeFile(implementation, `${await readFile(implementation, "utf8")}\n<script>console.log("enhance")</script>\n`, "utf8");

    let project = await loadProject(root);
    let diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "COMPONENT_CONTRACT_JAVASCRIPT_FORBIDDEN" && diagnostic.component === "cta"));

    const manifest = join(root, "components", "cta", "component.yaml");
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\nruntime:\n  javascript: true\n`, "utf8");

    project = await loadProject(root);
    diagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
    assert.ok(!diagnostics.some(diagnostic => diagnostic.code === "COMPONENT_CONTRACT_JAVASCRIPT_FORBIDDEN" && diagnostic.component === "cta"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

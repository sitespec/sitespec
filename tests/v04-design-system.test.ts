import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { buildProject } from "../packages/cli/src/build.ts";
import { installDesignSystem, packDesignSystem } from "../packages/cli/src/design-system.ts";
import { inspectDesignSystem, inspectProject, validateProject } from "../packages/core/src/index.ts";

async function starter(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "site");
  await initProject({ directory: root, name: "Design System Test" });
  return { temp, root };
}

async function missing(path: string): Promise<boolean> {
  try { await access(path); return false; } catch { return true; }
}

test("v0.4 starter exposes a first-class Design System contract", async () => {
  const { temp, root } = await starter("sitespec-v04-ds-contract-");
  try {
    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.specVersion, "0.4");
    assert.equal(validation.site?.designSystem?.id, "sitespec-default");
    assert.equal(validation.site?.designSystem?.theme, "default");
    assert.equal(validation.site?.designSystem?.shell, "default");

    const result = await inspectDesignSystem(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    const designSystem = result.designSystem as {
      id: string;
      contractVersion: string;
      portable: { format: string; runtimeDependency: boolean };
      tokens: { extension: string; rules: { primitive: string; semantic: string } };
      themes: { default: string; items: Array<{ id: string }> };
      libraries: { ui: Array<{ id: string }>; sections: Array<{ id: string }>; presets: Array<{ id: string }> };
      shells: { default: string; items: Array<{ id: string }> };
      layout: { convention: string };
    };
    assert.equal(designSystem.id, "sitespec-default");
    assert.equal(designSystem.contractVersion, "0.4");
    assert.deepEqual(designSystem.portable, { format: "copy", runtimeDependency: false, install: "sitespec design-system install <pack>", pack: "sitespec design-system pack <directory>" });
    assert.equal(designSystem.tokens.extension, "design/extensions.json");
    assert.deepEqual(designSystem.tokens.rules, { primitive: "additive", semantic: "additive" });
    assert.equal(designSystem.themes.default, "default");
    assert.deepEqual(designSystem.themes.items.map(item => item.id), ["dark", "default"]);
    assert.deepEqual(designSystem.libraries.ui.map(item => item.id), ["button", "container"]);
    assert.ok(designSystem.libraries.sections.some(item => item.id === "hero"));
    assert.deepEqual(designSystem.libraries.presets.map(item => item.id), ["final-cta"]);
    assert.equal(designSystem.shells.default, "default");
    assert.deepEqual(designSystem.shells.items.map(item => item.id), ["default"]);
    assert.equal(designSystem.layout.convention, "outer-gutter-inner-container");

    const viaSpec = await inspectProject(root, "design-system");
    assert.equal(viaSpec.type, "design-system");
    assert.equal((viaSpec.designSystem as { id: string }).id, "sitespec-default");
    const capabilities = (await inspectProject(root)).capabilities as Record<string, boolean>;
    assert.equal(capabilities.designSystemContract, true);
    assert.equal(capabilities.designSystemPacks, true);
    assert.equal(capabilities.shellPacks, true);
    assert.equal(capabilities.themes, true);
    assert.equal(capabilities.tokenExtensions, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("v0.4 rejects an exported preset whose section is outside the Design System section library", async () => {
  const { temp, root } = await starter("sitespec-v04-ds-preset-library-");
  try {
    const contractFile = join(root, "design-system.yaml");
    const contract = await readFile(contractFile, "utf8");
    await writeFile(contractFile, contract.replace("    - cta\n", ""), "utf8");

    const validation = await validateProject(root);
    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.some(item => item.code === "DESIGN_SYSTEM_PRESET_SECTION_NOT_EXPORTED" && item.actual === "cta"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("v0.4 additive token extensions compile into the site and themes override semantics", async () => {
  const { temp, root } = await starter("sitespec-v04-ds-theme-");
  try {
    await writeFile(join(root, "design", "extensions.json"), `${JSON.stringify({
      primitive: { color: { campaign: { $type: "color", $value: "#725cff" } } },
      semantic: { color: { campaign: { $type: "color", $value: "{primitive.color.campaign}" } } }
    }, null, 2)}\n`, "utf8");
    const siteFile = join(root, "site.yaml");
    const site = await readFile(siteFile, "utf8");
    await writeFile(siteFile, `${site}\ndesignSystem:\n  theme: dark\n`, "utf8");

    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.designSystem?.theme, "dark");

    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
    const css = await readFile(join(root, ".site", "astro", "src", "styles", "tokens.css"), "utf8");
    assert.match(css, /--primitive-color-campaign: #725cff;/);
    assert.match(css, /--color-campaign: var\(--primitive-color-campaign\);/);
    assert.match(css, /\[data-site-theme="dark"\] \{/);
    assert.match(css, /--color-surface-default:/);
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(html, /data-site-theme="dark"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("v0.4 token extension policy can lock primitive additions", async () => {
  const { temp, root } = await starter("sitespec-v04-ds-locked-");
  try {
    const contractFile = join(root, "design-system.yaml");
    const contract = await readFile(contractFile, "utf8");
    await writeFile(contractFile, contract.replace("primitive: additive", "primitive: locked"), "utf8");
    await writeFile(join(root, "design", "extensions.json"), `${JSON.stringify({
      primitive: { color: { campaign: { $type: "color", $value: "#725cff" } } }
    }, null, 2)}\n`, "utf8");

    const validation = await validateProject(root);
    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.some(item => item.code === "DESIGN_TOKEN_EXTENSION_PRIMITIVE_LOCKED" && item.file === "design/extensions.json"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("v0.4 sites can select a shell pack from the Design System", async () => {
  const { temp, root } = await starter("sitespec-v04-ds-shell-");
  try {
    await writeFile(join(root, "shell", "minimal.astro"), `---\nconst { site } = Astro.props;\n---\n<div data-shell-pack="minimal" data-site-id={site.id}><slot /></div>\n`, "utf8");
    const contractFile = join(root, "design-system.yaml");
    const contract = await readFile(contractFile, "utf8");
    await writeFile(contractFile, contract.replace(
      "      - shell/Footer.astro\n",
      "      - shell/Footer.astro\n    minimal:\n      entry: shell/minimal.astro\n      files:\n        - shell/minimal.astro\n"
    ), "utf8");
    const siteFile = join(root, "site.yaml");
    await writeFile(siteFile, `${await readFile(siteFile, "utf8")}\ndesignSystem:\n  shell: minimal\n`, "utf8");

    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.designSystem?.shellEntry, "shell/minimal.astro");
    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(html, /data-shell-pack="minimal"/);
    assert.doesNotMatch(html, /data-site-shell="header"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Design System pack validation rejects dependencies on site-owned token extensions", async () => {
  const { temp, root } = await starter("sitespec-v04-ds-portable-");
  const pack = join(temp, "pack");
  try {
    await writeFile(join(root, "design", "extensions.json"), `${JSON.stringify({
      primitive: { space: { portableGap: { $type: "dimension", $value: "2rem" } } },
      semantic: { space: { portableGap: { $type: "dimension", $value: "{primitive.space.portableGap}" } } }
    }, null, 2)}\n`, "utf8");
    const contractFile = join(root, "design-system.yaml");
    const contract = await readFile(contractFile, "utf8");
    await writeFile(contractFile, contract.replace("sectionSpacing: space.section", "sectionSpacing: space.portableGap"), "utf8");

    const sourceInspection = await inspectDesignSystem(root);
    assert.equal(sourceInspection.valid, true, JSON.stringify(sourceInspection.diagnostics, null, 2));
    await assert.rejects(() => packDesignSystem({ root, directory: pack }), /DESIGN_SYSTEM_LAYOUT_TOKEN_UNKNOWN/);
    assert.equal(await missing(pack), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Design System packs copy source into another v0.4 site without a runtime dependency", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-v04-ds-pack-"));
  const source = join(temp, "source-site");
  const target = join(temp, "target-site");
  const pack = join(temp, "inappstory-design-system");
  try {
    await initProject({ directory: source, name: "Source" });
    await initProject({ directory: target, name: "Target" });

    const contractFile = join(source, "design-system.yaml");
    const contract = await readFile(contractFile, "utf8");
    await writeFile(contractFile, contract
      .replace("id: sitespec-default", "id: inappstory")
      .replace("name: SiteSpec Default", "name: InAppStory")
      .replace("version: 1.0.0", "version: 1.2.3"), "utf8");

    const extension = `${JSON.stringify({
      primitive: { color: { targetBrand: { $type: "color", $value: "#654cff" } } },
      semantic: { color: { targetBrand: { $type: "color", $value: "{primitive.color.targetBrand}" } } }
    }, null, 2)}\n`;
    await writeFile(join(target, "design", "extensions.json"), extension, "utf8");

    const packed = await packDesignSystem({ root: source, directory: pack });
    assert.equal(packed.id, "inappstory");
    assert.equal(packed.version, "1.2.3");
    assert.ok(packed.files.includes("design-system.yaml"));
    assert.ok(packed.files.includes("ui/button/ui.yaml"));
    assert.ok(packed.files.includes("components/hero/component.yaml"));
    assert.ok(packed.files.includes("shell/default.astro"));
    assert.ok(packed.files.includes("design/themes/dark.json"));
    assert.ok(packed.files.includes("public/fonts/Inter-Regular.woff2"));
    assert.ok(packed.files.includes("public/fonts/LICENSE.txt"));
    assert.equal(await missing(join(pack, "site.yaml")), true);
    assert.equal(await missing(join(pack, "pages", "home.yaml")), true);
    assert.equal(await missing(join(pack, "content", "posts", "collection.yaml")), true);
    assert.equal(await missing(join(pack, "design", "extensions.json")), true);

    const packedInspection = await inspectDesignSystem(pack);
    assert.equal(packedInspection.valid, true, JSON.stringify(packedInspection.diagnostics, null, 2));

    const installed = await installDesignSystem({ root: target, source: pack, replace: true });
    assert.equal(installed.id, "inappstory");
    assert.equal(await readFile(join(target, "design", "extensions.json"), "utf8"), extension);
    const targetInspection = await inspectDesignSystem(target);
    assert.equal((targetInspection.designSystem as { id: string }).id, "inappstory");
    const validation = await validateProject(target);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.designSystem?.id, "inappstory");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

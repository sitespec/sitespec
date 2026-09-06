import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

test("sitespec init creates the required favicon contract", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-assets-init-"));
  const root = join(temp, "acme");
  try {
    const initialized = await initProject({ directory: root, name: "Acme" });
    assert.ok(initialized.files.includes("public/brand/favicon.svg"));
    assert.ok(initialized.files.includes("public/brand/apple-touch-icon.png"));
    assert.ok(initialized.files.includes("public/brand/og-default.png"));

    const siteYaml = await readFile(join(root, "site.yaml"), "utf8");
    assert.match(siteYaml, /assets:\n  favicon: \/brand\/favicon\.svg\n  appleTouchIcon: \/brand\/apple-touch-icon\.png\n  defaultOgImage: \/brand\/og-default\.png/);

    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.site?.assets.favicon, "/brand/favicon.svg");
    assert.equal(result.site?.assets.appleTouchIcon, "/brand/apple-touch-icon.png");
    assert.equal(result.site?.assets.defaultOgImage, "/brand/og-default.png");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing favicon file is a deterministic asset error", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-assets-missing-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    await unlink(join(root, "public", "brand", "favicon.svg"));

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "ASSET_NOT_FOUND");
    assert.ok(diagnostic);
    assert.equal(diagnostic.path, "/assets/favicon");
    assert.equal(diagnostic.actual, "/brand/favicon.svg");
    assert.ok(diagnostic.suggestions?.some(item => item.action === "create-asset" && item.file === "public/brand/favicon.svg"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("favicon format is constrained by the current contract", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-assets-format-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    await writeFile(join(root, "public", "brand", "favicon.txt"), "not an image", "utf8");
    const siteFile = join(root, "site.yaml");
    const source = await readFile(siteFile, "utf8");
    await writeFile(siteFile, source.replace("/brand/favicon.svg", "/brand/favicon.txt"), "utf8");

    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "ASSET_FORMAT_UNSUPPORTED");
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.allowed, [".ico", ".png", ".svg"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("defaultOgImage becomes the absolute Open Graph fallback", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-assets-og-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.site?.pages[0]?.seo.openGraph.image, "https://acme.test/brand/og-default.png");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("site spec assets exposes the agent-facing asset contract", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-assets-inspect-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    const result = await inspectProject(root, "assets");
    assert.equal(result.type, "assets");
    const assets = result.assets as {
      publicDirectory: string;
      values: { favicon: string; appleTouchIcon?: string; defaultOgImage?: string };
      contract: { favicon: { required: boolean }; appleTouchIcon: { required: boolean }; defaultOgImage: { required: boolean } };
    };
    assert.equal(assets.publicDirectory, "public/");
    assert.equal(assets.values.favicon, "/brand/favicon.svg");
    assert.equal(assets.values.appleTouchIcon, "/brand/apple-touch-icon.png");
    assert.equal(assets.values.defaultOgImage, "/brand/og-default.png");
    assert.equal(assets.contract.favicon.required, true);
    assert.equal(assets.contract.appleTouchIcon.required, false);
    assert.equal(assets.contract.defaultOgImage.required, false);

    const agent = result.agent as { assets: { inspect: string; faviconRequired: boolean } };
    assert.equal(agent.assets.inspect, "npm run site -- spec assets --json");
    assert.equal(agent.assets.faviconRequired, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

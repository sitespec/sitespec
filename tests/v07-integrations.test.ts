import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { buildProject } from "../packages/cli/src/build.ts";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

async function integratedSite(): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-v07-integrations-"));
  const root = join(temp, "site");
  await initProject({ directory: root, name: "Integrated Site" });
  const siteFile = join(root, "site.yaml");
  const source = await readFile(siteFile, "utf8");
  await writeFile(siteFile, `${source}\nintegrations:\n  googleAnalytics:\n    measurementId: G-ABC123XYZ\n  hubspot:\n    portalId: "1234567"\n`, "utf8");
  return { temp, root };
}

test("v0.7 resolves and renders Google Analytics and HubSpot", async () => {
  const { temp, root } = await integratedSite();
  try {
    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.deepEqual(validation.site?.integrations, {
      googleAnalytics: { measurementId: "G-ABC123XYZ" },
      hubspot: { portalId: "1234567" }
    });

    const inspection = await inspectProject(root, "integrations");
    assert.equal(inspection.type, "integrations");
    assert.deepEqual((inspection.integrations as { config: unknown }).config, validation.site?.integrations);

    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(html, /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-ABC123XYZ/);
    assert.match(html, /gtag\('config',"G-ABC123XYZ"\)/);
    assert.match(html, /https:\/\/js\.hs-scripts\.com\/1234567\.js/);
    assert.match(html, /id="hs-script-loader"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("integration identifiers are strict and integrations require v0.7", async () => {
  const { temp, root } = await integratedSite();
  try {
    const siteFile = join(root, "site.yaml");
    const source = await readFile(siteFile, "utf8");
    await writeFile(siteFile, source.replace("G-ABC123XYZ", "UA-legacy"), "utf8");
    const invalidId = await validateProject(root);
    assert.equal(invalidId.valid, false);
    assert.ok(invalidId.diagnostics.some(item => item.code === "SITE_SCHEMA_INVALID"));

    await writeFile(siteFile, source.replace('specVersion: "0.7"', 'specVersion: "0.6"'), "utf8");
    const oldVersion = await validateProject(root);
    assert.equal(oldVersion.valid, false);
    assert.ok(oldVersion.diagnostics.some(item => item.code === "V07_FEATURE_REQUIRES_SPEC_VERSION"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

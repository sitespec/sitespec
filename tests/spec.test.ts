import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "..", "fixtures", name);

test("valid-minimal resolves into a deterministic site model", async () => {
  const result = await validateProject(fixture("valid-minimal"));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
  assert.ok(result.site);
  assert.equal(result.site.pages.length, 2);
  assert.equal(result.site.assets.favicon, "/brand/favicon.svg");
  const home = result.site.pages.find(page => page.id === "home");
  assert.ok(home);
  assert.equal(home.seo.title, "Home — Acme");
  assert.equal(home.seo.canonical, "https://acme.test");
  assert.equal(home.sections[0]?.variant, "split");
  assert.equal(home.sections[0]?.theme, "default");
});

test("unknown component prop is rejected", async () => {
  const result = await validateProject(fixture("invalid-unknown-prop"));
  assert.equal(result.valid, false);
  const diagnostic = result.diagnostics.find(d => d.code === "COMPONENT_PROP_UNKNOWN");
  assert.ok(diagnostic);
  assert.equal(diagnostic.component, "hero");
  assert.match(diagnostic.message, /potato/);
});

test("content validation error preserves content provenance", async () => {
  const result = await validateProject(fixture("invalid-content"));
  assert.equal(result.valid, false);
  const diagnostic = result.diagnostics.find(d => d.code === "COMPONENT_PROP_INVALID" && d.sourceFile);
  assert.ok(diagnostic);
  assert.equal(diagnostic.sourceFile, "content/features/home.yaml");
  assert.equal(diagnostic.sourcePath, "/1/text");
});

test("site spec inspection exposes agent capabilities", async () => {
  const result = await inspectProject(fixture("valid-minimal"));
  assert.equal(result.valid, true);
  const capabilities = result.capabilities as Record<string, unknown>;
  assert.equal(capabilities.dynamicRoutes, false);
  assert.equal(capabilities.inlineStyles, false);
  assert.equal(capabilities.semanticSiteAssets, true);
  assert.equal(capabilities.localWebFonts, true);
  const components = result.components as Array<{ id: string }>;
  assert.ok(components.some(component => component.id === "hero"));
});

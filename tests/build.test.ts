import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { buildProject } from "../packages/cli/src/build.ts";
import { validateProject } from "../packages/core/src/index.ts";

test("sitespec init creates a valid starter project", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-init-"));
  const root = join(temp, "acme");
  try {
    const initialized = await initProject({ directory: root, name: "Acme" });
    assert.equal(initialized.id, "acme");
    assert.ok(initialized.files.includes("site.yaml"));
    assert.ok(initialized.files.includes("components/hero/index.astro"));
    assert.ok(initialized.files.includes("shell/default.astro"));
    assert.ok(initialized.files.includes("shell/Header.astro"));
    assert.ok(initialized.files.includes("shell/Footer.astro"));
    assert.ok(initialized.files.includes("public/brand/favicon.svg"));
    assert.ok(initialized.files.includes("public/brand/apple-touch-icon.png"));
    assert.ok(initialized.files.includes("public/brand/og-default.png"));
    assert.ok(initialized.files.includes("design/fonts.yaml"));
    assert.ok(initialized.files.includes("public/fonts/Andika-Regular.woff2"));
    assert.ok(initialized.files.includes("public/fonts/LICENSE.txt"));
    assert.ok(initialized.files.includes("components/pagination/component.yaml"));
    assert.ok(initialized.files.includes("pages/feature.yaml"));

    const header = await readFile(join(root, "shell", "Header.astro"), "utf8");
    assert.match(header, /position: sticky;/);
    assert.match(header, /top: 0;/);
    assert.match(header, /padding-inline: var\(--space-page\);/);
    assert.match(header, /max-width: var\(--size-content\);/);
    assert.match(header, /padding-block: var\(--space-stack-md\);/);

    const footer = await readFile(join(root, "shell", "Footer.astro"), "utf8");
    assert.match(footer, /padding-inline: var\(--space-page\);/);
    assert.match(footer, /max-width: var\(--size-content\);/);
    assert.match(footer, /padding-block: var\(--space-stack-xl\);/);

    const home = await readFile(join(root, "pages", "home.yaml"), "utf8");
    assert.match(home, /label: Explore the v0\.2 features/);
    assert.match(home, /href: \/features/);

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /Shell layout convention/);
    assert.match(agents, /starter header is sticky by default/);

    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.pages.length, 6);
    assert.deepEqual(validation.site?.pages.map(page => page.route), [
      "/",
      "/examples",
      "/features",
      "/features/agent-protocol",
      "/features/composition",
      "/features/dynamic-routes"
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("sitespec init refuses to overwrite a non-empty directory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-init-safe-"));
  try {
    await writeFile(join(temp, "keep.txt"), "keep", "utf8");
    await assert.rejects(
      () => initProject({ directory: temp }),
      /non-empty directory/
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("npm run build renders a static Astro site", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-build-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(result.pages, [
      "/",
      "/examples",
      "/features",
      "/features/agent-protocol",
      "/features/composition",
      "/features/dynamic-routes"
    ]);

    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(html, /<title>Home — Acme<\/title>/);
    assert.match(html, /data-component="hero"/);
    assert.match(html, /data-section="features"/);
    assert.match(html, /data-site-shell="header"/);
    assert.match(html, /data-site-shell="footer"/);
    assert.match(html, /href="https:\/\/github\.com\/sitespec\/sitespec"/);
    assert.match(html, />View on GitHub<\/a>/);
    assert.match(html, /<nav\b[^>]*\baria-label="Primary"[^>]*>/);
    assert.match(html, /<nav\b[^>]*\baria-label="Footer"[^>]*>/);
    assert.match(html, /<link rel="icon" href="\/brand\/favicon\.svg"\s*\/?>/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/brand\/apple-touch-icon\.png"\s*\/?>/);
    assert.match(html, /<meta property="og:image" content="https:\/\/acme\.test\/brand\/og-default\.png"\s*\/?>/);
    assert.doesNotMatch(html, /<script\b/i, "starter build should ship no client JavaScript");

    const favicon = await readFile(join(root, "dist", "brand", "favicon.svg"), "utf8");
    assert.match(favicon, /<svg/);
    assert.ok((await readFile(join(root, "dist", "brand", "apple-touch-icon.png"))).length > 0);
    assert.ok((await readFile(join(root, "dist", "brand", "og-default.png"))).length > 0);
    assert.ok((await readFile(join(root, "dist", "fonts", "Andika-Regular.woff2"))).length > 0);

    const fontsCss = await readFile(join(root, ".site", "astro", "src", "styles", "fonts.css"), "utf8");
    assert.match(fontsCss, /font-family: "Andika";/);
    assert.match(fontsCss, /url\("\/fonts\/Andika-Regular\.woff2"\) format\("woff2"\)/);

    const sitemap = await readFile(join(root, "dist", "sitemap.xml"), "utf8");
    assert.match(sitemap, /https:\/\/acme\.test/);

    const robots = await readFile(join(root, "dist", "robots.txt"), "utf8");
    assert.match(robots, /Sitemap: https:\/\/acme\.test\/sitemap\.xml/);

    const resolved = JSON.parse(await readFile(join(root, ".site", "resolved.json"), "utf8"));
    assert.equal(resolved.site.id, "acme");
    assert.equal(resolved.assets.favicon, "/brand/favicon.svg");
    assert.equal(resolved.assets.appleTouchIcon, "/brand/apple-touch-icon.png");
    assert.equal(resolved.assets.defaultOgImage, "/brand/og-default.png");
    assert.equal(resolved.navigation.primary[0].id, "home");
    assert.equal(resolved.navigation.features[0].id, "composition");
    assert.equal(resolved.navigation.project[0].id, "github");
    assert.equal(resolved.pages[0].sections[0].component, "hero");

    const buildState = JSON.parse(await readFile(join(root, ".site", "build.json"), "utf8"));
    assert.equal(buildState.version, "0.2");
    assert.match(buildState.sourceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(buildState.pages, [
      "/",
      "/examples",
      "/features",
      "/features/agent-protocol",
      "/features/composition",
      "/features/dynamic-routes"
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("npm run build materializes v0.2 dynamic routes into static HTML", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-build-dynamic-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    await writeFile(join(root, "pages", "product.yaml"), `specVersion: "0.2"
page:
  id: product
  route: /products/[slug]
  archetype: detail
  paths:
    - slug: stories
    - slug: banners
seo:
  title: "Product {slug}"
  description: "Learn about {slug}."
sections:
  - id: intro
    use: hero
    props:
      eyebrow: Product
      title:
        $ref: param:slug
`, "utf8");

    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
    assert.ok(result.pages.includes("/products/banners"));
    assert.ok(result.pages.includes("/products/stories"));
    assert.ok(result.pages.includes("/features/composition"));

    const stories = await readFile(join(root, "dist", "products", "stories", "index.html"), "utf8");
    assert.match(stories, /<title>Product stories — Acme<\/title>/);
    assert.match(stories, />stories<\/h1>/);

    const sitemap = await readFile(join(root, "dist", "sitemap.xml"), "utf8");
    assert.match(sitemap, /https:\/\/acme\.test\/products\/stories/);
    assert.match(sitemap, /https:\/\/acme\.test\/products\/banners/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("build canonicalizes a symlinked project root before invoking Astro", { skip: process.platform === "win32" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-spec-build-symlink-"));
  const realRoot = join(temp, "real-acme");
  const linkedRoot = join(temp, "linked-acme");
  try {
    await initProject({ directory: realRoot, name: "Acme" });
    await symlink(realRoot, linkedRoot, "dir");

    const result = await buildProject(linkedRoot);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));

    const html = await readFile(join(realRoot, "dist", "index.html"), "utf8");
    assert.match(html, /data-component="hero"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


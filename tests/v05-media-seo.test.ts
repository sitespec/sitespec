import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { buildProject } from "../packages/cli/src/build.ts";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

async function starter(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "site");
  await initProject({ directory: root, name: "Media SEO" });
  return { temp, root };
}

test("v0.5 exposes media and SEO capabilities in the resolved contract", async () => {
  const { temp, root } = await starter("sitespec-v05-contract-");
  try {
    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.specVersion, "0.5");
    assert.deepEqual(validation.site?.media.formats, ["avif", "webp"]);
    assert.equal(validation.site?.generated.media, true);
    assert.equal(validation.site?.generated.llms, true);
    assert.equal(validation.site?.generated.rss, true);
    assert.equal(validation.site?.generated.socialImages, true);

    const inspection = await inspectProject(root);
    const capabilities = inspection.capabilities as Record<string, boolean>;
    assert.equal(capabilities.mediaPipeline, true);
    assert.equal(capabilities.responsiveImages, true);
    assert.equal(capabilities.generatedSocialImages, true);
    assert.equal(capabilities.hreflang, true);
    assert.equal(capabilities.llmsTxt, true);
    assert.equal(capabilities.rss, true);

    const mediaInspection = await inspectProject(root, "media");
    assert.equal(mediaInspection.type, "media");
    assert.equal((mediaInspection.media as { renderer: string }).renderer, "@site-generated/components/SiteImage.astro");
    const seoInspection = await inspectProject(root, "seo");
    assert.equal(seoInspection.type, "seo");
    assert.equal((seoInspection.seo as { generated: { llms: boolean } }).generated.llms, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("v0.5 rejects local image props without accessible alt text", async () => {
  const { temp, root } = await starter("sitespec-v05-alt-");
  try {
    const homeFile = join(root, "pages", "home.yaml");
    const home = await readFile(homeFile, "utf8");
    await writeFile(homeFile, home.replace("        alt: Abstract SiteSpec media pipeline preview\n", ""), "utf8");
    const validation = await validateProject(root);
    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.some(item => item.code === "MEDIA_ALT_MISSING" && item.page === "home"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("v0.5 validates reciprocal internal hreflang and emits sitemap alternates", async () => {
  const { temp, root } = await starter("sitespec-v05-hreflang-");
  try {
    const homeFile = join(root, "pages", "home.yaml");
    const home = await readFile(homeFile, "utf8");
    await writeFile(homeFile, home.replace(
      "  description: A compact SiteSpec v0.5 starter demonstrating composition and typed content end to end.\n",
      "  description: A compact SiteSpec v0.5 starter demonstrating composition and typed content end to end.\n  hreflang:\n    en: /\n    lv: /lv\n"
    ), "utf8");
    await writeFile(join(root, "pages", "lv.yaml"), `specVersion: "0.5"
page:
  id: lv
  route: /lv
  archetype: marketing
  locale: lv
seo:
  title: Sākums
  description: SiteSpec demonstrācijas lapa latviešu valodā.
  hreflang:
    en: /
    lv: /lv
sections:
  - id: intro
    use: hero
    props:
      title: SiteSpec latviski
`, "utf8");

    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));

    const homeHtml = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(homeHtml, /hreflang="lv" href="https:\/\/site\.test\/lv"/);
    const lvHtml = await readFile(join(root, "dist", "lv", "index.html"), "utf8");
    assert.match(lvHtml, /<html lang="lv"/);
    assert.match(lvHtml, /hreflang="en" href="https:\/\/site\.test"/);

    const sitemap = await readFile(join(root, "dist", "sitemap.xml"), "utf8");
    assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    assert.match(sitemap, /xhtml:link rel="alternate" hreflang="lv" href="https:\/\/site\.test\/lv"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("marketing example exercises the complete v0.5 media and SEO contract", async () => {
  const root = join(process.cwd(), "examples", "marketing");
  const dist = join(root, "dist");
  const generated = join(root, ".site");
  await rm(dist, { recursive: true, force: true });
  await rm(generated, { recursive: true, force: true });

  try {
    const validation = await validateProject(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
    assert.equal(validation.site?.specVersion, "0.5");
    assert.deepEqual(validation.site?.media.formats, ["avif", "webp"]);

    const routes = validation.site!.pages.map(page => page.route);
    for (const route of ["/about", "/lv/about", "/preview"]) {
      assert.ok(routes.includes(route), `missing ${route}`);
    }

    const home = validation.site!.pages.find(page => page.route === "/")!;
    assert.equal(home.seo.socialImage?.generated, true);
    assert.ok(home.structuredData.some(node => node.type === "WebApplication"));

    const blog = validation.site!.pages.find(page => page.route === "/blog")!;
    assert.equal(blog.seo.openGraph.image, "https://example.test/brand/og-default.png");
    assert.equal(blog.seo.socialImage?.generated, undefined);

    const preview = validation.site!.pages.find(page => page.route === "/preview")!;
    assert.equal(preview.seo.noindex, true);
    assert.equal(preview.seo.socialImage?.generated, undefined);

    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));

    const homeHtml = await readFile(join(dist, "index.html"), "utf8");
    assert.match(homeHtml, /<picture\b[^>]*>/);
    assert.match(homeHtml, /type="image\/avif"[^>]+srcset="[^"]*\/_media\//);
    assert.match(homeHtml, /type="image\/webp"[^>]+srcset="[^"]*\/_media\//);
    assert.match(homeHtml, /<meta property="og:image" content="https:\/\/example\.test\/_social\/home-[a-f0-9]{10}\.png"/);
    assert.match(homeHtml, /"@type":"WebApplication"/);

    const blogHtml = await readFile(join(dist, "blog", "index.html"), "utf8");
    assert.match(blogHtml, /<meta property="og:image" content="https:\/\/example\.test\/brand\/og-default\.png"/);

    const postHtml = await readFile(join(dist, "blog", "typed-relations", "index.html"), "utf8");
    assert.match(postHtml, /"@type":"BlogPosting"/);
    assert.match(postHtml, /"@type":"Person"/);

    const aboutHtml = await readFile(join(dist, "about", "index.html"), "utf8");
    assert.match(aboutHtml, /hreflang="lv" href="https:\/\/example\.test\/lv\/about"/);
    assert.match(aboutHtml, /hreflang="x-default" href="https:\/\/example\.test\/about"/);

    const aboutLvHtml = await readFile(join(dist, "lv", "about", "index.html"), "utf8");
    assert.match(aboutLvHtml, /<html lang="lv"/);
    assert.match(aboutLvHtml, /hreflang="en" href="https:\/\/example\.test\/about"/);

    const previewHtml = await readFile(join(dist, "preview", "index.html"), "utf8");
    assert.match(previewHtml, /<meta name="robots" content="noindex, nofollow"/);

    const sitemap = await readFile(join(dist, "sitemap.xml"), "utf8");
    assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    assert.match(sitemap, /hreflang="lv" href="https:\/\/example\.test\/lv\/about"/);
    assert.doesNotMatch(sitemap, /https:\/\/example\.test\/preview/);

    const robots = await readFile(join(dist, "robots.txt"), "utf8");
    assert.match(robots, /Disallow: \/preview/);
    assert.match(robots, /Sitemap: https:\/\/example\.test\/sitemap\.xml/);

    const llms = await readFile(join(dist, "llms.txt"), "utf8");
    assert.match(llms, /# SiteSpec v0\.5 Example/);
    assert.doesNotMatch(llms, /\[Preview\]/);

    const rss = await readFile(join(dist, "rss.xml"), "utf8");
    assert.match(rss, /<rss version="2\.0"/);
    assert.match(rss, /Relations are ordinary collection fields/);

    const mediaFiles = await readdir(join(dist, "_media"), { recursive: true });
    assert.ok(mediaFiles.some(file => file.endsWith(".avif")));
    assert.ok(mediaFiles.some(file => file.endsWith(".webp")));

    const socialFiles = await readdir(join(dist, "_social"));
    assert.ok(socialFiles.some(file => /^home-[a-f0-9]{10}\.png$/.test(file)));
  } finally {
    await rm(dist, { recursive: true, force: true });
    await rm(generated, { recursive: true, force: true });
  }
});

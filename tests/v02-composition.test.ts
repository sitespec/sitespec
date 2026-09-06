import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultSite } from "../packages/template/src/index.ts";
import { inspectProject, loadProject, validateProject } from "../packages/core/src/index.ts";
import { addUi } from "../packages/cli/src/add-ui.ts";
import { addComponent } from "../packages/cli/src/add-component.ts";
import { validateAstroComponentContracts } from "../packages/astro/src/index.ts";

async function withSite(run: (root: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-v02-"));
  const root = join(temp, "acme");
  try {
    await createDefaultSite({ directory: root, name: "Acme", cliVersion: "0.1.1" });
    await run(root);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("v0.3 starter exposes composition and typed content", async () => {
  await withSite(async root => {
    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.site?.specVersion, "0.3");
    const home = result.site?.pages.find(page => page.id === "home");
    assert.ok(home);
    assert.equal(home.sections.at(-1)?.preset, "section:final-cta");
    assert.deepEqual(result.site?.pages.map(page => page.route), [
      "/",
      "/blog",
      "/blog/content-driven",
      "/blog/hello-sitespec",
      "/blog/page/2",
      "/features",
      "/features/agent-protocol",
      "/features/composition",
      "/features/dynamic-routes"
    ]);
    for (const route of ["/", "/features", "/features/agent-protocol", "/features/composition", "/features/dynamic-routes"]) {
      const page = result.site?.pages.find(item => item.route === route);
      assert.equal(page?.sections.at(-1)?.preset, "section:final-cta");
    }

    const blog = result.site?.pages.find(page => page.route === "/blog");
    assert.equal(blog?.sections.at(-1)?.component, "pagination");
    assert.deepEqual(blog?.sections.at(-1)?.props, {
      currentPage: 1,
      totalPages: 2,
      nextHref: "/blog/page/2",
      pages: [
        { page: 1, href: "/blog", current: true },
        { page: 2, href: "/blog/page/2", current: false }
      ]
    });
    const firstItems = blog?.sections.find(section => section.id === "posts")?.props.items as Array<{ id: string; href: string }>;
    assert.deepEqual(firstItems.map(item => item.id), ["content-driven"]);
    assert.deepEqual(firstItems.map(item => item.href), ["/blog/content-driven"]);

    const blogPage2 = result.site?.pages.find(page => page.route === "/blog/page/2");
    assert.deepEqual(blogPage2?.sections.at(-1)?.props, {
      currentPage: 2,
      totalPages: 2,
      previousHref: "/blog",
      pages: [
        { page: 1, href: "/blog", current: false },
        { page: 2, href: "/blog/page/2", current: true }
      ]
    });
    const secondItems = blogPage2?.sections.find(section => section.id === "posts")?.props.items as Array<{ id: string }>;
    assert.deepEqual(secondItems.map(item => item.id), ["hello-sitespec"]);

    const post = result.site?.pages.find(page => page.route === "/blog/content-driven");
    assert.equal(post?.sections[0]?.component, "article");
    assert.equal(post?.sections[0]?.props.title, "Content drives routes and listings");

    const inspection = await inspectProject(root);
    const capabilities = inspection.capabilities as Record<string, unknown>;
    assert.equal(capabilities.uiPrimitives, true);
    assert.equal(capabilities.sectionPresets, true);
    assert.equal(capabilities.dynamicRoutes, true);
    assert.equal(capabilities.routeParamReferences, true);
    assert.equal(capabilities.paginationCoreType, true);
    assert.equal(capabilities.typedContentCollections, true);
    assert.equal(capabilities.markdownEntries, true);
    assert.equal(capabilities.contentQueries, true);

    const content = inspection.content as Array<{ id: string; entries: Array<{ id: string }> }>;
    assert.deepEqual(content.map(item => item.id), ["posts"]);
    assert.equal(content[0]?.entries.length, 2);
    const ui = inspection.ui as Array<{ id: string }>;
    assert.deepEqual(ui.map(item => item.id).sort(), ["button", "container"]);
    const presets = inspection.sectionPresets as Array<{ reference: string }>;
    assert.ok(presets.some(item => item.reference === "section:final-cta"));
    const pages = inspection.pages as Array<{ id: string; dynamic: boolean; generatedRoutes: Array<{ route: string }> }>;
    const feature = pages.find(page => page.id === "feature");
    assert.equal(feature?.dynamic, true);
    assert.deepEqual(feature?.generatedRoutes.map(item => item.route), [
      "/features/agent-protocol",
      "/features/composition",
      "/features/dynamic-routes"
    ]);
    const navigation = inspection.navigation as Array<{ id: string }>;
    assert.deepEqual(navigation.map(item => item.id), ["features", "primary", "project"]);
    const assets = inspection.assets as { values: { appleTouchIcon?: string; defaultOgImage?: string } };
    assert.equal(assets.values.appleTouchIcon, "/brand/apple-touch-icon.png");
    assert.equal(assets.values.defaultOgImage, "/brand/og-default.png");
    const design = inspection.design as { fonts: { families: Array<{ id: string }> } };
    assert.deepEqual(design.fonts.families.map(item => item.id), ["inter"]);
  });
});

test("v0.3 starter keeps explicit dynamic routes and param refs", async () => {
  await withSite(async root => {
    await writeFile(join(root, "pages", "product.yaml"), `specVersion: "0.3"\npage:\n  id: product\n  route: /products/[slug]\n  archetype: detail\n  paths:\n    - slug: stories\n    - slug: banners\nseo:\n  title: "Product {slug}"\n  description: "Learn about {slug}."\nsections:\n  - id: intro\n    use: hero\n    props:\n      eyebrow: Product\n      title:\n        $ref: param:slug\n`, "utf8");

    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    const productPages = result.site!.pages.filter(page => page.templateId === "product");
    assert.deepEqual(productPages.map(page => page.route).sort(), ["/products/banners", "/products/stories"]);
    const stories = productPages.find(page => page.route === "/products/stories");
    assert.ok(stories);
    assert.equal(stories.params.slug, "stories");
    assert.equal(stories.sections[0]?.props.title, "stories");
    assert.equal(stories.seo.title, "Product stories — Acme");
    assert.equal(stories.seo.canonical, "https://acme.test/products/stories");

    const inspection = await inspectProject(root, "/products/stories");
    assert.equal(inspection.type, "page");
    const inspected = inspection.page as { dynamic: boolean; generatedRoutes: Array<{ route: string }> };
    assert.equal(inspected.dynamic, true);
    assert.equal(inspected.generatedRoutes.length, 2);
  });
});

test("v0.3 rejects incomplete dynamic route path parameters deterministically", async () => {
  await withSite(async root => {
    await writeFile(join(root, "pages", "product.yaml"), `specVersion: "0.3"\npage:\n  id: product\n  route: /products/[category]/[slug]\n  archetype: detail\n  paths:\n    - slug: stories\nseo:\n  title: Product\nsections:\n  - id: intro\n    use: hero\n    props:\n      title: Product\n`, "utf8");
    const result = await validateProject(root);
    assert.equal(result.valid, false);
    const diagnostic = result.diagnostics.find(item => item.code === "DYNAMIC_ROUTE_PARAMS_INVALID");
    assert.ok(diagnostic);
    assert.deepEqual(diagnostic.expected, ["category", "slug"]);
  });
});

test("Page Spec cannot use a UI primitive as a section", async () => {
  await withSite(async root => {
    await writeFile(join(root, "pages", "bad-ui.yaml"), `specVersion: "0.3"\npage:\n  id: bad-ui\n  route: /bad-ui\n  archetype: blank\nseo:\n  title: Bad UI\nsections:\n  - id: action\n    use: button\n    props: {}\n`, "utf8");
    const result = await validateProject(root);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(item => item.code === "SECTION_UI_PRIMITIVE_FORBIDDEN"));
  });
});

test("pagination is a valid v0.3 core prop type", async () => {
  await withSite(async root => {
    const dir = join(root, "components", "pager");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "component.yaml"), `specVersion: "0.3"\ncomponent:\n  id: pager\n  role: utility\nprops:\n  $ref: urn:site-spec:0.3:type:pagination\nruntime:\n  javascript: false\n`, "utf8");
    await writeFile(join(dir, "index.astro"), `---\ninterface Props { sectionId: string; variant: string; theme: string; props: { currentPage: number; totalPages: number } }\nconst { sectionId, variant, theme, props } = Astro.props;\n---\n<section id={sectionId} data-section={sectionId} data-component="pager" data-variant={variant} data-theme={theme}><p>{props.currentPage} / {props.totalPages}</p></section>\n`, "utf8");
    await writeFile(join(root, "pages", "paging.yaml"), `specVersion: "0.3"\npage:\n  id: paging\n  route: /paging\n  archetype: blank\nseo:\n  title: Paging\nsections:\n  - id: pagination\n    use: pager\n    props:\n      currentPage: 1\n      totalPages: 3\n      nextHref: /paging\n`, "utf8");
    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
  });
});

test("site add ui creates a formal primitive contract", async () => {
  await withSite(async root => {
    const added = await addUi({ root, id: "badge", role: "content" });
    assert.deepEqual(added.files, ["ui/badge/ui.yaml", "ui/badge/index.astro"]);
    const project = await loadProject(root);
    assert.ok(project.uiRegistry.has("badge"));
    const manifest = await readFile(join(root, "ui", "badge", "ui.yaml"), "utf8");
    assert.match(manifest, /specVersion: "0\.3"/);
  });
});



test("unused reusable section presets are still validated", async () => {
  await withSite(async root => {
    await writeFile(join(root, "sections", "broken.yaml"), `specVersion: "0.3"
section:
  use: does-not-exist
  variant: default
  props: {}
`, "utf8");
    const result = await validateProject(root);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(item => item.code === "SECTION_PRESET_COMPONENT_UNKNOWN" && item.file === "sections/broken.yaml"));
  });
});

test("v0.3 validates UI primitive implementation contracts", async () => {
  await withSite(async root => {
    const button = join(root, "ui", "button", "index.astro");
    const source = await readFile(button, "utf8");
    await writeFile(button, source.replace(' data-ui="button"', ''), "utf8");
    const project = await loadProject(root);
    const diagnostics = await validateAstroComponentContracts({
      root,
      registry: project.registry,
      uiRegistry: project.uiRegistry
    });
    assert.ok(diagnostics.some(item => item.code === "UI_CONTRACT_IDENTITY_MISSING"));
  });
});

test("component scaffolding remains compatible with v0.1 projects while UI primitives require v0.2", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-v01-compat-"));
  const root = join(temp, "acme");
  try {
    await cp(join(process.cwd(), "fixtures", "valid-minimal"), root, { recursive: true });
    await addComponent({ root, id: "comparison-table", role: "content" });
    const manifest = await readFile(join(root, "components", "comparison-table", "component.yaml"), "utf8");
    assert.match(manifest, /specVersion: "0\.1"/);
    await assert.rejects(
      () => addUi({ root, id: "badge", role: "content" }),
      /UI primitives require specVersion: "0\.2"/
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

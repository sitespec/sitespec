import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

async function upgradeYamlTree(root: string): Promise<void> {
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if ([".yaml", ".yml"].includes(extname(entry.name))) {
        const source = await readFile(path, "utf8");
        await writeFile(path, source.replaceAll('specVersion: "0.1"', 'specVersion: "0.3"').replaceAll("urn:site-spec:0.1:", "urn:site-spec:0.3:"), "utf8");
      }
    }
  }
  await visit(root);
}

async function withV03Site(run: (root: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-v03-"));
  const root = join(temp, "acme");
  try {
    await cp(join(process.cwd(), "fixtures", "valid-minimal"), root, { recursive: true });
    await upgradeYamlTree(root);
    await run(root);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeContentFixture(root: string): Promise<void> {
  await mkdir(join(root, "components", "article"), { recursive: true });
  await writeFile(join(root, "components", "article", "component.yaml"), `specVersion: "0.3"
component:
  id: article
  role: content
props:
  type: object
  additionalProperties: false
  required: [title, body, author]
  properties:
    title: { type: string }
    body:
      type: object
      required: [format, source, html]
      properties:
        format: { const: markdown }
        source: { type: string }
        html: { type: string }
    author:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
semantics:
  pageHeading: true
`, "utf8");

  await mkdir(join(root, "components", "post-list"), { recursive: true });
  await writeFile(join(root, "components", "post-list", "component.yaml"), `specVersion: "0.3"
component:
  id: post-list
  role: content
props:
  type: object
  additionalProperties: false
  required: [items]
  properties:
    items:
      type: array
      items:
        type: object
        required: [id, title, href]
        properties:
          id: { type: string }
          title: { type: string }
          href: { type: string }
          author: { type: object }
    pagination:
      $ref: urn:site-spec:0.3:type:pagination
`, "utf8");

  await mkdir(join(root, "content", "authors"), { recursive: true });
  await writeFile(join(root, "content", "authors", "collection.yaml"), `specVersion: "0.3"
collection:
  id: authors
entry:
  schema:
    type: object
    additionalProperties: false
    required: [name]
    properties:
      name: { type: string }
`, "utf8");
  await writeFile(join(root, "content", "authors", "pavel.yaml"), `name: Pavel
`, "utf8");

  await mkdir(join(root, "content", "categories"), { recursive: true });
  await writeFile(join(root, "content", "categories", "collection.yaml"), `specVersion: "0.3"
collection:
  id: categories
entry:
  schema:
    type: object
    additionalProperties: false
    required: [name]
    properties:
      name: { type: string }
`, "utf8");
  await writeFile(join(root, "content", "categories", "engineering.yaml"), `name: Engineering
`, "utf8");
  await writeFile(join(root, "content", "categories", "product.yaml"), `name: Product
`, "utf8");

  await mkdir(join(root, "content", "posts"), { recursive: true });
  await writeFile(join(root, "content", "posts", "collection.yaml"), `specVersion: "0.3"
collection:
  id: posts
entry:
  schema:
    type: object
    additionalProperties: false
    required: [title, description, author, categories]
    properties:
      title: { type: string }
      description: { type: string }
      author: { type: string }
      categories:
        type: array
        items: { type: string }
relations:
  author:
    collection: authors
  categories:
    collection: categories
    many: true
`, "utf8");

  const posts = [
    ["first", "2026-09-01", "First post", "engineering", "published"],
    ["second", "2026-09-02", "Second post", "product", "published"],
    ["third", "2026-09-03", "Third post", "engineering", "published"],
    ["draft-note", "2026-09-04", "Draft note", "engineering", "draft"]
  ] as const;
  for (const [slug, date, title, category, status] of posts) {
    await writeFile(join(root, "content", "posts", `${slug}.md`), `---
slug: ${slug}
date: ${date}
status: ${status}
title: ${title}
description: Description for ${slug}.
author: pavel
categories: [${category}]
---

# ${title}

This is **${slug}** with a [home link](/).
`, "utf8");
  }

  await writeFile(join(root, "pages", "post.yaml"), `specVersion: "0.3"
page:
  id: post
  route: /blog/[slug]
  archetype: article
content:
  entry: posts
seo:
  title: "{entry.title}"
  description: "{entry.description}"
sections:
  - id: article
    use: article
    props:
      title: { $ref: "entry:title" }
      body: { $ref: "entry:body" }
      author: { $ref: "entry:author" }
`, "utf8");

  await writeFile(join(root, "pages", "blog.yaml"), `specVersion: "0.3"
page:
  id: blog
  route: /blog
  archetype: blank
content:
  queries:
    posts:
      collection: posts
      sort:
        - field: date
          order: desc
      paginate:
        size: 2
        route: /blog/page/[page]
seo:
  title: Blog
  description: Blog posts.
sections:
  - id: posts
    use: post-list
    props:
      items: { $ref: "query:posts.items" }
      pagination: { $ref: "query:posts.pagination" }
`, "utf8");

  await writeFile(join(root, "pages", "category.yaml"), `specVersion: "0.3"
page:
  id: category
  route: /blog/category/[slug]
  archetype: blank
content:
  entry: categories
  queries:
    posts:
      collection: posts
      filter:
        - field: categories
          contains: { $ref: "entry:id" }
      sort:
        - field: date
          order: desc
seo:
  title: "{entry.name}"
  description: "Posts in {entry.name}."
sections:
  - id: posts
    use: post-list
    props:
      items: { $ref: "query:posts.items" }
`, "utf8");
}

test("v0.3 typed collections drive detail routes, relations, queries, pagination, drafts, and inspection", async () => {
  await withV03Site(async root => {
    await writeContentFixture(root);
    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.site?.specVersion, "0.3");

    const routes = result.site!.pages.map(page => page.route);
    for (const route of [
      "/blog",
      "/blog/page/2",
      "/blog/first",
      "/blog/second",
      "/blog/third",
      "/blog/draft-note",
      "/blog/category/engineering",
      "/blog/category/product"
    ]) assert.ok(routes.includes(route), `missing ${route}`);

    const post = result.site!.pages.find(page => page.route === "/blog/third")!;
    assert.equal(post.state, "published");
    assert.equal(post.seo.title, "Third post — Acme");
    assert.equal((post.sections[0]!.props.author as { name: string }).name, "Pavel");
    const body = post.sections[0]!.props.body as { format: string; html: string };
    assert.equal(body.format, "markdown");
    assert.match(body.html, /<h1>Third post<\/h1>/);
    assert.match(body.html, /<strong>third<\/strong>/);

    const draft = result.site!.pages.find(page => page.route === "/blog/draft-note")!;
    assert.equal(draft.state, "draft");

    const blog = result.site!.pages.find(page => page.route === "/blog")!;
    const blogItems = blog.sections[0]!.props.items as Array<{ id: string; href: string; author: { name: string } }>;
    assert.deepEqual(blogItems.map(item => item.id), ["third", "second"]);
    assert.deepEqual(blogItems.map(item => item.href), ["/blog/third", "/blog/second"]);
    assert.equal(blogItems[0]!.author.name, "Pavel");
    const blogPagination = blog.sections[0]!.props.pagination as { currentPage: number; totalPages: number; nextHref?: string };
    assert.deepEqual({ currentPage: blogPagination.currentPage, totalPages: blogPagination.totalPages, nextHref: blogPagination.nextHref }, {
      currentPage: 1, totalPages: 2, nextHref: "/blog/page/2"
    });

    const blog2 = result.site!.pages.find(page => page.route === "/blog/page/2")!;
    const secondPageItems = blog2.sections[0]!.props.items as Array<{ id: string }>;
    assert.deepEqual(secondPageItems.map(item => item.id), ["first"]);

    const engineering = result.site!.pages.find(page => page.route === "/blog/category/engineering")!;
    const engineeringItems = engineering.sections[0]!.props.items as Array<{ id: string }>;
    assert.deepEqual(engineeringItems.map(item => item.id), ["third", "first"]);

    const content = await inspectProject(root, "collection:posts");
    assert.equal(content.type, "content-collection");
    const collection = content.collection as { counts: { total: number; published: number; draft: number } };
    assert.deepEqual(collection.counts, { total: 4, published: 3, draft: 1 });

    const inspectedEntry = await inspectProject(root, "entry:posts/third");
    assert.equal(inspectedEntry.type, "content-entry");
    const entry = inspectedEntry.entry as { href: string; author: { id: string; name: string } };
    assert.equal(entry.href, "/blog/third");
    assert.deepEqual({ id: entry.author.id, name: entry.author.name }, { id: "pavel", name: "Pavel" });
  });
});

test("v0.3 reports broken relations with entry provenance", async () => {
  await withV03Site(async root => {
    await writeContentFixture(root);
    const post = join(root, "content", "posts", "first.md");
    const source = await readFile(post, "utf8");
    await writeFile(post, source.replace("author: pavel", "author: missing"), "utf8");
    const result = await validateProject(root);
    assert.equal(result.valid, false);
    const diagnostic = result.diagnostics.find(item => item.code === "CONTENT_RELATION_NOT_FOUND");
    if (!diagnostic) throw new Error("Expected CONTENT_RELATION_NOT_FOUND diagnostic");
    assert.equal(diagnostic.file, "content/posts/first.md");
    assert.equal(diagnostic.path, "/author");
  });
});

test("marketing example exercises the full v0.3 content surface", async () => {
  const root = join(process.cwd(), "examples", "marketing");
  const result = await validateProject(root);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.site?.specVersion, "0.3");

  const routes = result.site!.pages.map(page => page.route);
  for (const route of [
    "/",
    "/blog",
    "/blog/page/2",
    "/blog/page/3",
    "/blog/typed-relations",
    "/blog/roadmap-note",
    "/blog/author/maya",
    "/blog/category/engineering",
    "/blog/tag/content"
  ]) assert.ok(routes.includes(route), `missing ${route}`);

  const blog = result.site!.pages.find(page => page.route === "/blog")!;
  const blogItems = blog.sections.find(section => section.id === "posts")!.props.items as Array<{ id: string }>;
  assert.deepEqual(blogItems.map(item => item.id), ["inspect-content", "typed-relations"]);

  const blog3 = result.site!.pages.find(page => page.route === "/blog/page/3")!;
  const blog3Items = blog3.sections.find(section => section.id === "posts")!.props.items as Array<{ id: string }>;
  assert.deepEqual(blog3Items.map(item => item.id), ["intro-to-sitespec"]);

  const home = result.site!.pages.find(page => page.route === "/")!;
  const featured = home.sections.find(section => section.id === "featured")!.props.items as Array<{ id: string }>;
  assert.deepEqual(featured.map(item => item.id), [
    "typed-relations",
    "content-without-cms-runtime",
    "intro-to-sitespec"
  ]);

  const draft = result.site!.pages.find(page => page.route === "/blog/roadmap-note")!;
  assert.equal(draft.state, "draft");

  const detail = result.site!.pages.find(page => page.route === "/blog/typed-relations")!;
  const article = detail.sections.find(section => section.id === "article")!.props as {
    author: { id: string; href: string };
    categories: Array<{ id: string; href: string }>;
    tags: Array<{ id: string; href: string }>;
  };
  assert.equal(article.author.id, "maya");
  assert.equal(article.author.href, "/blog/author/maya");
  assert.equal(article.categories[0]!.id, "engineering");
  assert.equal(article.categories[0]!.href, "/blog/category/engineering");
  assert.deepEqual(article.tags.map(tag => [tag.id, tag.href]), [
    ["content", "/blog/tag/content"],
    ["sitespec", "/blog/tag/sitespec"]
  ]);

  const engineering = result.site!.pages.find(page => page.route === "/blog/category/engineering")!;
  const engineeringItems = engineering.sections.find(section => section.id === "posts")!.props.items as Array<{ id: string }>;
  assert.deepEqual(engineeringItems.map(item => item.id), [
    "typed-relations",
    "content-without-cms-runtime",
    "intro-to-sitespec"
  ]);

  const content = await inspectProject(root, "content");
  assert.equal(content.type, "content-index");
  const collections = content.collections as Array<{ id: string }>;
  assert.deepEqual(collections.map(collection => collection.id), ["authors", "categories", "posts", "tags"]);

  const inspectedDraft = await inspectProject(root, "entry:posts/roadmap-note");
  assert.equal(inspectedDraft.type, "content-entry");
  const entry = inspectedDraft.entry as { status: string; href: string };
  assert.equal(entry.status, "draft");
  assert.equal(entry.href, "/blog/roadmap-note");
});

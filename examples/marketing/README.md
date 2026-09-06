# SiteSpec v0.5 Marketing Example

Executable reference for the complete SiteSpec v0.5 contract.

Unlike the intentionally compact starter, this example is meant to make the current platform capabilities visible in source and verifiable in generated output:

- typed `posts`, `authors`, `categories`, and `tags` collections;
- Markdown entries plus YAML data entries and generic relations;
- `entry:` and `query:` references, filtering, sorting and pagination;
- content-driven post, author, category and tag routes;
- a portable Design System with sections, UI primitives, themes, shell packs and semantic tokens;
- local responsive media with generated AVIF/WebP derivatives, `srcset`, intrinsic dimensions, crop and focal point;
- generated canonical, Open Graph, Twitter and JSON-LD metadata;
- generated and explicit social-image scenarios;
- reciprocal `hreflang` with `x-default` on `/about` and `/lv/about`;
- a published `noindex` route at `/preview` that is excluded from sitemap and `llms.txt`;
- generated `sitemap.xml`, `robots.txt`, `llms.txt` and `rss.xml` in both dev and production build;
- draft detail routes available during development but excluded from published queries and production output.

## Run from the monorepo

From the repository root:

```bash
npm install
npm run build
npm run dev -w @sitespec/example-marketing
```

The dev server exposes the generated metadata endpoints directly, so these should return `200` while `sitespec dev` is running:

```text
http://127.0.0.1:4321/robots.txt
http://127.0.0.1:4321/sitemap.xml
http://127.0.0.1:4321/llms.txt
http://127.0.0.1:4321/rss.xml
```

Other useful commands:

```bash
npm run validate -w @sitespec/example-marketing
npm run build -w @sitespec/example-marketing
npm run preview -w @sitespec/example-marketing
npm run site -w @sitespec/example-marketing -- spec design-system --json
npm run site -w @sitespec/example-marketing -- spec content --json
npm run site -w @sitespec/example-marketing -- spec media --json
npm run site -w @sitespec/example-marketing -- spec seo --json
```

## Routes worth inspecting

```text
/
/about
/lv/about
/preview
/blog
/blog/page/2
/blog/page/3
/blog/typed-relations
/blog/author/maya
/blog/category/engineering
/blog/tag/content
```

`/blog/roadmap-note` is a draft entry: it is available for development and inspection but excluded from normal listings and production output.

The three social-image paths are intentionally different:

- `/` uses a generated per-page social image;
- `/blog` sets an explicit Open Graph image;
- `/preview` disables page social-image generation and is `noindex`.

## Generated production output

A successful build includes, in addition to static HTML:

```text
dist/
  _media/       responsive image derivatives
  _social/      generated page social images
  sitemap.xml
  robots.txt
  llms.txt
  rss.xml
```

## Inspection

```bash
npm run site -w @sitespec/example-marketing -- spec --json
npm run site -w @sitespec/example-marketing -- spec content --json
npm run site -w @sitespec/example-marketing -- spec media --json
npm run site -w @sitespec/example-marketing -- spec seo --json
npm run site -w @sitespec/example-marketing -- spec collection:posts --json
npm run site -w @sitespec/example-marketing -- spec collection:authors --json
npm run site -w @sitespec/example-marketing -- spec entry:posts/typed-relations --json
npm run site -w @sitespec/example-marketing -- spec /blog/category/engineering --json
```

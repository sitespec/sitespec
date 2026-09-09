# SiteSpec

SiteSpec is a deterministic, Git-native contract for building content-driven static websites with people and AI agents.

The source of truth is the repository: specs, content, design tokens, component contracts, and the Site Shell. `@sitespec/core` resolves that contract and the current Astro renderer produces static output. A runtime CMS is not required.

Figma and other design applications are optional; a separate design-handoff step is not part of the required workflow.

## Current format

The current document format is `specVersion: "0.5"`.

It supports:

- Page Specs, archetypes, SEO, static routes, and controlled section composition;
- typed Markdown/YAML/JSON content collections with schemas and draft state;
- generic relations between entries and collections;
- declarative filtering, deterministic sorting, and pagination;
- content-driven detail and taxonomy routes;
- `entry:` and `query:` references resolved before component validation;
- a first-class Design System contract with exported UI primitives, section libraries, shell packs, themes, layout conventions, semantic tokens, local fonts, and controlled site token extensions;
- a production media pipeline with responsive `srcset`, AVIF/WebP generation, intrinsic dimensions, crop/focal-point controls, and image validation;
- canonical/hreflang, Open Graph/Twitter metadata, JSON-LD, generated social images, sitemap, robots, `llms.txt`, and RSS without project-level Astro configuration;
- source/output validation and agent inspection through `site spec`;
- evidence-first existing-site migration: production audit, live DOM segmentation, multi-page Design System analysis, explicit foundation/UI/component/shell review, implementation inference, and non-destructive Design System staging;
- static Astro build, preview, and GitHub Pages deployment.

Content, relations, queries, routes, and final props are resolved in core. Astro is the rendering layer, not a second content runtime.

## Quick start

Requirements: Node.js 22+ and npm.

```bash
npm create @sitespec@latest acme
cd acme
npm run dev
```

Useful commands:

```bash
npm run validate
npm run build
npm run preview

npm run site -- spec --json
npm run site -- spec design-system --json
npm run site -- spec content --json
npm run site -- spec collection:posts --json
npm run site -- spec entry:posts/hello-world --json
npm run site -- migrate audit https://example.com/ --json
npm run site -- migrate segment .sitespec/audit/example.com/home
# inspector: drag/collapse, name blocks, reload production without losing selections
npm run site -- migrate design .sitespec/audit/example.com/home .sitespec/audit/example.com/second-page --json
npm run site -- migrate components review .sitespec/migration/example.com/design
npm run site -- migrate components contracts .sitespec/migration/example.com/design/component-review.json
npm run site -- migrate shell contracts .sitespec/migration/example.com/design/component-review.json
npm run site -- migrate ui review .sitespec/migration/example.com/design
npm run site -- migrate ui contracts .sitespec/migration/example.com/design/ui-review.json
npm run site -- migrate foundation review .sitespec/migration/example.com/design
npm run site -- migrate foundation materialize .sitespec/migration/example.com/design/foundation-review.json
npm run site -- migrate implementations infer .sitespec/migration/example.com/design
npm run site -- migrate design-system materialize .sitespec/migration/example.com/design
```

A content-driven page can be as small as:

```yaml
specVersion: "0.5"

page:
  id: post
  route: /blog/[slug]
  archetype: article

content:
  entry: posts

seo:
  title: "{entry.title}"

sections:
  - id: article
    use: article
    props:
      title: { $ref: "entry:title" }
      body: { $ref: "entry:body" }
```

Entries live under `content/posts/`. SiteSpec validates them, generates concrete routes, resolves relations/references, and passes final props to registered components.

## Documentation

- [Getting started](docs/getting-started.md)
- [Core concepts](docs/concepts.md)
- [Design Systems](docs/design-systems.md)
- [Content](docs/content.md)
- [Existing-site migration](docs/migration.md)
- [CLI reference](docs/cli.md)
- [Documentation index](docs/index.md)

Project maintenance: [release process](docs/RELEASING.md) · [changelog](CHANGELOG.md)

## Repository development

```bash
npm install
npm run build
npm test
```

Run the full v0.5 reference example:

```bash
npm run dev -w @sitespec/example-marketing
```

The monorepo contains `@sitespec/core`, `@sitespec/astro`, `@sitespec/template`, `@sitespec/cli`, `@sitespec/create`, and `examples/marketing`.

## Status

SiteSpec is early-stage. JSON Schemas and validation are the machine-readable source of truth; the documentation describes the current supported contract.

## License

MIT

# SiteSpec

SiteSpec is a deterministic, Git-native contract for building content-driven static websites with people and AI agents.

The source of truth is the repository: specs, content, design tokens, component contracts, and the Site Shell. `@sitespec/core` resolves that contract and the current Astro renderer produces static output. A runtime CMS is not required.

Figma and other design applications are optional; a separate design-handoff step is not part of the required workflow.

## Current release and format

The current engine/tooling release is **0.8.0**. The current document format remains `specVersion: "0.7"`; package releases and SiteSpec document versions are intentionally separate, so upgrading to 0.8.0 does not require a document-version migration.

It supports:

- Page Specs, archetypes, SEO, static routes, and controlled section composition;
- typed Markdown/YAML/JSON content collections with schemas and draft state;
- generic relations between entries and collections;
- declarative filtering, deterministic sorting, and pagination;
- content-driven detail and taxonomy routes;
- `entry:` and `query:` references resolved before component validation;
- a first-class Design System contract with exported UI primitives, section libraries, shell packs, themes, layout conventions, semantic tokens, local fonts, and controlled site token extensions;
- explicit UI `variant × state` contracts, including interaction/form states, native form primitives, and deterministic Design Lab preview selectors;
- Site Shell runtime declarations for persistent interactive shell behavior; the default system demonstrates light/dark preference and accessible mobile navigation;
- a live Design Lab that renders real tokens, UI state matrices, form compositions, sections, themes, stress fixtures, and responsive page previews directly from the installed Design System;
- a production media pipeline with responsive `srcset`, AVIF/WebP generation, intrinsic dimensions, crop/focal-point controls, and image validation;
- canonical/hreflang, Open Graph/Twitter metadata, JSON-LD, generated social images, sitemap, robots, `llms.txt`, and RSS without project-level Astro configuration;
- declarative Google Analytics 4 and HubSpot tracking integrations without hand-written script tags;
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
npm run site -- design dev
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

Use `npm run dev` to work on the site and `npm run site -- design dev` to review the installed Design System. Design Lab renders real foundations, UI state matrices, form compositions, sections, themes, stress fixtures, and responsive published pages without adding preview behavior to production routes.

When `design dev` is run from this SiteSpec source repository, it automatically uses `examples/marketing` because the repository root itself is not a website. Pass `--root <path>` to inspect another SiteSpec project.

A content-driven page can be as small as:

```yaml
specVersion: "0.7"

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
- [Design Lab](docs/design-lab.md)
- [Content](docs/content.md)
- [Integrations](docs/integrations.md)
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

Run the full reference example for the current `specVersion: "0.7"` contract:

```bash
npm run dev -w @sitespec/example-marketing
```

The example includes light/dark theme persistence, responsive shell navigation, the exported form foundation, and a real `/contact` page composed through the normal Page → Section → UI boundary.

The monorepo contains `@sitespec/core`, `@sitespec/astro`, `@sitespec/template`, `@sitespec/cli`, `@sitespec/create`, and `examples/marketing`.

## Status

SiteSpec is early-stage. JSON Schemas and validation are the machine-readable source of truth; the documentation describes the current supported contract.

## License

MIT

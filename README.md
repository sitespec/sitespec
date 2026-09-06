# SiteSpec

SiteSpec is a deterministic, Git-native contract for building content-driven static websites with people and AI agents.

The source of truth is the repository: specs, content, design tokens, component contracts, and the Site Shell. `@sitespec/core` resolves that contract and the current Astro renderer produces static output. A runtime CMS is not required.

Figma and other design applications are optional; a separate design-handoff step is not part of the required workflow.

## Current format

The current document format is `specVersion: "0.3"`.

It supports:

- Page Specs, archetypes, SEO, static routes, and controlled section composition;
- typed Markdown/YAML/JSON content collections with schemas and draft state;
- generic relations between entries and collections;
- declarative filtering, deterministic sorting, and pagination;
- content-driven detail and taxonomy routes;
- `entry:` and `query:` references resolved before component validation;
- section presets, registered components, UI primitives, design tokens, local fonts, and a user-owned Site Shell;
- source/output validation and agent inspection through `site spec`;
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
npm run site -- spec content --json
npm run site -- spec collection:posts --json
npm run site -- spec entry:posts/hello-world --json
```

A content-driven page can be as small as:

```yaml
specVersion: "0.3"

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
- [Content](docs/content.md)
- [CLI reference](docs/cli.md)
- [Documentation index](docs/index.md)

Project maintenance: [release process](docs/RELEASING.md) · [changelog](CHANGELOG.md)

## Repository development

```bash
npm install
npm run build
npm test
```

Run the full v0.3 content example:

```bash
npm run dev -w @sitespec/example-marketing
```

The monorepo contains `@sitespec/core`, `@sitespec/astro`, `@sitespec/template`, `@sitespec/cli`, `@sitespec/create`, and `examples/marketing`.

## Status

SiteSpec is early-stage. JSON Schemas and validation are the machine-readable source of truth; the documentation describes the current supported contract.

## License

MIT

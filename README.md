# SiteSpec

SiteSpec is a deterministic, Git-native contract for building websites with people and AI agents.

A SiteSpec project keeps the website structure, routes, navigation, assets, design system, section composition, and component contracts in versioned source files. The current renderer turns that contract into a static Astro site.

SiteSpec does not require Figma or a separate design-handoff step. Visual decisions can live directly in semantic design tokens, UI primitives, components, section presets, and the site shell. External design tools can still be used when useful, but they are not part of the required build workflow and are not the source of truth.

## Why SiteSpec exists

Traditional website work often spreads the same decisions across design files, tickets, CMS configuration, component code, and implementation notes. SiteSpec keeps the executable website contract in one repository so that humans, agents, validation, and the renderer operate on the same source.

The core goals are:

- deterministic output from explicit source files;
- machine-readable contracts instead of implicit conventions;
- controlled composition rather than arbitrary page generation;
- a design system that can be inspected and validated;
- static output that does not depend on a runtime CMS;
- an agent-readable project model with repair-oriented diagnostics.

## Quick start

Requirements: Node.js 22+ and npm.

```bash
npm create @sitespec@latest acme
cd acme
npm run dev
```

The generated project is a standalone website repository. It pins the SiteSpec CLI in `package-lock.json` so developers, agents, and CI use the same engine version.

Useful commands:

```bash
npm run dev
npm run validate
npm run build
npm run preview

npm run site -- spec --json
npm run site -- spec design --json
npm run site -- spec sections --json
npm run site -- add component comparison-table
npm run site -- add ui badge
```

## Project shape

A generated website contains website-owned source files:

```text
acme/
├── site.yaml
├── pages/
├── content/
├── sections/
├── components/
├── ui/
├── shell/
├── design/
├── public/
├── AGENTS.md
├── CLAUDE.md
├── package.json
└── package-lock.json
```

A minimal Page Spec looks like this:

```yaml
specVersion: "0.2"

page:
  id: home
  route: /
  archetype: marketing

seo:
  title: Home

sections:
  - id: intro
    use: hero
    props:
      title: The specification is the source of truth

  - id: final-cta
    $ref: section:final-cta
```

Pages select registered sections and pass validated data. Astro markup remains inside the component and shell implementations rather than inside Page Spec.

## What the v0.2 format covers

SiteSpec v0.2 includes:

- `site.yaml` for global site metadata, SEO defaults, semantic assets, and named navigation collections;
- Page Specs with archetypes, composition rules, SEO, and deterministic dynamic route expansion;
- reusable configured sections via `section:<id>` references;
- registered section components with JSON Schema prop contracts;
- internal UI primitives that pages cannot compose directly;
- semantic design tokens and local web-font declarations;
- `navigation:<id>`, `param:<name>`, and content references;
- shared core prop types such as navigation, actions, images, and pagination;
- a user-owned Site Shell;
- source and rendered-output validation;
- agent inspection through `npm run site -- spec ... --json`;
- static Astro build, preview, and GitHub Pages deployment support.

The engine remains compatible with existing `specVersion: "0.1"` projects. The default starter uses `specVersion: "0.2"`.

## Documentation

Start with the documentation index:

- [Documentation](docs/index.md)
- [Getting started](docs/getting-started.md)
- [Core concepts](docs/concepts.md)

Project maintenance documents:

- [Migrating from specVersion 0.1 to 0.2](docs/MIGRATING-0.2.md)
- [Release process](docs/RELEASING.md)
- [Changelog](CHANGELOG.md)

## Repository

This repository is the SiteSpec engine monorepo:

```text
packages/
├── core/       @sitespec/core
├── astro/      @sitespec/astro
├── template/   @sitespec/template
├── cli/        @sitespec/cli
└── create/     @sitespec/create

examples/
└── marketing/  local workspace playground
```

For core development:

```bash
npm install
npm test
```

For the release workflow, use `npm run release:check` and follow [`docs/RELEASING.md`](docs/RELEASING.md).

## Status

SiteSpec is an early-stage project. The document format is versioned independently from npm package releases. Schemas and validation are the machine-readable source of truth; documentation explains how to use that contract.

## License

MIT

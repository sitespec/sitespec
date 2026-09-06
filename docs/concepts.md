# Core concepts

SiteSpec is an executable website contract. It is not a visual page builder, a component gallery, or a replacement syntax for HTML.

The contract describes what a website is allowed to contain, how pages are composed, which data components accept, how design decisions are referenced, and which routes and global resources exist. The renderer implements that contract as a website.

## One source of truth

A SiteSpec project keeps website decisions in versioned source files that both people and tools can inspect.

This avoids a required chain such as:

```text
design file → handoff notes → implementation interpretation → website
```

SiteSpec instead allows the executable project to carry the design and composition decisions directly:

```text
design tokens
    ↓
UI primitives
    ↓
section components
    ↓
section presets
    ↓
Page Specs
    ↓
static website
```

Figma and other design applications are therefore optional tools, not a required stage or canonical source. If they are used, the SiteSpec contract still owns the decisions required to build the website.

## The composition model

The main layers are deliberately separate.

```text
Site
  ↓
Page
  ↓
Section preset / Section component
  ↓
UI primitive
  ↓
Semantic design tokens
```

The Site Shell surrounds the resolved page and consumes the same site-wide design and navigation vocabulary.

### Site

`site.yaml` owns global information that should not be repeated on individual pages, including:

- site identity and canonical URL;
- locale;
- default SEO values;
- semantic assets such as favicon and default Open Graph image;
- named navigation collections.

A page can reference these shared resources instead of copying them.

### Page

A Page Spec in `pages/*.yaml` owns a route and its composition.

It decides:

- which registered sections appear;
- their stable section IDs;
- variants and themes;
- validated props or references;
- page archetype and state;
- page-level SEO;
- explicit path values for deterministic dynamic routes.

A Page Spec does not own arbitrary Astro markup.

### Section component

A registered component under `components/<id>/` is a public page-composition building block.

Its `component.yaml` declares the contract: accepted props, variants, themes, semantics, composition rules, and runtime policy. Its `index.astro` owns the implementation.

This separation lets SiteSpec validate a page before relying on the rendered markup.

### Section preset

A section preset under `sections/` stores reusable configured section data.

Instead of duplicating the same component, variant, theme, and props on several pages, a page can reference:

```yaml
- id: final-cta
  $ref: section:final-cta
```

The preset reuses configuration. The component still owns the rendering contract.

### UI primitive

UI primitives live under `ui/<id>/` and form the internal design-system layer.

Components and the Site Shell can compose them, but Page Specs cannot use UI primitives directly. This keeps page composition at a stable semantic level instead of exposing every low-level visual building block as public page API.

### Design tokens

`design/tokens.json` separates primitive values from semantic aliases.

Primitive tokens hold raw decisions such as concrete spacing or color values. Semantic tokens describe purpose, such as a text color, surface color, or body font. Components and shell code should consume the semantic vocabulary rather than embedding arbitrary raw design values.

`design/fonts.yaml` describes local web fonts. SiteSpec can generate the corresponding `@font-face` declarations while keeping remote font stylesheets outside the contract.

### Site Shell

`shell/` is user-owned application chrome around page sections: document structure, header, footer, and other global layout concerns.

The shell can consume site navigation, assets, UI primitives, and semantic design tokens while remaining separate from Page Spec composition.

## References instead of duplication

SiteSpec uses explicit references when data belongs to another part of the project.

Important v0.2 examples include:

```text
section:final-cta
navigation:primary
param:slug
```

Core prop types also have stable URNs, for example:

```text
urn:site-spec:0.2:type:navigation
urn:site-spec:0.2:type:pagination
```

References are resolved before a component receives its final validated props. The goal is deterministic reuse, not runtime indirection.

## Deterministic dynamic routes

A dynamic route template does not imply a runtime database lookup.

For example:

```yaml
page:
  id: feature
  route: /features/[slug]
  paths:
    - slug: composition
    - slug: dynamic-routes
    - slug: agent-protocol
```

The project explicitly declares every concrete path that will be generated. Sections can use `param:slug`, and SEO strings can interpolate `{slug}`.

This gives SiteSpec dynamic route composition while preserving static, inspectable output.

## Contracts before implementation

SiteSpec validates both source intent and rendered output.

At the source level it can validate things such as:

- document schemas;
- component prop schemas;
- allowed variants and themes;
- composition rules;
- references and internal links;
- route expansion;
- semantic assets;
- design-token usage;
- component runtime policy.

After the static build, rendered HTML can be checked for implementation contracts such as stable section identity and heading semantics.

The point is not to remove implementation code. The point is to make the boundary between declared intent and implementation testable.

## Agent-readable by default

The project model is intentionally inspectable without scraping source files heuristically.

For example:

```bash
npm run site -- spec --json
npm run site -- spec design --json
npm run site -- spec sections --json
npm run site -- validate --json
```

The inspection output exposes the resolved project and agent capabilities, while diagnostics include structured information intended to support repair rather than only human-readable error strings.

Generated projects also include `AGENTS.md` and `CLAUDE.md` so tools can discover the project-local workflow.

## Source versus generated output

The user-owned project source is the contract. Generated directories are disposable results of resolving and building that source.

In particular:

```text
.site/   generated SiteSpec/Astro workspace and build metadata
dist/    production static output
```

Do not manually edit either directory to make a lasting website change. Edit the SiteSpec project source instead.

## SiteSpec and Astro

The current vertical implementation uses `@sitespec/astro` to render resolved SiteSpec projects as static Astro sites.

The boundary is intentional:

| SiteSpec owns | Astro implementation owns |
| --- | --- |
| routes and explicit path expansion | generated page modules and static rendering |
| page composition | component markup |
| component prop contracts | how validated props become HTML |
| semantic tokens and font declarations | CSS that consumes those tokens |
| navigation and semantic assets | rendered header/footer/document markup |
| composition and runtime rules | framework-level implementation details inside those rules |

SiteSpec is therefore the contract layer; Astro is the current rendering layer.

## What to read next

Return to the [documentation index](index.md), or use [Getting started](getting-started.md) to work through the basic project workflow.

# Core concepts

SiteSpec is a contract layer for static websites. The project source declares what the site is, which content exists, which routes are generated, how pages are composed, which design vocabulary is allowed, and which component contracts must be satisfied.

The current renderer turns the resolved contract into a static Astro site.

## One source of truth

A SiteSpec project keeps website decisions in versioned source files that people, agents, validation, and the renderer can all inspect.

A separate design-handoff chain is not required:

```text
design tokens + UI + components + content + Page Specs
                          ↓
                  resolved SiteSpec
                          ↓
                    static website
```

Figma and other design applications remain optional tools. If they are used, the SiteSpec project still owns the executable decisions required to build the site.

## The current project model

Two main flows meet at Page Specs.

Composition and design:

```text
semantic design tokens
        ↓
UI primitives
        ↓
section components
        ↓
section presets
        ↓
Page Specs
```

Content:

```text
typed collections
        ↓
entries + relations
        ↓
queries / entry binding
        ↓
Page Specs
```

The Site Shell surrounds the resolved page and uses the same site-wide navigation, assets, UI primitives, and semantic design vocabulary.

## Site

`site.yaml` owns information that should not be repeated on individual pages:

- site identity and canonical URL;
- locale;
- default SEO values;
- semantic assets;
- named navigation collections.

Pages and the shell can reference these resources instead of copying them.

## Content collections

Typed collections live under `content/<collection>/` and are declared by `collection.yaml`.

A collection owns:

- an entry JSON Schema;
- Markdown, YAML, or JSON entries;
- optional generic relations to other collections.

SiteSpec owns entry metadata such as `id`, `slug`, `date`, `status`, Markdown `body`, and resolved canonical `href`.

Authors, categories, tags, brands, clients, documentation sections, and similar concepts are ordinary collections. The core does not need special code for each domain type.

See [Content](content.md) for the full current content contract.

## Page

A Page Spec in `pages/*.yaml` owns a route and its composition.

It decides:

- page ID and route;
- archetype and page state;
- page-level SEO;
- which registered sections appear;
- their stable IDs, variants, themes, and props;
- reusable section references;
- optional explicit dynamic paths;
- optional content entry binding;
- optional named content queries.

A Page Spec does not own arbitrary Astro markup.

## Section component

A registered component under `components/<id>/` is a public page-composition building block.

Its `component.yaml` declares accepted props, variants, themes, semantics, composition rules, and runtime policy. Its `index.astro` owns the markup implementation.

This lets SiteSpec validate the page contract before rendering.

## Section preset

A section preset under `sections/` stores reusable configured section data.

```yaml
- id: final-cta
  $ref: section:final-cta
```

The preset reuses configuration. The registered component still owns the rendering contract.

## UI primitive

UI primitives live under `ui/<id>/` and form the internal design-system layer.

Components and the Site Shell can compose them, but Page Specs cannot use UI primitives directly. Page composition therefore stays at a stable semantic level rather than exposing every low-level visual primitive as public page API.

## Design tokens and fonts

`design/tokens.json` separates primitive values from semantic aliases.

Primitive tokens hold concrete values. Semantic tokens describe purpose: text color, surface color, spacing role, body font, and similar decisions. Components and shell code should consume the semantic vocabulary instead of embedding arbitrary raw values.

`design/fonts.yaml` declares local web fonts. SiteSpec generates the corresponding font-face wiring while keeping the font files and design choices in the project source.

## Site Shell

`shell/` is the user-owned application chrome around resolved page sections: document structure, header, footer, and other global layout concerns.

The shell can consume site navigation, semantic assets, UI primitives, and design tokens while remaining separate from Page Spec composition.

## References

References connect explicit parts of the project without introducing runtime lookup logic.

Current examples include:

```text
section:final-cta
navigation:primary
param:slug
entry:title
entry:author
query:posts.items
query:posts.pagination
```

Core prop types have stable v0.3 URNs, for example:

```text
urn:site-spec:0.3:type:action
urn:site-spec:0.3:type:navigation
urn:site-spec:0.3:type:pagination
```

References are resolved before final component prop validation.

## Static route generation

SiteSpec supports two explicit sources for dynamic routes.

### Declared paths

For non-content dynamic pages, `page.paths` enumerates the static route parameters:

```yaml
page:
  id: feature
  route: /features/[slug]
  archetype: detail
  paths:
    - slug: composition
    - slug: agent-protocol
```

Sections can consume `param:slug`.

### Content-driven paths

For content detail or taxonomy pages, bind the route to a collection:

```yaml
page:
  id: post
  route: /blog/[slug]
  archetype: article

content:
  entry: posts
```

SiteSpec materializes the route from each entry and makes the current resolved entry available through `entry:` references.

A content query can also generate pagination routes:

```yaml
paginate:
  size: 10
  route: /blog/page/[page]
```

Page 1 stays at the Page Spec's base route; subsequent pages use the pagination route.

All of these routes are determined during resolution. They do not depend on a runtime database lookup.

## Content queries

Pages can request collection data declaratively with `content.queries`.

The core performs:

- published-entry selection;
- filtering;
- deterministic sorting;
- pagination;
- relation resolution;
- canonical entry-link resolution.

The component only receives final data such as `query:posts.items` or `query:posts.pagination`.

Query logic therefore stays in the SiteSpec contract rather than being duplicated inside Astro components.

## Draft state

Pages and entries support `draft` and `published` state.

Draft content remains available for development and inspection. Normal collection queries exclude draft entries, and production rendering omits draft pages.

This keeps preview behavior in the static content model without requiring a CMS runtime.

## Contracts before implementation

SiteSpec validates source intent before rendering and can validate the rendered output afterwards.

Source validation includes areas such as:

- document schemas;
- content entry schemas;
- content relations;
- component prop schemas;
- allowed variants, themes, and archetypes;
- section composition rules;
- references and internal links;
- route generation and pagination;
- semantic assets;
- design-token usage;
- component runtime policy.

Rendered HTML can then be checked for implementation contracts such as stable section identity and heading semantics.

## Agent-readable by default

The resolved model is inspectable through the CLI:

```bash
npm run site -- spec --json
npm run site -- spec content --json
npm run site -- spec collection:posts --json
npm run site -- spec entry:posts/typed-relations --json
npm run site -- validate --json
```

Diagnostics carry structured fields and repair-oriented context instead of only free-form error strings.

Generated projects also include `AGENTS.md` and `CLAUDE.md` so tools can discover the project-local workflow.

## Core and renderer boundary

Content behavior belongs to `@sitespec/core`:

```text
content files
    ↓
collections + schemas
    ↓
relations + queries
    ↓
routes + refs + final props
    ↓
ResolvedSite
```

`@sitespec/astro` consumes the resolved model and renders static output.

| SiteSpec core owns | Astro implementation owns |
| --- | --- |
| collections and entry validation | component markup |
| relations and content queries | rendering validated props |
| routes and pagination | generated Astro page modules |
| page composition | framework implementation inside registered components |
| semantic tokens and font declarations | CSS consuming those tokens |
| navigation and semantic assets | rendered shell/header/footer |

There is deliberately no second content-query system inside the renderer.

## Source versus generated output

The user-owned project source is the contract. Generated directories are disposable:

```text
.site/   generated SiteSpec/Astro workspace and metadata
dist/    production static output
```

Make lasting changes in the SiteSpec source, not in generated files.

## What to read next

- [Getting started](getting-started.md)
- [Content](content.md)
- [CLI reference](cli.md)

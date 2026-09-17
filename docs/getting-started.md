# Getting started

This guide uses SiteSpec 0.8.0 with the current `specVersion: "0.7"` document contract and walks through the normal edit → inspect → visually review → validate → build workflow.

## Requirements

Use Node.js 22 or newer and npm.

```bash
node --version
npm --version
```

## 1. Create a site

```bash
npm create @sitespec@latest acme
cd acme
```

The initializer copies the current starter, installs dependencies by default, initializes Git when available, and pins the SiteSpec CLI through the generated lockfile.

For automation or fixture generation without install/Git side effects:

```bash
npm create @sitespec@latest acme -- --no-install --no-git
```

## 2. Run the development server

```bash
npm run dev
```

Development mode resolves the SiteSpec source into the generated Astro workspace, validates changes, and uses Astro HMR for the rendered site.

Generated directories are disposable:

```text
.site/   generated SiteSpec/Astro workspace
dist/    production output
```

Do not edit either directory directly.

## 3. Understand the source tree

The website-owned source is:

```text
site.yaml               global site contract and selected theme/shell
design-system.yaml      reusable Design System contract
pages/*.yaml            routes and page composition
content/*                typed content collections and entries
sections/*.yaml         reusable configured section presets
components/*            public section components
ui/*                    internal UI primitives
design/tokens.json      Design System primitive and semantic tokens
design/extensions.json  optional site-owned additive tokens
design/themes/*         Design System theme overrides
design/fonts.yaml       local web-font declarations
shell/*                  user-owned document/site shell
public/*                 static assets
```

The starter contains a small content-driven blog so the current content contract is visible immediately.

## 4. Inspect the project contract

Inspect the whole resolved project:

```bash
npm run site -- spec --json
```

Useful focused inspections:

```bash
npm run site -- spec design-system --json
npm run site -- spec design --json
npm run site -- spec sections --json
npm run site -- spec content --json
npm run site -- spec collection:posts --json
npm run site -- spec entry:posts/hello-world --json
npm run site -- spec navigation:primary --json
```

Inspection is intended for both people and agents. It exposes resolved pages, registered capabilities, content collections, relations, entries, canonical routes, and diagnostics without requiring source-file scraping.

## 5. Review the Design System visually

Run the Design Lab in a second terminal:

```bash
npm run site -- design dev
```

Open the reported `/__sitespec/design/` URL. The Lab renders the installed Design System rather than a separate component-demo implementation:

- **Foundations** shows semantic and primitive design tokens, including typography weight and tracking;
- **UI** shows exported primitives as `variant × state` matrices and includes the form composition benchmark;
- **Sections** renders exported section variants/themes;
- **Pages** renders published project pages at desktop, 768 px, and 375 px widths.

Use the Theme and Stress controls to review dark/light semantics, interaction states, long content, and page composition without changing the Page Specs. Page navigation inside the preview preserves the selected theme/stress state.

Read [Design Lab](design-lab.md) for the preview/state contract and [Design Systems](design-systems.md) for ownership and token rules.

## 6. Edit content

A collection lives under `content/<collection>/` and has a `collection.yaml` manifest.

Example:

```yaml
specVersion: "0.7"

collection:
  id: posts

entry:
  schema:
    type: object
    additionalProperties: false
    required: [title, description]
    properties:
      title: { type: string }
      description: { type: string }
```

A Markdown entry uses YAML frontmatter:

```md
---
slug: hello-world
date: 2026-09-06
status: published
title: Hello world
description: First post.
---

# Hello world

Content lives in Markdown.
```

SiteSpec validates the entry against the collection schema and exposes Markdown as `entry:body`.

Read [Content](content.md) for relations, queries, filtering, sorting, pagination, draft behavior, and canonical entry links.

## 7. Edit a content-driven page

A detail page binds a dynamic route to a collection:

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
  description: "{entry.description}"

sections:
  - id: article
    use: article
    props:
      title: { $ref: "entry:title" }
      body: { $ref: "entry:body" }
```

Each published or draft entry creates a resolved detail route in development. Production rendering omits draft pages.

A listing page can query the same collection:

```yaml
content:
  queries:
    posts:
      collection: posts
      sort:
        - field: date
          order: desc
      paginate:
        size: 10
        route: /blog/page/[page]
```

Component props can then consume:

```yaml
items: { $ref: "query:posts.items" }
pagination: { $ref: "query:posts.pagination" }
```

## 8. Edit page composition

Pages select registered section components; they do not contain Astro markup.

```yaml
specVersion: "0.7"

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
      eyebrow: SiteSpec
      title: The specification is the source of truth

  - id: final-cta
    $ref: section:final-cta
```

`use: hero` points to a registered component. `$ref: section:final-cta` reuses a configured section preset.

## 9. Validate

```bash
npm run validate
```

For structured diagnostics:

```bash
npm run site -- validate --json
```

Validation covers source schemas, content schemas and relations, references, component props, composition rules, assets, design usage, routes, and deterministic project constraints.

## 10. Build and preview

```bash
npm run build
npm run preview
```

The output in `dist/` is static and does not require a SiteSpec or CMS runtime.

## 11. Add controlled building blocks

Create a public section component:

```bash
npm run site -- add component comparison-table
```

Create an internal UI primitive:

```bash
npm run site -- add ui badge
```

SiteSpec creates the required contract files and refuses to overwrite an existing registered item.

## 12. Explore the full example

The repository includes `examples/marketing`, which exercises the broader Content API plus the 0.8.0 Design System workflow: light/dark preference persistence, responsive mobile navigation, the exported form primitives, and a real `/contact` page composed through a reusable `contact-form` section.

From the repository root:

```bash
npm install
npm run build
npm run dev -w @sitespec/example-marketing
```

See [CLI reference](cli.md) for details about running workspace examples and the CLI shim.

## Next

- [Core concepts](concepts.md)
- [Design Systems](design-systems.md)
- [Design Lab](design-lab.md)
- [Content](content.md)
- [CLI reference](cli.md)

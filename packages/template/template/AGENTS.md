# Site project agent contract

This repository is managed by Site Spec. Treat the Site CLI and validation output as authoritative.

## Before changing the website

Run:

```bash
npm run site -- spec --json
```

Use its output to discover pages, registered sections, component contracts, capabilities, and the current agent protocol.

## Adding or changing a page

1. Reuse existing registered sections whenever possible.
2. Edit `pages/*.yaml` and `content/*` directly.
3. Page specs may use only registered sections.
4. Never put HTML, CSS, class names, arbitrary style values, or renderer-specific code in page specs.
5. Run `npm run site -- validate --json` after changes.
6. Fix every validation error before finishing.
7. Run `npm run build` before completing the task.

## Reusable section presets

When multiple pages need the same configured section, put the reusable configuration in `sections/<id>.yaml` and reference it from Page Spec:

```yaml
sections:
  - id: final-cta
    $ref: section:final-cta
```

Inspect presets with `npm run site -- spec sections --json` or `npm run site -- spec section:<id> --json`. Presets configure registered sections; they do not contain Astro markup.

## UI primitives

`ui/*` contains internal design-system primitives such as containers and buttons. Page Spec may **never** use a UI primitive directly. Sections and Site Shell compose UI primitives in Astro source.

Before adding one, inspect `npm run site -- spec ui --json`. Create new primitives only through:

```bash
npm run site -- add ui <id>
```

Each primitive owns `ui/<id>/ui.yaml` plus `ui/<id>/index.astro`. UI primitive styles obey the same semantic-token rules as sections and shell.

## Dynamic routes

Site Spec v0.2 supports explicit static expansion of route templates. Define full path parameter sets in `page.paths`:

```yaml
page:
  id: product
  route: /products/[slug]
  archetype: detail
  paths:
    - slug: stories
    - slug: banners
```

Inside section props, the current path value is available with `{ $ref: param:slug }`. SEO title/description/canonical/image strings may use `{slug}` placeholders. Dynamic routes remain deterministic: every production path must be declared in `page.paths`; no network or runtime route discovery is allowed.

## Adding a section component

Only add a new section when existing components cannot satisfy the requirement.

Create it through:

```bash
npm run site -- add component <id>
```

Then define its public props contract in `components/<id>/component.yaml` before implementing `components/<id>/index.astro`.

Use existing design tokens and existing components as examples. Do not bypass component contracts.

Run `npm run site -- validate --json` and `npm run build` afterward.

## Visual styling and design tokens

The site-wide design language lives in `design/tokens.json`. Before changing visual styling, run:

```bash
npm run site -- spec design --json
```

The v0.2 design model has two layers:

- `primitive` contains literal design decisions such as brand colors, spacing values, typography values, and radii.
- `semantic` aliases primitive tokens and defines the stable vocabulary used by UI code.

Components and `shell/*.astro` may use semantic CSS variables such as `var(--color-text-default)` and `var(--space-section)`. Do not use `var(--primitive-...)` directly. Do not hardcode reusable colors, spacing, font size/family/line-height, border radius, or box shadows in components or shell. In v0.2, do not use inline `style=`, local CSS custom-property definitions, or imported component/shell stylesheets; keep validated styles in Astro `<style>` blocks.

For styling tasks:

1. Run `npm run site -- spec design --json`.
2. For a site-wide visual change, edit primitive values or semantic mappings in `design/tokens.json`.
3. For component-specific layout/behavior, edit the component implementation but consume semantic tokens.
4. For page-level supported visual choices, select `variant` / `theme`; never add CSS-like fields to Page Spec.
5. Run `npm run site -- validate --json` and fix every `DESIGN_*` diagnostic.
6. Run `npm run build`.

## Local web fonts

Local font faces are declared in `design/fonts.yaml`. Font files live under `public/fonts/`. Remote font stylesheets are not part of the v0.2 contract.

Before adding or changing a web font:

1. Run `npm run site -- spec fonts --json` and `npm run site -- spec design --json`.
2. Put `.woff2` or `.woff` files under `public/fonts/`. Prefer `.woff2`.
3. Declare each family and weight/style face in `design/fonts.yaml`.
4. Update primitive `fontFamily` values and semantic `font.family.body` / `font.family.heading` mappings in `design/tokens.json`.
5. Components and shell continue to consume only semantic `var(--font-family-...)` tokens. Do not add `@font-face`, Google Fonts links, or remote font CSS to components/shell.
6. Run `npm run site -- validate --json` and then `npm run build`.

## Cross-site navigation

Shared navigation is data, not header/footer markup. Define each named collection once in `site.yaml` under `navigation.<id>`. Navigation is never inferred automatically from the page list.

For a task such as "add site-wide navigation":

1. Run `npm run site -- spec --json` and `npm run site -- spec shell --json`.
2. Define/update the collection in `site.yaml`.
3. Render it from `shell/Header.astro`, `shell/Footer.astro`, or another shell element if it is persistent UI.
4. If it must also appear inside page content, reference the same collection with `$ref: navigation:<id>`; do not copy the items.
5. Run `npm run site -- validate --json`, fix every error, then run `npm run build`.

Example:

```yaml
navigation:
  primary:
    - id: pricing
      label: Pricing
      href: /pricing
```

Persistent UI belongs to the user-owned Site Shell:

- `shell/default.astro` wraps every page.
- `shell/Header.astro` may render `navigation.primary`.
- `shell/Footer.astro` renders `navigation.footer` when present and otherwise reuses `navigation.primary`.
- The shell receives all collections as `navigation`; the renderer must not own header/footer design.

### Shell layout convention

Keep persistent shell content aligned with page sections by following the same two-layer layout rule:

- The outer shell element owns the responsive page gutter with `padding-inline: var(--space-page)`.
- Its inner wrapper owns the content width with `max-width: var(--size-content)` and `margin-inline: auto`.
- Do not put the horizontal page gutter on the inner wrapper, because it reduces the usable content width relative to page sections.
- The starter header is sticky by default (`position: sticky; top: 0`) and should remain sticky unless the user explicitly asks for different behavior.

Use semantic tokens for all reusable spacing and sizing decisions; do not replace this convention with hardcoded widths or padding values.

To reuse the same collection inside any page section, use a navigation reference in a component prop:

```yaml
props:
  items:
    $ref: navigation:primary
```

The component prop contract should accept `urn:site-spec:0.2:type:navigation`. Prefer the existing `navigation-list` section for simple in-page navigation. Never duplicate a cross-site menu into page YAML or component source. Inspect a collection with `npm run site -- spec navigation:<id> --json`.

## Global assets

Site-level semantic assets are declared once in `site.yaml` under `assets` and stored as real files under `public/`.

For Site Spec v0.2:

- `assets.favicon` is required.
- `assets.appleTouchIcon` is optional.
- `assets.defaultOgImage` is optional and is the Open Graph fallback when a page does not define `seo.image`.

For an asset task:

1. Run `npm run site -- spec assets --json`.
2. Put the file under `public/`.
3. Reference it from `site.yaml` with a root-relative path such as `/brand/favicon.svg`.
4. Run `npm run site -- validate --json` and then `npm run build`.

Do not hardcode favicon, apple touch icon, or default Open Graph tags in `shell/*.astro` or page components. The renderer owns document-head integration and deployment base-path rebasing. Visual logos remain under `brand.logo` / `brand.logoDark` and are rendered by the Site Shell.

## Generated files

Never manually edit:

- `.site/`
- `dist/`

## Recovery loop

When a command returns diagnostics, prefer the machine-readable fields `code`, `expected`, `actual`, `allowed`, and `suggestions` over guessing. Apply a suggested repair when it matches the user's intent, then validate again.

## Starter showcase map

The default v0.2 starter deliberately exercises the capabilities described above. Preserve these examples unless the user asks to simplify the project:

- `pages/home.yaml` uses `navigation:primary` inside page content while the Header consumes the same collection from Site Shell.
- `pages/features.yaml` uses both `navigation:features` and `navigation:project`.
- `pages/feature.yaml` declares `/features/[slug]`, expands three explicit `page.paths`, interpolates `{slug}` in SEO, and passes `param:slug` into a registered section prop.
- `sections/final-cta.yaml` is referenced by home, features, and every generated feature page.
- `pages/examples.yaml`, `pages/examples-page-2.yaml`, and `pages/examples-page-3.yaml` feed `components/pagination` with `urn:site-spec:0.2:type:pagination` data and use real static page URLs.
- `design/fonts.yaml` declares bundled Inter WOFF2 faces. Inter is the primary body/heading family with the system font stack kept as fallback; the starter remains fully self-hosted.
- `site.yaml` declares favicon, Apple touch icon, default Open Graph image, and three named navigation collections.

When editing the starter, prefer keeping each capability visible in a real page instead of replacing it with README-only documentation.

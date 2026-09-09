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

Site Spec v0.5 supports explicit static expansion of route templates. Define full path parameter sets in `page.paths`:

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

## Typed content

SiteSpec v0.5 content lives under `content/<collection>/`. A typed collection has a `collection.yaml` manifest and Markdown, YAML, or JSON entries. Keep content selection in Page Spec rather than in Astro components.

For content work:

1. Inspect `npm run site -- spec content --json` and the relevant `collection:<id>` / `entry:<collection>/<id>`.
2. Define entry fields in `collection.yaml`; use generic `relations` for authors, categories, tags, brands, or other linked collections.
3. Bind a detail route with `content.entry` and consume values through `entry:<field>`. Do not also maintain `page.paths` for that route.
4. Define listing selection under `content.queries`; use declarative filters, sorting, and pagination, then pass `query:<id>.items` / `query:<id>.pagination` to components.
5. Keep Markdown/content loading, relation resolution, filtering, sorting, and pagination out of Astro implementations. Components render resolved props only.
6. Use `status: draft` for unpublished entries. Normal content queries include only published entries.


## Migrating an existing website

Before recreating an existing production website, collect evidence instead of guessing its Design System:

```bash
npm run site -- migrate audit https://example.com --json
```

The audit writes generated evidence under `.sitespec/audit/<host>/<route>/`: viewport screenshots, desktop section crops, a DOM snapshot, computed design inventory, media inventory, section candidates, responsive manual-root evidence, and a direct `ui-inventory.json` of visible leaf controls/surfaces. Audit at least two representative pages before extracting shared tokens, UI primitives, patterns, or sections. The audit command does **not** create or normalize Design System source automatically.

Before cross-page analysis, manually confirm the visual regions of each representative audit:

```bash
npm run site -- migrate segment .sitespec/audit/example.com/home
```

The command opens the audited production URL in a dedicated Chrome/Chromium session and injects a SiteSpec DOM picker. In Inspect mode, hover/click exact production region roots and use parent/child/sibling navigation to select the right DOM boundary; press `P` for Interact mode when the live site must accept normal clicks. Mark `Header`, `Footer`, `Ignore`, or `Section`, optionally label the region, then Save & finish. `segments.json` stores selectors, DOM fingerprints, geometry, and content/style/structure evidence. `migrate design` prefers completed manual segments over automatic section candidates.

After at least two audits from the same production host, analyze their shared design evidence with:

```bash
npm run site -- migrate design .sitespec/audit/example.com/home .sitespec/audit/example.com/second-page --json
```

`migrate design` writes exact cross-page foundations, normalized token/typography candidates, `section-rhythm.json`, `foundation-proposal.json`, cross-page section clusters, `component-families.json`, `ui-families.json`, shell candidates, and media-role proposals under `.sitespec/migration/<host>/design/`. Section rhythm only becomes an automatic `space.section` proposal when section-root top/bottom padding is balanced, reusable across section evidence, vertically dominant in the spacing inventory, and confirmed across audit viewports. Component families are architecture proposals: reviewer-controlled semantic labels win over generic clustering, repeated/cross-page families can become core, and one-off families remain local. Component prop hints record presence ratio, variant coverage, and a conservative required/optional recommendation rather than treating every always-observed value as required API. `ui-families.json` uses direct per-element audit evidence for Button/Link/form-control families; reuse status is separate from materialization eligibility, so Badge/Card and unresolved form-control roles can remain review-required even when they repeat strongly. Interactive visual states are not inferred yet. It does **not** edit `design-system.yaml`, `design/tokens.json`, components, UI primitives, or Page Specs. Treat confidence scores as evidence strength, not automatic approval.

Review inferred shell/section families explicitly with:

```bash
npm run site -- migrate components review .sitespec/migration/example.com/design --json
```

The conservative policy accepts only `core` families and their observed variants; `supporting` and one-off `local` families remain pending. `componentId` and variant ids are reviewer-editable canonical names. This review records architecture decisions only and does not generate component source. Re-running `migrate design` preserves `component-review.json`; regenerate it with `migrate components review ... --force` only when previous reviewer edits may be replaced.

Generate reviewable section contracts only after the family review:

```bash
npm run site -- migrate components contracts .sitespec/migration/example.com/design/component-review.json --json
```

This writes `component-contracts.json` plus `component-contracts/<id>/component.yaml` previews for accepted **section** families. The review/proposal SHA must still match. Accepted `site-header`/`site-footer` families remain in the shell layer and are reported as deferred shell-pack work instead of being misrepresented as page section components. Contract generation does not create `index.astro`, mutate the section library, or invent JavaScript/theme behavior that static evidence cannot prove.

Propose the reviewed shell pack separately:

```bash
npm run site -- migrate shell contracts .sitespec/migration/example.com/design/component-review.json --json
```

This writes `shell-contracts.json` with the expected default shell entry/files and header/footer evidence. It does not fabricate Astro shell source.

Review direct leaf UI families independently with:

```bash
npm run site -- migrate ui review .sitespec/migration/example.com/design --json
```

The conservative policy accepts only families that are both `core` and `materialization.eligibility: auto`. A visually repeated Card can therefore remain pending because the semantic boundary still comes from a heuristic. `uiId`, role, and variant ids are reviewer-editable. Re-running `migrate design` preserves `ui-review.json`; a changed proposal makes the review stale by SHA rather than silently applying old decisions.

Generate reviewable leaf UI contracts only after that decision:

```bash
npm run site -- migrate ui contracts .sitespec/migration/example.com/design/ui-review.json --json
```

This writes `ui-contracts.json` plus `ui-contracts/<id>/ui.yaml` previews for accepted families. It does not create `index.astro`, mutate the canonical UI library, or invent hover/focus/active state behavior. Explicit acceptance can override a review-required Card/Badge/form-control boundary, but that override remains visible in the report.

Turn the proposed foundation into explicit architecture decisions with:

```bash
npm run site -- migrate foundation review .sitespec/migration/example.com/design --json
```

Review `foundation-review.json`: proposed primitives, semantic roles, and typography roles are `accept`, `reject`, or `pending`. Required layout decisions may additionally be `provisional` when migration evidence is unresolved but a safe existing target/default-template value can be preserved explicitly. A high-confidence inferred section rhythm may still be accepted automatically under the conservative policy, including a supporting spacing primitive that is specifically justified by reusable section evidence. Provisional does not mean inferred: it is a compatibility fallback with provenance and must remain distinguishable from accepted evidence. The review is tied to the proposal SHA-256, so stale decisions cannot be silently reused after a new analysis.

If `migrate design` is re-run, SiteSpec preserves existing `foundation-review.json`, `component-review.json`, and `ui-review.json` while replacing generated analysis. Expect those reviews to become stale by SHA; regenerate them with the corresponding `... review ... --force` command only after deciding that the previous reviewer edits may be replaced.

Then materialize accepted decisions plus explicit provisional compatibility fallbacks into a non-destructive preview:

```bash
npm run site -- migrate foundation materialize .sitespec/migration/example.com/design/foundation-review.json --json
```

Inspect `foundation-tokens.json` and `foundation-materialization.json`. Provisional tokens carry `$extensions.org.sitespec.migration` provenance and are reported separately from canonical evidence-backed tokens. When a target Design System already exists, semantic tokens needed by its current components/shell may be carried forward provisionally if the migration does not yet replace them; explicit rejects are never restored this way. Materialization remains blocked for required decisions that are truly pending/rejected or invalid. It only replaces canonical `design/tokens.json` when explicitly run with `--apply --replace` and the target Design System layout/font preflight passes.

After foundation/component/UI/shell previews are current, infer implementations explicitly:

```bash
npm run site -- migrate implementations infer .sitespec/migration/example.com/design --json
```

Implementation inference is contract-first: accepted `ui.yaml` / `component.yaml` / shell contracts define the public API and file set. Saved production DOM roots, leaf UI observations, and computed styles may shape layout and semantic-token mappings, but production HTML is not copied verbatim. The inference writes migration-owned Astro previews plus additive semantic token extensions; unobserved hover/focus/active behavior, responsive menu state, and local font binaries remain unresolved rather than being fabricated.

Then assemble Design System staging:

```bash
npm run site -- migrate design-system materialize .sitespec/migration/example.com/design --json
```

Without an implementation report, staging remains contract-only/partial. With a current report, accepted Astro files are copied, the staged Design System is linted, and the phase becomes `implementation-staging`. Pending families remain excluded. Missing local font binaries are a visual-fidelity follow-up when the foundation font stack already has a safe fallback.

Chrome or Chromium must be installed locally. Use `--browser-path <path>` or `SITESPEC_CHROME_PATH` when automatic detection is not sufficient.

## Adding a section component

Only add a new section when existing components cannot satisfy the requirement.

Create it through:

```bash
npm run site -- add component <id>
```

Then define its public props contract in `components/<id>/component.yaml` before implementing `components/<id>/index.astro`.

Use existing design tokens and existing components as examples. Do not bypass component contracts.

Run `npm run site -- validate --json` and `npm run build` afterward.

## Design System contract and packs

`design-system.yaml` is the first-class v0.5 Design System contract. Inspect it before visual or structural UI work:

```bash
npm run site -- spec design-system --json
```

For a standalone pack directory, use `npm run site -- design-system --json`.

The contract owns the reusable design vocabulary and portable library boundary: exported `ui/*` primitives, exported `components/*` section library, reusable section presets, shell packs, global themes, layout conventions, token sources, fonts, and additive/locked extension rules. Page Specs still compose registered sections only.

Design System packs are source packs, not runtime dependencies. To reuse this system in another v0.5 site, create a portable copy with `npm run site -- design-system pack <directory>` and install it there with `npm run site -- design-system install <directory> --replace`. Installation copies the declared files into the target project; the target remains standalone and owns the installed source.

Site-specific token additions belong in `design/extensions.json` and must obey `tokens.rules` from `design-system.yaml`. Additive extension may add new token paths but may not override pack tokens. Global theme overrides live in the theme files declared by the contract and may override existing semantic mappings only. Select a non-default global theme or shell pack in `site.yaml` under `designSystem.theme` / `designSystem.shell`.

## Visual styling and design tokens

The site-wide design language lives in `design/tokens.json`. Before changing visual styling, run:

```bash
npm run site -- spec design --json
```

The v0.5 design model has two layers:

- `primitive` contains literal design decisions such as brand colors, spacing values, typography values, and radii.
- `semantic` aliases primitive tokens and defines the stable vocabulary used by UI code.

Components and `shell/*.astro` may use semantic CSS variables such as `var(--color-text-default)` and `var(--space-section)`. Do not use `var(--primitive-...)` directly. Do not hardcode reusable colors, spacing, font size/family/line-height, border radius, or box shadows in components or shell. In v0.5, do not use inline `style=`, local CSS custom-property definitions, or imported component/shell stylesheets; keep validated styles in Astro `<style>` blocks.

For styling tasks:

1. Run `npm run site -- spec design --json`.
2. For a site-wide visual change, edit primitive values or semantic mappings in `design/tokens.json`.
3. For component-specific layout/behavior, edit the component implementation but consume semantic tokens.
4. For page-level supported visual choices, select `variant` / `theme`; never add CSS-like fields to Page Spec.
5. Run `npm run site -- validate --json` and fix every `DESIGN_*` diagnostic.
6. Run `npm run build`.

## Local web fonts

Local font faces are declared in `design/fonts.yaml`. Font files live under `public/fonts/`. Remote font stylesheets are not part of the v0.5 contract.

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

The component prop contract should accept `urn:site-spec:0.5:type:navigation`. Prefer the existing `navigation-list` section for simple in-page navigation. Never duplicate a cross-site menu into page YAML or component source. Inspect a collection with `npm run site -- spec navigation:<id> --json`.

## Global assets

Site-level semantic assets are declared once in `site.yaml` under `assets` and stored as real files under `public/`.

For Site Spec v0.5:

- `assets.favicon` is required.
- `assets.appleTouchIcon` is optional.
- `assets.defaultOgImage` is optional and is the Open Graph fallback when a page does not define `seo.image`.

For an asset task:

1. Run `npm run site -- spec assets --json`.
2. Put the file under `public/`.
3. Reference it from `site.yaml` with a root-relative path such as `/brand/favicon.svg`.
4. Run `npm run site -- validate --json` and then `npm run build`.

Do not hardcode favicon, apple touch icon, or default Open Graph tags in `shell/*.astro` or page components. The renderer owns document-head integration and deployment base-path rebasing. Visual logos remain under `brand.logo` / `brand.logoDark` and are rendered by the Site Shell.

## Media and SEO

In SiteSpec v0.5, responsive media and production SEO are part of the specification, not project-level Astro configuration.

- Declare local images in typed component/content props with `urn:site-spec:0.5:type:image`. Keep source files under `public/`.
- Prefer `@site-generated/components/SiteImage.astro` inside components. It renders the responsive derivatives prepared by SiteSpec; do not add a parallel Astro image pipeline.
- Give meaningful images non-empty `alt`; use `decorative: true` only for genuinely decorative images.
- Use `widths`, `sizes`, `crop.aspectRatio`, and `crop.focalPoint` in the image value when the layout needs them. SiteSpec generates AVIF/WebP and intrinsic dimensions.
- Configure sitemap, robots, `llms.txt`, RSS, and generated social images in `site.yaml#/seo`.
- Configure page canonical/hreflang/Open Graph/Twitter overrides in Page Spec. Keep JSON-LD in `structuredData`; do not author duplicate head tags in components or shell.
- `sitespec dev` serves generated sitemap, robots, `llms.txt`, and RSS files from the generated public directory; do not create project-owned copies to make those URLs work locally.
- After media/SEO changes, run validation and a full build. Post-build checks verify the generated HTML contract.

## Generated files

Never manually edit:

- `.site/`
- `dist/`

## Recovery loop

When a command returns diagnostics, prefer the machine-readable fields `code`, `expected`, `actual`, `allowed`, and `suggestions` over guessing. Apply a suggested repair when it matches the user's intent, then validate again.

## Starter showcase map

The default v0.5 starter deliberately exercises the capabilities described above. Preserve these examples unless the user asks to simplify the project:

- `pages/home.yaml` uses `navigation:primary` inside page content while the Header consumes the same collection from Site Shell.
- `pages/features.yaml` uses both `navigation:features` and `navigation:project`.
- `pages/feature.yaml` declares `/features/[slug]`, expands three explicit `page.paths`, interpolates `{slug}` in SEO, and passes `param:slug` into a registered section prop.
- `sections/final-cta.yaml` is referenced by home, features, and every generated feature page.
- `content/posts/*`, `pages/blog.yaml`, and `pages/post.yaml` demonstrate typed Markdown, query sorting/pagination, `entry:`/`query:` refs, and content-driven static routes.
- `components/pagination` consumes `urn:site-spec:0.5:type:pagination`; page 2 is generated by the blog query rather than maintained as a separate Page Spec.
- `design/fonts.yaml` declares bundled Inter WOFF2 faces. Inter is the primary body/heading family with the system font stack kept as fallback; the starter remains fully self-hosted.
- `site.yaml` declares favicon, Apple touch icon, default Open Graph image, and three named navigation collections.

When editing the starter, prefer keeping each capability visible in a real page instead of replacing it with README-only documentation.

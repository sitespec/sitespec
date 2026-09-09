# CLI reference

SiteSpec projects use the project-local `sitespec` CLI through npm scripts. The CLI resolves and validates the SiteSpec contract, runs the development server, builds static output, previews builds, inspects the project model, and performs supported project operations.

## Project scripts

A generated SiteSpec project normally exposes:

```bash
npm run dev
npm run validate
npm run build
npm run preview
npm run site -- <command>
```

Use npm scripts rather than relying on a globally installed SiteSpec CLI. This keeps local development, agents, and CI on the version pinned by the project lockfile.

## Development server

```bash
npm run dev
```

Development mode watches SiteSpec source, content, components, UI primitives, section presets, Site Shell, Design System contract, themes, design tokens/extensions, and public assets. It re-resolves the project and reports structured diagnostics when the source becomes invalid.

## Validation

Human-readable validation:

```bash
npm run validate
```

Structured validation:

```bash
npm run site -- validate --json
```

## Build and preview

```bash
npm run build
npm run preview
```

`build` produces static output in `dist/`. `preview` serves that output locally.

## Inspect the resolved contract

Whole project:

```bash
npm run site -- spec --json
```

Focused inspection:

```bash
npm run site -- spec design-system --json
npm run site -- spec design --json
npm run site -- spec sections --json
npm run site -- spec content --json
npm run site -- spec collection:posts --json
npm run site -- spec entry:posts/typed-relations --json
npm run site -- spec navigation:primary --json
npm run site -- spec /blog/category/engineering --json
```

The inspection surface is designed to be stable enough for agents and tooling to understand the project without inferring structure from arbitrary source code.

## Existing-site migration audit

Collect production evidence before extracting a Design System:

```bash
npm run site -- migrate audit https://example.com/
```

The default output is `.sitespec/audit/<host>/<route>/` and contains full-page screenshots for desktop/tablet/mobile, desktop section crops, a DOM snapshot, computed-style inventory, media inventory, section candidates, a compact `layout.json` DOM geometry index, direct visible leaf-control/surface evidence in `ui-inventory.json`, and `audit.json`. When a completed `segments.json` is already present, the audit also re-measures those manual roots and group boundaries across requested viewports. The command does not generate SiteSpec source.

Machine-readable invocation:

```bash
npm run site -- migrate audit https://example.com/ --json
```

Useful options:

```bash
npm run site -- migrate audit https://example.com/ --viewports desktop,mobile
npm run site -- migrate audit https://example.com/ --output audit/example/home
npm run site -- migrate audit https://example.com/ --browser-path /path/to/chrome
npm run site -- migrate audit https://example.com/ --timeout 60000 --settle 1200
```

Chrome or Chromium is required locally; `SITESPEC_CHROME_PATH` can supply an explicit executable. See [Existing-site migration](migration.md) for artifact semantics and the recommended multi-page extraction workflow.

## Existing-site manual segmentation

Confirm the visual regions of a representative audit in the live production DOM picker:

```bash
npm run site -- migrate segment .sitespec/audit/example.com/home
```

The command opens the audited production URL in a dedicated Chrome/Chromium session and injects a live SiteSpec DOM picker. In **Inspect** mode, hover and click an exact production root; use `↑`/`↓` for parent/child and `←`/`→` for siblings. **Add / update block** creates one logical block from the current root and immediately resumes hover inspection, so the next region does not require an extra page click. When an existing block is selected and DOM navigation moves to a parent/child root (for example from `header > div > div` to `header`), **Add / update block** replaces that block root in place rather than creating a duplicate Header/Footer. The created block remains active: select another sibling-level root and use **Add root to block** (or `G`) to group DOM siblings into one logical section such as a Hero whose copy, CTA, and media are separate production elements. Existing logical blocks can also be selected from the block list using the checkbox, `Cmd/Ctrl`-click, or `Shift`-click and combined with **Merge selected** (`M`); the current **Block name** and role become the merged block metadata. **Ungroup** splits one selected multi-root block back into separate logical blocks, while **Delete selected** removes a batch. **Remove root** removes only the current root from a grouped block. `H`, `F`, `I`, and `S` assign Header/Footer/Ignore/Section. The inspector panel can be dragged by its header and collapsed to a compact bar. **Block name** stores the reviewer-owned logical name. The selected-block list has its own bounded vertical scroll so the inspector does not grow indefinitely on long pages, and checkbox/batch selection preserves the current list scroll position. **Reload** reloads the production page through the CLI and reinjects the picker while preserving grouped roots, names, panel position, and collapsed state. Press `P` to switch to **Interact** mode when the production page must accept normal clicks (for example to close a cookie banner or switch a tab). Fixed and sticky roots use stable production geometry instead of accumulating the current page scroll. **Save & finish** writes `segments.json` v0.3 with logical blocks, one or more selectors per block, per-root fingerprints/evidence, and aggregated block evidence. Screenshot segmentation is not used. `migrate design` prefers completed manual segments over automatic `sections.json` candidates.

Useful options:

```bash
npm run site -- migrate segment .sitespec/audit/example.com/home --browser-path /path/to/chrome
npm run site -- migrate segment .sitespec/audit/example.com/home --timeout 60000
```

## Existing-site Design System analysis

After auditing and preferably manually segmenting at least two representative pages from the same production host, compare their evidence:

```bash
npm run site -- migrate design \
  .sitespec/audit/example.com/home \
  .sitespec/audit/example.com/products-widget
```

The default generated output is `.sitespec/migration/<host>/design/` and contains `foundations.json`, `token-candidates.json`, `section-rhythm.json`, `foundation-proposal.json`, `section-clusters.json`, `component-families.json`, `ui-families.json`, `shell-candidates.json`, `media-roles.json`, and `report.json`. `foundations.json` remains exact production evidence. Before writing `token-candidates.json`, the command runs a deterministic normalization/filtering layer: it canonicalizes supported CSS colors and font stacks, removes SVG paint references/default computed border noise, rejects negative/multi-value/subpixel spacing artifacts, canonicalizes full radii and transparent shadow layers, keeps only strong per-viewport container-width candidates, and converts computed typography line heights to unitless ratios. `section-rhythm.json` then evaluates real logical section-boundary vertical padding against cross-page clusters plus normalized spacing/viewport evidence. `component-families.json` is the section/shell architecture layer: reviewer semantic intent wins over generic cluster naming, cross-page/repeated families are classified as `core`/`supporting`, one-offs remain `local`, and explicit label vocabulary such as `carousel` can create observed variants. Component prop hints now record presence ratio, variant coverage, and a conservative required/optional recommendation so a visually recurring image does not automatically become required API. `ui-families.json` is intentionally separate and derives Button/Link/native form-control families from direct `ui-inventory.json` element evidence; `status` describes reuse while `materialization.eligibility` separately prevents Badge/Card heuristics or unresolved form-control roles from being auto-approved. Interactive state mapping remains unresolved. The command never writes canonical `design/tokens.json`, `design-system.yaml`, components, UI primitives, or Page Specs.

For human-confirmed `manual-dom` blocks, cross-page clustering applies a conservative semantic-intent gate inferred primarily from reviewer block names. Conflicting known intents are never clustered merely because their geometry or DOM shape looks similar; unknown intents require a higher similarity score plus label/heading support. The inferred intent and evidence source are included in `section-clusters.json` provenance for review.

Machine-readable invocation:

```bash
npm run site -- migrate design \
  .sitespec/audit/example.com/home \
  .sitespec/audit/example.com/products-widget \
  --json
```

Use `--output <path>` to write the generated analysis elsewhere. Inputs may be completed audit directories or their `audit.json` files; all inputs must belong to the same production host.

Review the proposed shell/section component architecture explicitly:

```bash
npm run site -- migrate components review .sitespec/migration/example.com/design
```

This writes `component-review.json`. The conservative policy accepts only `core` families and their observed variants. `supporting` and one-off `local` families remain pending; `componentId` and variant ids are reviewer-editable canonical names. `--policy manual` leaves everything pending, `--policy all` accepts every proposal, and `--force` is required to replace an existing review. The review records architecture decisions only.

Generate section-contract previews from accepted review decisions:

```bash
npm run site -- migrate components contracts .sitespec/migration/example.com/design/component-review.json
```

This verifies the review SHA against `component-families.json`, writes `component-contracts.json`, and generates `component-contracts/<id>/component.yaml` only for accepted **section** families. Accepted shell families are reported as deferred shell-pack decisions instead of being encoded as page sections. The generated manifests are migration previews only: no `index.astro` is created, no canonical component library is changed, and runtime JavaScript/theme vocabulary remain unresolved unless separately proven.

Turn accepted shell-family decisions into a shell-pack contract separately:

```bash
npm run site -- migrate shell contracts .sitespec/migration/example.com/design/component-review.json
```

This writes `shell-contracts.json`. It names the proposed `default` shell entry and expected Header/Footer files from accepted shell families, preserves confidence/page evidence, and deliberately does **not** create Astro implementations. Header/footer absence remains visible as a partial shell contract rather than being filled from the default template.

Review leaf UI families separately:

```bash
npm run site -- migrate ui review .sitespec/migration/example.com/design
```

Under the conservative policy only `core` families with `materialization.eligibility: "auto"` are accepted. A Card may therefore be `core` because it repeats strongly while still remaining `pending` because the Card boundary came from a visual heuristic. `uiId`, role, and variant ids are reviewer-editable and the review is SHA-bound to `ui-families.json`. SiteSpec requires every UI primitive to expose a canonical `default` variant; when the observed family has only named variants such as `ghost` / `solid`, review deterministically maps the most-supported observed variant to canonical `default` while preserving the original source id in review/report provenance.

Generate reviewable UI manifests only after that decision:

```bash
npm run site -- migrate ui contracts .sitespec/migration/example.com/design/ui-review.json
```

This verifies the review SHA and writes `ui-contracts.json` plus `ui-contracts/<id>/ui.yaml` for accepted families. Contract generation refuses an accepted family that has no canonical `default` variant, preventing a schema-shaped preview from later failing the SiteSpec UI registry. `ui-contracts.json` keeps the observed-source → canonical-variant mapping. No `index.astro`, runtime JavaScript assertion, hover/focus/active state mapping, or canonical UI registration is generated.

Review the rationalized foundation separately from the generated proposal:

```bash
npm run site -- migrate foundation review .sitespec/migration/example.com/design
```

This writes `foundation-review.json` with explicit `accept` / `reject` / `pending` decisions, plus `provisional` for required layout values that are not evidence-backed yet but can safely preserve a target/default-template compatibility value. Provisional fallbacks are snapshotted with provenance rather than presented as inferred design decisions. Canonical paths/typography role names remain editable and the proposal SHA-256 guards against stale review. `--policy conservative` is the default; `manual` leaves all decisions pending and `all` stages all proposed values. Use `--force` only when intentionally regenerating an existing review template.

Materialize accepted decisions without changing the project:

```bash
npm run site -- migrate foundation materialize .sitespec/migration/example.com/design/foundation-review.json
```

This writes `foundation-tokens.json` plus `foundation-materialization.json`. Accepted tokens are canonical proposal decisions; provisional tokens carry `$extensions.org.sitespec.migration` provenance. When a target Design System already exists, missing semantic API tokens used by its current component/shell libraries are carried forward provisionally instead of being dropped. A blocked preview is still inspectable, but canonical source is unchanged. After hard blockers are resolved and the target layout/font preflight is compatible, `--apply --replace` can replace the target Design System token source.

Once foundation, section, UI, and shell contract previews are current, infer runnable implementation previews from the accepted contracts plus saved DOM/computed-style evidence:

```bash
npm run site -- migrate implementations infer .sitespec/migration/example.com/design
```

This writes `implementation-inference.json` plus a migration-owned `implementation-preview/` tree containing accepted `ui/*/index.astro`, `components/*/index.astro`, shell files, additive `design/extensions.json`, and an intentionally minimal `design/fonts.yaml`. Accepted contracts define the public API; production HTML is not copied verbatim. Observed DOM/computed styles may choose layout and semantic-token mappings, while unobserved hover/focus/active behavior, client-side state machines, and local font binaries stay explicit unresolved fidelity work. Generated reusable CSS uses semantic tokens only; missing semantic aliases needed by implementation are derived additively from accepted primitives with migration provenance rather than embedding raw reusable values.

Then assemble the reviewed artifacts into a Design System staging tree:

```bash
npm run site -- migrate design-system materialize .sitespec/migration/example.com/design
```

Without `implementation-inference.json`, staging remains contract-only and reports missing Astro/font files as blockers. With a current inference report, SiteSpec copies only the expected accepted implementations, merges the additive token extension contract, runs Design System lint on the staged pack, and reports phase `implementation-staging`. Pending/rejected families such as a heuristic Card remain excluded and do not become blockers. Local Roboto Flex binaries remain a visual-fidelity warning while the declared fallback font stack keeps the pack executable.

## Design System commands

Inspect the installed first-class Design System through the `site spec` surface requested by the current v0.5 agent contract:

```bash
npm run site -- spec design-system --json
```

Inspect a site or standalone Design System pack directly:

```bash
npm run site -- design-system --json
```

Copy the current Design System into an empty portable pack directory:

```bash
npm run site -- design-system pack ../company-design-system
```

Install a pack into a SiteSpec v0.5 project:

```bash
npm run site -- design-system install ../company-design-system --replace
```

The install is source-copy based; the target website receives no runtime dependency on the pack. `--replace` replaces files owned by the current Design System while preserving `design/extensions.json`. Read [Design Systems](design-systems.md) for the ownership and extension rules.

## Add registered building blocks

Create a public section component:

```bash
npm run site -- add component comparison-table
```

Create an internal UI primitive:

```bash
npm run site -- add ui badge
```

The CLI refuses to overwrite existing registered IDs.

## Run the repository example

The monorepo contains the full Content example in `examples/marketing`.

From the repository root:

```bash
npm install
npm run build
npm run dev -w @sitespec/example-marketing
```

Other workspace commands:

```bash
npm run validate -w @sitespec/example-marketing
npm run build -w @sitespec/example-marketing
npm run preview -w @sitespec/example-marketing
npm run site -w @sitespec/example-marketing -- spec content --json
```

## CLI binary in the monorepo

`@sitespec/cli` exposes a stable executable shim at:

```text
packages/cli/bin/sitespec.js
```

The package `bin` entry points to that shim rather than directly to generated `dist/index.js`. This lets npm create `node_modules/.bin/sitespec` during installation even when the CLI has not been built yet.

In the SiteSpec monorepo, the shim expects the compiled CLI to exist before it executes a command. Therefore the normal repository workflow is:

```bash
npm install
npm run build
npm run dev -w @sitespec/example-marketing
```

If the CLI package has not been built, the shim exits with an explicit instruction to run the root build instead of failing with `sitespec: command not found`.

Generated standalone projects consume the published `@sitespec/cli` package, which already contains its compiled `dist/` output and the same shim.


`migrate audit` also captures lightweight section-region evidence for each requested viewport. When the audit directory already contains a completed manual `segments.json` for the same source URL, that reviewer-authored file is preserved across audit refreshes and every saved manual root is re-measured directly on each requested viewport. Exact selectors are preferred; when responsive DOM changes invalidate a selector, the saved tag/classes/heading/text/structure/ancestry fingerprint is used as a guarded fallback. These targeted matches are written to `sections.json` separately from the generic region index, and `migrate design` prefers them for reviewed blocks. Grouped blocks use their outer root boundaries for section-rhythm inference.

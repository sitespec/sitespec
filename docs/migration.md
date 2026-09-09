# Existing-site migration

SiteSpec can collect structured evidence from an existing production page before you model that website as a SiteSpec Design System.

The first migration command is deliberately narrow:

```bash
npm run site -- migrate audit https://example.com/
```

`migrate audit` does **not** generate tokens, Astro components, or Page Specs. It records what the production page actually does so later Design System decisions can be based on evidence rather than approximation.

## Requirements

`migrate audit` uses the Chrome DevTools Protocol and requires a locally installed Google Chrome or Chromium browser.

SiteSpec checks the common executable locations for macOS, Linux, and Windows. When automatic detection is not sufficient, pass the executable explicitly:

```bash
npm run site -- migrate audit https://example.com/ \
  --browser-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

or set:

```bash
export SITESPEC_CHROME_PATH="/path/to/chrome"
```

The command launches a temporary isolated headless browser profile and removes it after the audit.

## Default output

For:

```bash
npm run site -- migrate audit https://example.com/
```

SiteSpec writes generated evidence under:

```text
.sitespec/audit/example.com/home/
├── audit.json
├── page.json
├── dom.html
├── design-inventory.json
├── media.json
├── sections.json
├── layout.json
├── screenshots/
│   ├── desktop.png
│   ├── tablet.png
│   └── mobile.png
└── sections/
    ├── 01-....png
    ├── 02-....png
    └── ...
```

`.sitespec/audit/` is ignored by the default SiteSpec Git configuration because screenshots and DOM snapshots are generated migration evidence. Copy selected approved references somewhere versioned when a project wants to retain them as long-lived visual baselines.

Use an explicit output directory when needed:

```bash
npm run site -- migrate audit https://example.com/ --output audit/example/home
```

## Fixed v1 viewport matrix

The default audit captures:

| Name | Viewport |
| --- | --- |
| `desktop` | `1440 × 1200` |
| `tablet` | `768 × 1024` |
| `mobile` | `375 × 812` |

Select a subset with:

```bash
npm run site -- migrate audit https://example.com/ --viewports desktop,mobile
```

The first version keeps viewport names fixed so evidence from different pages can be compared consistently.

## What the audit records

### `page.json`

Page-level evidence:

- requested and final URL;
- HTTP document status when available;
- title, description, canonical, robots, language, and viewport metadata;
- heading outline;
- internal/external link counts;
- form, script, and stylesheet counts;
- viewport capture metadata.

### `dom.html`

A post-render desktop DOM snapshot after the page has loaded, fonts have settled, and the audit has scrolled through the page to trigger normal lazy media.

This is evidence, not SiteSpec source. Do not copy arbitrary production HTML into SiteSpec components.

### `design-inventory.json`

Computed-style evidence from visible elements at each viewport plus an aggregate view:

- colors and the CSS properties that use them;
- typography tuples: family, size, weight, line-height, letter-spacing, and text transform;
- border-radius values;
- box shadows;
- non-zero spacing values and their properties;
- likely centered container widths;
- visible/text-bearing element counts.

The inventory intentionally preserves observed values. For example, if production contains `24px`, `28px`, and `32px` radii, the audit records all three instead of prematurely deciding that they are one semantic token.

### `media.json`

Observed media across selected viewports:

- `<img>` resources including current source, alt, intrinsic dimensions, `srcset`, `sizes`, loading, and fetch priority;
- CSS background images;
- video sources and posters;
- inline SVG occurrences;
- selectors, rendered dimensions, viewport usage, and whether URL-backed media is external to the audited origin.

This inventory is the input for later SiteSpec v0.5 media migration. It does not download or rewrite assets in v1.

### `sections.json`

A conservative section-candidate pass based on semantic landmarks and major top-level blocks. Each candidate records its selector, heading/label, geometry, background, and optional desktop crop. New audits also record an additive section signature for later cross-page analysis: heading typography, content-role counts, direct/descendant tag shape, and selected computed layout/style values.

Section detection is evidence for review, not an automatic component boundary. A human or agent still decides whether a candidate is a Site Shell region, a reusable section family, a smaller pattern, or page-specific composition. `migrate design` can still read older audit artifacts that lack the enhanced signature, but marks clusters derived from that evidence as `legacy`.

### `layout.json`

New audits also keep a compact desktop layout index with visible structural/block DOM nodes, absolute geometry, selectors, content-role counts, DOM shape, selected computed styles, and heading typography. It remains useful generated evidence for agents and analysis, but live `migrate segment` no longer depends on it: selected DOM roots are inspected directly in the production page at review time.

## Machine-readable output

Use:

```bash
npm run site -- migrate audit https://example.com/ --json
```

The command prints a stable result envelope with the audit output directory, browser information, viewport matrix, artifact paths, and summary counts.

Example shape:

```json
{
  "version": "0.5",
  "success": true,
  "audit": {
    "sourceUrl": "https://example.com/",
    "finalUrl": "https://example.com/",
    "output": "/project/.sitespec/audit/example.com/home",
    "summary": {
      "sections": 12,
      "media": 48,
      "visibleElements": 930,
      "colors": 31,
      "typography": 22,
      "radii": 9,
      "screenshots": 3
    }
  }
}
```

The files themselves currently use migration artifact version `0.1`; that version is separate from the SiteSpec project `specVersion`.

## Timing controls

Navigation/browser timeout:

```bash
npm run site -- migrate audit https://example.com --timeout 60000
```

Additional quiet time after the audit scrolls through the page to trigger lazy media:

```bash
npm run site -- migrate audit https://example.com --settle 1200
```

The default is 30 seconds for browser/navigation operations and 600 ms of post-scroll settling.

## Human-confirmed visual segmentation

Automatic section candidates are intentionally conservative and can be weak on sites built mostly from generic `<div>` wrappers. For representative pages, prefer a short human review before cross-page design analysis:

```bash
npm run site -- migrate segment .sitespec/audit/example.com/home
```

The command launches a dedicated, visible Chrome/Chromium session at the audited production URL and injects the SiteSpec picker directly into that page. There is no screenshot review mode. A reviewer can:

- hover a real production `div`, `section`, `header`, `footer`, `main`, `article`, or `nav` region;
- click to lock the current DOM candidate;
- move to its parent/child with `↑`/`↓` or previous/next sibling with `←`/`→`;
- press `Enter` to add/update the exact DOM root; when editing an existing block, navigating to a parent/child replaces that block root in place, including Header/Footer shell blocks;
- mark it as `Header`, `Footer`, `Ignore`, or normal `Section`;
- enter a human-owned **Block name** without replacing the detected production heading; pressing `Enter` in the field adds/updates that region;
- drag the inspector by its header or collapse it when it obstructs the production layout;
- select already-created logical blocks in the inspector list using the checkbox, `Cmd/Ctrl`-click, or `Shift`-click, then **Merge selected** (`M`) to combine them without re-picking their DOM roots; the bounded list keeps its own scroll position while selection state is redrawn;
- use the current **Block name** and role as the metadata for the merged group; **Ungroup** reverses one selected multi-root block, and **Delete selected** removes a batch;
- reload the production page from the inspector; selected regions, names, panel position, and collapsed state are restored after reinjection;
- press `P` to toggle **Interact** mode so the production site can receive normal clicks;
- save the review as `segments.json`.

Selected blocks are DOM-oriented evidence, not pixel ranges. A block may contain one root or several sibling-level roots when the production DOM splits one visual section into separate elements. Existing blocks can therefore be merged after the first pass without losing selectors, fingerprints, or evidence: their roots are flattened into one logical block and `migrate design` consumes the aggregated result. SiteSpec stores every selector plus a fingerprint (tag/id/classes, heading, ancestry, geometry, text hash, structure hash) and a fresh content/style/structure snapshot per root, then derives aggregated block evidence for `migrate design`. Nested roots remain rejected so grouping expresses peer DOM pieces of one logical section rather than an accidental component tree. Fixed/sticky roots use stable page geometry. Technical overlays, cookie UI, chat widgets, or analytics containers can be selected and marked `Ignore`.

`migrate design` uses a completed `segments.json` in preference to `sections.json`. Older boundary-based `segments.json` artifacts remain readable by `migrate design`, but running `migrate segment` again upgrades the review to exact live DOM evidence.

Use `--browser-path <path>` or `SITESPEC_CHROME_PATH` when Chrome/Chromium cannot be auto-detected. `--timeout <ms>` controls browser startup and production navigation.

## Multi-page Design System analysis

After at least two representative pages from the same production host have completed audits, run:

```bash
npm run site -- migrate design \
  .sitespec/audit/example.com/home \
  .sitespec/audit/example.com/products-widget
```

`migrate design` is the inference layer between raw production evidence and a real SiteSpec Design System. It does not generate or mutate SiteSpec source. Its job is to make cross-page evidence reviewable and attributable before a human or agent accepts any normalization or component boundary.

The inputs may be completed audit directories or their `audit.json` files. At least two inputs are required, and all audits must belong to the same normalized production host.

The default generated output is:

```text
.sitespec/migration/example.com/design/
├── report.json
├── foundations.json
├── token-candidates.json
├── section-rhythm.json
├── foundation-proposal.json
├── section-clusters.json
├── component-families.json
├── ui-families.json
├── component-review.json        # reviewer-owned; created separately
├── component-contracts.json     # generated after component review
├── component-contracts/         # generated component.yaml previews
├── ui-review.json               # reviewer-owned; created separately
├── ui-contracts.json            # generated after UI review
├── ui-contracts/                # generated ui.yaml previews
├── shell-candidates.json
└── media-roles.json
```

`.sitespec/migration/` is generated analysis and is ignored by the default Git configuration. Approved Design System source belongs in `design-system.yaml`, `design/`, `ui/`, `components/`, `sections/`, and `shell/`; do not treat generated migration proposals as source of truth.

### `foundations.json`

Aggregates exact observed production values across all input audits without normalizing them. Each value carries:

- total observation count;
- audited page IDs and per-page counts;
- page coverage;
- evidence confidence;
- property usage when available;
- viewport usage inherited from the audits.

For example, `24px` and `32px` spacing remain separate observed values. `foundations.json` also keeps browser/computed evidence that may later be rejected as token material, such as subpixel layout widths, negative margins, SVG paint references, or unusually large pill radii. The file is intentionally not rewritten by normalization.

### `token-candidates.json`

Contains three proposal groups plus a normalization report:

- `primitive`: deterministic candidates derived from normalized colors, spacing, radii, shadows, centered container widths, and decomposed typography values;
- `semantic`: deliberately conservative role hints inferred only when normalized property usage gives a strong signal, such as a color being used predominantly for text, surfaces, or icon foregrounds; computed border colors are not promoted until active-border evidence is available;
- `typography`: normalized typography tuples with reviewer-oriented role suggestions such as `body-16-medium-lh-1-5` or `heading-32-bold-tracked-lh-1`.

The normalization layer is deterministic and runs only between `foundations.json` and token proposals. In particular it:

- canonicalizes supported RGB/hex/Lab/OKLab colors into stable sRGB values and merges equivalent representations;
- rejects SVG `url(...)` paint references as color primitives;
- ignores computed border-color occurrences that cannot prove an active visible border, avoiding browser-default border evidence dominating semantic color inference;
- accepts atomic positive spacing values while rejecting negative, multi-value, subpixel, weak one-off margin, and obvious large layout artifacts; duplicate `gap`/`rowGap`/`columnGap` observations are collapsed for evidence counts;
- canonicalizes very large pill/circle radii to the review candidate `primitive.radius.full` (`9999px`) while keeping the original observed value in `foundations.json`;
- strips transparent zero-value shadow layers before comparing shadow candidates;
- keeps only the strongest centered container-width evidence per viewport instead of promoting every centered element width into a size token;
- canonicalizes duplicate font fallback stacks, rejects tiny/weak typography artifacts, converts computed line-height pixels to unitless ratios, and preserves materially different ratios as separate typography evidence.

`normalization` reports raw, normalized, rejected, and merged evidence counts per category. `normalization.rejected` keeps every rejected value with its category, reason, occurrence count, and page provenance. `normalization.adjustments` records non-destructive transformations such as ignored default-border occurrences, collapsed duplicate gap observations, canonicalized font stacks, and removed transparent shadow layers. This makes the filtering auditable instead of silently dropping production evidence.

Candidate IDs such as `primitive.color.01` are placeholders, not recommended final naming. Semantic candidates deliberately have lower confidence than the literal primitive evidence they reference. Review naming, deduplication, and normalization before changing `design/tokens.json`.

### `section-rhythm.json`

Evaluates vertical rhythm separately from generic spacing frequency before `space.section` can become a canonical layout decision.

The inference only considers section-root `paddingTop` / `paddingBottom` values from the selected section evidence. Header/footer roots are excluded. Each candidate is cross-checked against:

- whether top and bottom padding are balanced on the same section roots;
- how many distinct sections and audited pages use the value;
- whether those sections participate in reusable cross-page or repeated manual clusters;
- whether the normalized spacing inventory is predominantly vertical for that value rather than horizontal padding, margin, or gap noise;
- whether the value appears across the standard desktop/tablet/mobile audit evidence.

Candidates are classified as `strong`, `supporting`, or `weak`. A single `recommended` value is emitted only when one strong candidate is clearly dominant. Multiple similarly strong tiers remain unresolved instead of choosing the largest or most frequent number arbitrarily. Smaller supported tiers are preserved as `compactCandidates` for later section/component modelling.

This deliberately rejects patterns such as a value that appears on both pages and every viewport but only as one-sided `paddingTop`; that is more likely to be a page/header offset than the site's reusable section rhythm.

### `foundation-proposal.json`

Rationalizes the normalized candidates into a reviewable Design System foundation model without changing SiteSpec source. This is the first layer that proposes stable token names and relationships rather than merely listing observed values.

It currently proposes:

- color families and stable primitive names, including a likely brand hue family, neutral/ink values, endpoints, and translucent overlays;
- a spacing scale with an inferred base unit, separating core values from supporting values and fidelity-preserving exceptions;
- named radius, shadow, size, font-family, font-size, font-weight, line-height, and tracking primitives;
- conservative semantic color roles such as text, surface, accent, inverse text, and icon foreground while leaving active border semantics unresolved when the evidence cannot prove them;
- compact typography roles that group near-equivalent normalized tuples and retain lower-support alternatives instead of turning every observed tuple into a separate final role;
- the `outer-gutter-inner-container` layout relationship by correlating centered widths across the known audit viewports with spacing evidence;
- `layout.sectionSpacing` only when `section-rhythm.json` identifies one dominant reusable section-root rhythm with sufficient confidence.

For the standard audit viewports, the layout inference can derive page gutter as `(viewport width - widest centered width) / 2`. When those values also exist in the normalized spacing candidates, the proposal records that independent confirmation. The widest responsive width family supplies a proposed desktop `size.content` maximum; narrower repeated centered widths remain explicit inner-container candidates rather than being silently promoted.

Every proposed primitive keeps its source candidate ID(s). `status` distinguishes `core`, `supporting`, and `exception` values. `unresolved` records decisions that still need section/component evidence or another representative page. A strongly inferred `layout.sectionSpacing` may point at a spacing primitive that was otherwise only `supporting`/`exception`: the later conservative review may accept that specific primitive because section-level evidence has now supplied the missing semantic justification. This file is intentionally suitable for acceptance/refinement later, but is not itself `design/tokens.json`.

### Foundation review and token materialization

Create an explicit decision artifact from the proposal:

```bash
npm run site -- migrate foundation review \
  .sitespec/migration/example.com/design
```

The default output is `foundation-review.json` beside `foundation-proposal.json`. The review is the boundary where inference can become canonical source. Each proposed primitive, semantic role, and typography role has an `accept`, `reject`, or `pending` action. Required layout decisions additionally support `provisional`: this does not claim that migration evidence proved a value, it snapshots a compatibility fallback with provenance so one unresolved layout token does not have to block the rest of the foundation. Primitive paths and typography role names are deliberately editable so a reviewer can normalize canonical naming without changing the proposal itself; semantic remaps may target another accepted primitive only when the token type is preserved. Required layout mappings are likewise type-checked as dimensions. Under the conservative policy, a high-confidence `layout.sectionSpacing` inferred by `section-rhythm.json` can be accepted automatically together with its specifically justified spacing primitive. When section rhythm stays unresolved, SiteSpec first preserves the target Design System's current `space.section` value when available; otherwise the installed SiteSpec default-template value is used as an explicitly provisional fallback. The review also records the proposal SHA-256; materialization refuses a stale review when the underlying proposal has changed, and malformed manually edited actions are rejected explicitly.

Re-running `migrate design` preserves an existing `foundation-review.json` instead of deleting reviewer-owned decisions while refreshing generated analysis. Because the new proposal hash will differ whenever the evidence/model changes, the preserved review becomes intentionally stale and must be regenerated with `migrate foundation review ... --force` (or consciously reconciled) before materialization.

The default `conservative` policy accepts only core primitives, semantic roles whose dependencies are accepted and sufficiently confident, core typography roles whose primitive dependencies are accepted, and high-confidence resolved layout relationships. Supporting and exception values stay pending. Use `--policy manual` to start with every decision pending or `--policy all` to stage every proposed primitive/role for acceptance. These policies only initialize the review file; they never write Design System source.

Layout decisions are explicit because the installed Design System contract requires `space.page`, `size.content`, and `space.section`. When the audited outer-container evidence supports it, page gutter is synthesized as one responsive primitive rather than three unrelated viewport values. For example, three confirmed 16/24/32px gutters across mobile/tablet/desktop may normalize to `clamp(16px, 3.125vw, 32px)` when the viewport evidence supports that relationship. `space.section` is accepted automatically only when `section-rhythm.json` identifies one dominant reusable rhythm with sufficient confidence. Otherwise it may be `provisional`: the token stays usable, but its `$extensions.org.sitespec.migration` metadata says that the value came from a compatibility fallback rather than migration evidence. The fallback can later be replaced by an accepted value without changing the semantic token name.

Materialize the accepted decisions into a non-destructive token preview:

```bash
npm run site -- migrate foundation materialize \
  .sitespec/migration/example.com/design/foundation-review.json
```

The default preview is `foundation-tokens.json`, with `foundation-materialization.json` beside it. Materialization rewrites semantic aliases through any reviewer-approved primitive rename and expands each accepted typography role into semantic font-role aliases such as `font.role.heading.32.compact-tracked.size`, `weight`, and `lineHeight`. Provisional tokens are emitted into the same usable token graph but carry migration provenance in `$extensions`; `foundation-materialization.json` reports the overall quality as `canonical` or `provisional` and counts provisional tokens separately. If a target Design System already exists, semantic tokens that its current UI/components/shell still expose but the migration does not yet replace are carried forward provisionally with their primitive dependencies. Accepted imported values always win, explicit rejects are never restored, and truly pending/invalid required decisions still block materialization.

To replace the target project's canonical token source only after the review is ready:

```bash
npm run site -- migrate foundation materialize \
  .sitespec/migration/example.com/design/foundation-review.json \
  --apply --replace
```

`--apply` performs an additional target preflight: `design-system.yaml` and the current Design System must validate, declared layout token names must match the reviewed layout semantics, and accepted font-family primitives must be backed by the target `design/fonts.yaml`. The generated preview already preserves any still-needed target semantic API as provisional compatibility aliases, so current components/shell do not have to be rewritten in the same step as foundation import. Existing `design/tokens.json` is never replaced without `--replace`. The proposal, review, and materialization report remain under `.sitespec/migration/` as provenance even after canonical tokens are applied.

### `section-clusters.json`

Compares major section candidates across pages using deterministic signals rather than copied text alone:

- tag/landmark role;
- content-role counts such as headings, links, buttons, images, forms, and lists;
- DOM tag-shape signatures;
- selected computed style/layout values;
- normalized geometry;
- heading typography;
- label/heading token overlap as a small supporting signal.

Clusters receive an average similarity score plus per-signal averages and provenance back to source page, selector, audit ID, and crop screenshot. A small rule set may suggest names such as `hero`, `testimonials`, `faq`, `site-header`, or `site-footer`, but those names are hypotheses only.

Human-confirmed `manual-dom` segmentation may contribute more than one instance from the same page to a cluster. Same-page manual matches deliberately use a much stricter near-duplicate similarity threshold plus reviewer-name/heading token support. This lets repeated sections such as five manually reviewed feature blocks on one landing page become one proposed section family without grouping unrelated blocks merely because their layout geometry is similar. Once a cluster contains repeated instances from one page, adding evidence from another page also requires name/heading support. Automatic audit segmentation keeps the conservative one-instance-per-page guard so noisy machine-generated wrappers cannot reinforce each other merely because they occur on the same page.

Cross-page `manual-dom` matching also uses a conservative semantic-intent gate before visual/structural similarity can create a cluster. Intent is inferred deterministically from reviewer-owned labels first, then only from strong headings, landmark roles, or distinctive structure. Examples include `hero`, `hero-media`, `logo-cloud`, `product-media`, `feature-showcase`, `features`, `audience`, `lead-form`, `testimonials`, `case-studies`, `faq`, `metrics`, and `breadcrumbs`. If both reviewed blocks have known but conflicting intents, the pair is rejected regardless of its visual score. If one or both intents are unknown, the pair needs a substantially higher similarity score plus reviewer-name/heading token support. The inferred intent and its evidence source are emitted with clustered and unclustered manual members so reviewers can see why the gate behaved as it did.

The v1 clustering threshold is intentionally conservative. Sections that do not form a credible cluster remain under `unclustered`; that is useful evidence and must not be treated as an error. A manual-only cluster may therefore have one page in `pages` while containing several reviewed members from that page; cross-page coverage remains visible separately in the provenance. Human renaming is an explicit way to strengthen semantic evidence when two visually different blocks really do belong to one project-specific family.

### `component-families.json`

Turns reviewed section/shell evidence into a proposed component architecture without generating source. Manual semantic intent takes precedence over a generic cluster label, so for example two visually similar forms labeled as forms remain a `lead-form` family rather than being flattened into a generic CTA family.

Each family records:

- `core`, `supporting`, or `local` reuse status;
- proposed canonical component id and SiteSpec role (`intro`, `content`, `proof`, `conversion`, `utility`) where applicable;
- instance/page coverage, cluster similarity, and reviewer-intent support;
- observed variants inferred only from explicit reviewer-controlled vocabulary such as `carousel`, `split`, or `screencast`;
- conservative prop hints derived from recurring content/structure evidence;
- exact member provenance back to audited sections and screenshots.

Cross-page repeated families can become `core`. Strong repeated families within one page may also become `core` when reviewer intent and structural clustering are both strong (for example a five-item repeated feature family). Two-instance single-page families are normally `supporting`. One-off families remain `local` even when their semantic label is clear.

Leaf UI families are intentionally modeled in a **separate** `ui-families.json` artifact rather than inferred from section descendant counts. A fresh audit writes direct per-element `ui-inventory.json` evidence for visible buttons/button-like links, ordinary links, native inputs/textarea/select/choice controls, plus conservative Badge/Card candidates. When this evidence is present, `component-families.json.coverage.leafControls = "observed"`; legacy audits remain compatible and continue to report `"not-modeled"` instead of fabricating leaf components. Component prop hints separately record occurrence ratio, cross-variant coverage, and an explicit required/optional recommendation, so a recurring image cannot become required API merely because every sampled instance happened to contain one.

Review the proposal with:

```bash
npm run site -- migrate components review \
  .sitespec/migration/example.com/design
```

`component-review.json` stores `accept` / `reject` / `pending` family and variant decisions plus reviewer-editable `componentId`/variant names. The default conservative policy accepts only `core` families. `supporting` and `local` families remain pending until more page evidence or an explicit human decision promotes them. The review is tied to the proposal SHA-256 and is preserved when `migrate design` refreshes generated analysis; use `--force` only when intentionally replacing reviewer-owned decisions.

Generate reviewed section-contract proposals with:

```bash
npm run site -- migrate components contracts \
  .sitespec/migration/example.com/design/component-review.json
```

The command verifies the review/proposal SHA before writing `component-contracts.json` plus `component-contracts/<componentId>/component.yaml` previews for accepted **section** families. The manifests contain only current SiteSpec contract fields that the evidence can support: id/role, accepted variants, conservative prop JSON Schema, and supported placement/page-heading rules. Runtime JavaScript and theme vocabulary are left unresolved rather than guessed. Accepted `site-header`/`site-footer` families are reported as deferred shell-pack work, because SiteSpec shell source is a different library boundary from `components/*`. No `index.astro` or canonical component source is generated.

### `ui-families.json`

Aggregates direct leaf-element audit evidence independently from section families. Native controls and anchors have stronger semantic evidence; Badge/Card remain candidate-weighted because their boundaries come from guarded visual/container heuristics. Reuse is classified as `core` / `supporting` / `local`, visual Button variants (`solid` / `outline` / `ghost`) and native choice variants can be proposed, and exact examples retain page/viewport/selector/segment provenance.

Reuse status and semantic-boundary eligibility are intentionally separate. `status: core` means the family clearly repeats; it does **not** automatically mean SiteSpec should create that primitive. `materialization.eligibility: auto` is reserved for direct semantic/native element evidence. Badge/Card heuristics and the current form-control role gap are `review-required` even when repeated strongly.

Create an explicit leaf UI review with:

```bash
npm run site -- migrate ui review \
  .sitespec/migration/example.com/design
```

The conservative policy auto-accepts only `core` + `auto` families. A repeated Card can therefore remain pending even when its reuse status is `core`. `uiId`, role, and variant ids are reviewer-editable, and the review SHA guards against applying decisions to a changed `ui-families.json`. SiteSpec UI primitives require a canonical `default` variant, so if an observed family contains only named visual variants (`ghost`, `solid`, and so on), the review maps the variant with the strongest observed reuse evidence to `default` and retains its original source id as provenance.

Generate reviewable `ui.yaml` contracts with:

```bash
npm run site -- migrate ui contracts \
  .sitespec/migration/example.com/design/ui-review.json
```

This writes `ui-contracts.json` plus `ui-contracts/<uiId>/ui.yaml` previews for accepted families. Materialization requires an accepted canonical `default` variant and records source-to-canonical variant mappings in the report. It does not create `index.astro`, register canonical UI source, or invent hover/focus/active behavior. Explicitly accepting a `review-required` family is allowed, but the report preserves that override as unresolved provenance/warnings.

Generate a reviewed shell-pack contract from the accepted shell decisions in `component-review.json`:

```bash
npm run site -- migrate shell contracts \
  .sitespec/migration/example.com/design/component-review.json
```

`shell-contracts.json` proposes the `default` shell pack, expected `shell/default.astro` entry, and accepted Header/Footer region files with evidence. It never copies the SiteSpec starter shell or fabricates runtime behavior; missing header/footer architecture produces a partial contract, and Astro implementation remains explicitly unresolved.

### `shell-candidates.json`

Promotes repeated `header`/`footer` landmark clusters into shared shell evidence and reports their cross-page coverage. The generated shell ID is intentionally generic; choose `marketing`, `editorial`, `minimal`, or another project vocabulary only after reviewing the site architecture.

### `media-roles.json`

Groups observed media into migration role hints such as `logo`, `icon`, `product-shot`, `illustration`, `video`, or generic `content-image`, with examples and provenance. These roles help plan SiteSpec v0.5 media ownership; they do not download assets or decide that content/product media belongs to the portable Design System.

### Machine-readable analysis

Use:

```bash
npm run site -- migrate design \
  .sitespec/audit/example.com/home \
  .sitespec/audit/example.com/products-widget \
  --json
```

The CLI result envelope reports the generated output directory, input audits, artifact paths, summary counts, compact token-normalization statistics, and foundation-proposal counts. `component-families.json` and `ui-families.json` use migration artifact version `0.2` for prop-requiredness and materialization-eligibility evidence respectively; other migration artifact versions are independent of project `specVersion`.

### Review boundary

`migrate design` and all review commands never mutate canonical project source. `migrate components contracts`, `migrate ui contracts`, and `migrate shell contracts` write additive contract previews only inside the migration output. `migrate implementations infer` writes migration-owned Astro/token implementation previews only; it does not overwrite a target Design System. `migrate design-system materialize` may create a separate migration-owned staging tree containing a proposed `design-system.yaml`; it still does not mutate the target project's canonical Design System.

The migration workflow still does **not** write or mutate canonical project source such as:

- the project's `design-system.yaml`;
- canonical `design/tokens.json` or `design/extensions.json` unless foundation materialization is explicitly run with `--apply --replace`;
- canonical `ui/*`;
- canonical `components/*`;
- `sections/*`;
- `shell/*`;
- `pages/*`.

`migrate components review` is the explicit shell/section family architecture decision layer; `migrate components contracts` converts accepted section decisions into schema-shaped contract previews. `migrate shell contracts` converts accepted shell decisions into an evidence-backed shell-pack file contract without generating Astro. `migrate ui review` independently decides leaf UI semantic boundaries; `migrate ui contracts` creates schema-shaped `ui.yaml` previews while leaving implementation and interaction-state behavior unresolved. `migrate foundation review` is the token acceptance/refinement step. `migrate foundation materialize` writes a generated token preview by default and mutates canonical `design/tokens.json` only with `--apply --replace`. `migrate implementations infer` then uses accepted contracts plus saved DOM/computed-style evidence to generate migration-owned Astro implementations and additive semantic token extensions, while leaving unobserved interaction states and local font binaries unresolved. Finally, `migrate design-system materialize` assembles the current accepted artifacts into `design-system-staging/`: before implementation inference it is contract-only/partial; afterward it copies the expected implementations, runs Design System lint, and reports `implementation-staging`. Keeping evidence, review, contracts, implementation inference, and staging separate prevents weak heuristics from silently becoming production design rules.

## Recommended extraction workflow

Do not create a Design System from one audit.

For a representative two-page site, start with:

```bash
npm run site -- migrate audit https://example.com/
npm run site -- migrate audit https://example.com/products/widget
```

Then confirm the visual regions of both representative pages:

```bash
npm run site -- migrate segment .sitespec/audit/example.com/home
npm run site -- migrate segment .sitespec/audit/example.com/products-widget
```

Then analyze the shared evidence:

```bash
npm run site -- migrate design \
  .sitespec/audit/example.com/home \
  .sitespec/audit/example.com/products-widget
```

Create the explicit foundation review next:

```bash
npm run site -- migrate foundation review \
  .sitespec/migration/example.com/design
```

Then materialize the reviewed contract graph after component/UI/shell previews are current:

```bash
npm run site -- migrate shell contracts \
  .sitespec/migration/example.com/design/component-review.json

npm run site -- migrate implementations infer \
  .sitespec/migration/example.com/design

npm run site -- migrate design-system materialize \
  .sitespec/migration/example.com/design
```

`migrate implementations infer` creates a migration-owned `implementation-preview/` rather than mutating canonical source. Accepted contracts define the public API and exported file set; audit DOM/computed-style evidence only shapes layout and semantic-token mappings. Generated reusable CSS is constrained to semantic tokens. When an implementation needs a reusable semantic role that is absent from the reviewed foundation (for example control padding/radius or generic typography aliases), the command writes additive `design/extensions.json` aliases to already accepted primitives with migration provenance instead of embedding raw reusable values. Production HTML is not copied verbatim, and unobserved hover/focus/active behavior or client-side state machines are not invented.

After inference the generated `design-system-staging/` can reach `phase: implementation-staging`: accepted Astro files are copied and Design System lint runs. Pending families are excluded instead of becoming placeholders or blockers. Missing local font binaries remain a visual-fidelity warning when the inferred font stack contains a safe fallback; the migration does not copy starter fonts or claim the production font asset was recovered.

Then:

1. inspect exact production foundations and the normalization report before accepting names;
2. accept/reject/rename primitive, semantic, and typography proposals in `foundation-review.json`;
3. inspect `section-rhythm.json`; accept an automatically inferred `space.section` only when the evidence is strong, otherwise resolve the remaining rhythm ambiguity from the cited section examples/clusters rather than inventing a value;
4. run `migrate foundation materialize` and inspect `foundation-tokens.json`;
5. prepare matching local fonts and only then use `--apply --replace` to make the reviewed tokens canonical;
6. find UI primitives repeated on both pages and distinguish page-specific composition from shared patterns;
7. identify recurring section families, Site Shell behavior, and media ownership;
8. create/refine `design-system.yaml`, UI primitives, sections, and shells around the accepted foundation.

After the first Design System exists, migrate a third page that was not used to extract it. The amount of existing vocabulary that the third page can reuse is a better test of Design System quality than how clean the first two implementations look.

## Current boundaries

The migration tooling intentionally does not yet:

- crawl the whole site automatically;
- download or rewrite production assets;
- auto-approve semantic token names without an explicit review artifact;
- mutate the target project's canonical `design-system.yaml` or font manifests/assets; contract staging may generate a migration-owned `design-system-staging/design-system.yaml`;
- install inferred UI/component/shell Astro implementations into canonical project source or generate Page Specs automatically (`migrate implementations infer` emits migration-owned previews and staging only);
- perform visual diffing against a SiteSpec implementation;
- measure Design System coverage against an unaudited page family.

`migrate audit` remains observational while now recording direct leaf UI evidence. `migrate segment` records human-confirmed live production DOM roots without creating Design System source. `migrate design` adds deterministic multi-page proposals with provenance, prefers those manual boundaries when present, derives guarded section rhythm, proposes reusable shell/section families, and separately proposes leaf UI families. `migrate components review` records explicit shell/section architecture decisions; `migrate components contracts` turns accepted section decisions into migration-area `component.yaml` previews, and `migrate shell contracts` records expected shell pack files without Astro. `migrate ui review/contracts` does the same for accepted leaf UI semantic boundaries. `migrate foundation review/materialize` turns accepted decisions plus clearly marked provisional compatibility fallbacks into tokens. `migrate implementations infer` generates contract-shaped Astro previews plus additive semantic implementation aliases from saved DOM/computed-style evidence without copying production HTML or asserting unobserved interactive behavior. `migrate design-system materialize` then assembles reviewed artifacts into contract staging or, when inference is current, design-linted implementation staging; local production font binaries remain separate fidelity work.


### Responsive section evidence

Current audits write two responsive section evidence layers into `sections.json`: a generic per-viewport region index and targeted `manualRegions` for roots already confirmed in `segments.json`. During an owned audit refresh, the completed `segments.json` is preserved and each saved root is resolved independently on desktop, tablet, and mobile. The original live-picker selector is tried first; if responsive rendering changes the DOM path, SiteSpec scores visible DOM candidates against the saved tag/classes/heading/text/structure/ancestry fingerprint and retains only guarded matches. `sections.json` version `0.4` records the source selector, current matched selector, match method, confidence score, fresh computed evidence, and a resolved enclosing boundary container for every fully matched manual group. Boundary resolution starts from the common ancestor of the selected roots and evaluates nearby enclosing ancestors using geometric fit plus vertical-padding evidence, which handles common production structures such as `section > container > heading/cards`. `migrate design` prefers these targeted matches for manual blocks, discounts fingerprint/boundary confidence when computing selector coverage, and uses the resolved boundary padding before falling back to first-root top / last-root bottom padding. Legacy audits remain readable, but only provide the evidence actually present in their older artifacts and therefore should not automatically satisfy responsive section-rhythm gates.

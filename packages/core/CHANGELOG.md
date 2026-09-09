# @sitespec/core

## 0.6.0

### Patch Changes

- b73225f: Add the first existing-site migration workflow with `sitespec migrate audit <url>`, generated production evidence, Chrome/Chromium discovery, and agent-readable migration guidance.
- b73225f: Add `sitespec migrate design <audit...>` for evidence-backed multi-page Design System analysis, including foundation aggregation, normalized token and typography proposals, a dedicated `section-rhythm.json`, a rationalized `foundation-proposal.json`, section clustering, shared-shell candidates, media roles, provenance, and agent-readable workflow discovery. Exact `foundations.json` evidence is preserved while a deterministic normalization layer filters browser/computed noise before token proposals, records every rejection reason/provenance, canonicalizes colors/font stacks/full radii/shadows, narrows responsive container widths, and emits unitless typography line-height candidates. The new foundation layer turns normalized candidates into named primitive scales, conservative semantic roles, grouped typography roles, and an `outer-gutter-inner-container` layout proposal; it can correlate standard audit viewport widths with centered-container evidence to infer responsive page gutters and independently confirm them against spacing candidates without mutating `design/tokens.json`. Section rhythm is inferred only from real section-root top/bottom padding and is cross-checked against reusable section clusters, spacing-property dominance, and desktop/tablet/mobile evidence. One-sided page/header offsets and values dominated by horizontal/gap usage remain weak evidence even when frequent; ambiguous multiple strong tiers remain unresolved. A clearly dominant high-confidence rhythm can propose `layout.sectionSpacing`, and conservative foundation review may accept that specifically justified spacing primitive even when the generic spacing-scale heuristic had classified it as supporting/exception. Re-running design analysis preserves an existing reviewer-owned `foundation-review.json`; the proposal SHA then makes that review stale until an explicit refresh/reconciliation, rather than silently deleting reviewer decisions. Near-identical human-confirmed manual DOM sections with compatible reviewer names may contribute multiple instances from the same page to one section family, while automatic audit segmentation keeps the conservative one-instance-per-page clustering guard. Cross-page manual matching also uses deterministic semantic intent inferred primarily from reviewer labels, rejecting conflicting known purposes regardless of visual similarity and requiring stronger evidence when intent is unknown. Add `migrate foundation review` as the explicit accept/reject/pending boundary with proposal hashing and reviewer-owned token/role renames, plus explicit provisional layout fallback support for unresolved required values, and `migrate foundation materialize` for provenance-backed token previews. Materialization resolves aliases through renamed primitives, type-checks reviewer remaps, synthesizes evidence-backed responsive page-gutter tokens, expands accepted typography roles into semantic aliases, marks provisional compatibility tokens with migration `$extensions`, carries forward missing target semantic API tokens provisionally, keeps genuinely pending/rejected required decisions blocking, and only replaces canonical `design/tokens.json` through an explicit `--apply --replace` target preflight. When `layout.sectionSpacing` blocks materialization, the CLI distinguishes pre-rhythm analysis, a proposal whose review needs regeneration, and genuinely unresolved section-rhythm evidence instead of emitting the same opaque blocker for all three states.
  
  - Capture generic section-region evidence on every audit viewport, preserve completed manual segmentation during audit refreshes, and additionally re-measure every saved manual root directly on each viewport using exact selectors plus guarded DOM-fingerprint fallback.
  - Write targeted manual-root matches to `sections.json` v0.4 with source/current selectors, match method, confidence, and resolved enclosing group-boundary evidence; prefer this evidence for reviewed blocks so arbitrary grouped roots are no longer limited by automatic region candidates.
  - Resolve reviewed group boundaries from the common ancestor plus nearby enclosing ancestors using geometric fit and vertical-padding evidence, allowing `section > container > ...` markup to expose real section padding without weakening the rhythm confidence gates.
  - Infer logical section boundary rhythm from the resolved boundary first and first/last roots only as a fallback, while requiring real per-section viewport confirmation rather than global spacing inventory viewport counts.
  - Allow unresolved required section spacing to be preserved as an explicit provisional compatibility token rather than blocking the rest of foundation materialization. Prefer the target Design System value when available and fall back to the packaged SiteSpec default-template value otherwise; mark provisional token leaves with migration `$extensions` provenance and report canonical/provisional materialization quality separately.
  - Carry forward missing semantic tokens from an existing target Design System provisionally, including their primitive dependencies, so current UI/components/shell keep their semantic API during incremental Design System migration. Accepted imported tokens win and explicit rejects are never restored by compatibility carry-forward.
  - Fix default-template provisional foundation fallback resolution for the ESM-only `@sitespec/template` package by using Node's native ESM resolver; this prevents unresolved `space.section` from remaining a false hard blocker when no target Design System exists.
  
  - Add reviewer-facing `component-families.json` inference for shell/section architecture. Manual semantic intent wins over generic cluster names, repeated/cross-page families are classified as core/supporting/local, and explicit reviewer labels can propose variants.
  - Capture direct leaf UI evidence in audit `ui-inventory.json` and summarize it separately as `ui-families.json`, including Button/Link/native form-control families plus conservative Badge/Card candidates and explicit unresolved state/role gaps instead of inferring leaf controls from section descendant counts.
  - Add `migrate components review` with conservative/manual/all policies, proposal hashing, reviewer-owned component/variant renames, and preservation across `migrate design` refreshes.
  - Add `migrate components contracts` as a SHA-guarded preview step that emits schema-shaped `component.yaml` files only for accepted section families under the migration output, defers accepted shell families to shell-pack work, and refuses to invent runtime/theme behavior or mutate canonical component source.
  - Separate leaf UI reuse strength from semantic-boundary eligibility. `ui-families.json` v0.2 can mark a family `core` while still requiring explicit review when the boundary comes from Badge/Card heuristics or the current form-control role gap.
  - Add `migrate ui review` with conservative/manual/all policies, proposal hashing, reviewer-owned UI/variant naming, and preservation across `migrate design` refreshes. The conservative policy auto-accepts only core families backed by direct semantic/native evidence.
  - Add `migrate ui contracts` as a SHA-guarded preview step that emits schema-shaped `ui.yaml` files for accepted leaf families under the migration output while keeping implementations and hover/focus/active behavior unresolved. UI review now guarantees the SiteSpec-required canonical `default` variant by mapping the most-supported observed variant when the source family only has named variants, preserving source-to-canonical provenance and rejecting accepted reviews that still omit `default`.
  - Make section component prop requiredness evidence-based: component-family prop hints now record presence ratio, cross-variant coverage, and a conservative required/optional recommendation so incidental media is not promoted to required API merely because it appears in every sampled instance.
  - Add `migrate shell contracts` to turn accepted shell-family review decisions into an evidence-backed default shell-pack file contract without fabricating Astro implementations.
  - Add `migrate design-system materialize` to assemble current foundation tokens plus accepted UI/section manifests and shell contracts into a migration-owned contract staging tree. Pending/rejected families are excluded; missing local fonts and Astro implementations remain explicit blockers for the next phase.
  - Advance the agent protocol to version 6 with shell-contract and Design System staging workflow/output discovery.
  - Add `migrate implementations infer` to turn accepted foundation/UI/section/shell contracts plus saved DOM/computed-style evidence into migration-owned Astro implementation previews, additive semantic implementation-token aliases, and a fallback-only font manifest without copying production HTML or fabricating unobserved interaction state.
  - Let `migrate design-system materialize` consume a current implementation inference report, copy only expected accepted Astro files, run Design System lint, and report `implementation-staging`; contract-only staging remains supported when inference has not run.
  - Treat local production font binaries and unobserved hover/focus/active or responsive-menu behavior as fidelity follow-up rather than filling them from starter assets. Generated reusable CSS uses semantic tokens, with missing implementation roles derived as additive semantic aliases to already accepted primitives.
  - Advance the agent protocol to version 7 with implementation-inference workflow and output discovery.
  - Fix implementation inference/design lint interoperability for transparent section and shell backgrounds: color-only evidence now emits `background-color`, and `background: transparent`/CSS-wide keywords are not treated as raw design colors.
  - Include design-lint path and actual declaration in Design System staging blockers so implementation validation failures identify the exact generated CSS declaration.
- b73225f: Add `sitespec migrate segment <audit>` as a live production DOM picker, persist exact selectors/fingerprints/content-style-structure evidence in `segments.json`, support Inspect/Interact modes, draggable/collapsible inspector UI, explicit Block names, reload/reinjection with state restoration, bounded scrolling for long block lists with stable scroll position during selection, multi-root logical blocks, batch selection and Merge/Ungroup/Delete of existing blocks, editable Header/Footer roots without duplicate-shell errors, fixed/sticky geometry handling, immediate return to Inspect after block edits, and single-tab Chrome reuse so the live picker does not open a redundant blank tab; make `migrate design` prefer completed manual DOM segments over automatic section candidates and preserve grouped root selectors in clustering provenance.

## 0.5.0

### Minor Changes

- Add the v0.5 media and SEO contract, validation, hreflang clusters, structured data graphs and generated social metadata.
- Keep accessibility and remote-dimension checks in the v0.5 media validator so component schemas remain structurally composable, normalize root hreflang URLs, and preserve the v0.1–v0.4 image schema unchanged.

## 0.4.0

### Minor Changes

- Add the SiteSpec 0.4 first-class Design System contract, token extension policy, themes, shell packs, layout conventions, Design System inspection, v0.4 schemas/types, and agent protocol v4 while retaining v0.1-v0.3 compatibility.

## 0.3.0

### Minor Changes

- cbd722e: Add SiteSpec 0.3 typed content collections, Markdown entries, relations, content-driven routes, declarative filtering/sorting/pagination, draft handling, entry/query references, content inspection, and base-path rebasing for rendered Markdown links.

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- 9576401: Ship the SiteSpec 0.2 composition model: formal UI primitives, reusable section presets, deterministic dynamic route expansion with route-parameter references, a pagination core type, richer agent inspection, and a v0.2 starter that dogfoods the new composition layers.

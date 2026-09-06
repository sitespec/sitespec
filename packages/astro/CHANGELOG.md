# @sitespec/astro

## 0.5.0

### Minor Changes

- Add responsive AVIF/WebP image generation, focal cropping, social images, richer head metadata, sitemap/hreflang, robots, llms.txt and RSS generation.
- Materialize generated sitemap, robots, llms.txt and RSS files in the dev public directory so development and production expose the same metadata endpoints.

## 0.4.0

### Minor Changes

- Render SiteSpec 0.4 Design System themes and selected shell packs, compile additive token extensions, and validate every declared shell-pack entry.

### Patch Changes

- @sitespec/core@0.4.0

## 0.3.0

### Minor Changes

- cbd722e: Add SiteSpec 0.3 typed content collections, Markdown entries, relations, content-driven routes, declarative filtering/sorting/pagination, draft handling, entry/query references, content inspection, and base-path rebasing for rendered Markdown links.

### Patch Changes

- Updated dependencies [cbd722e]
  - @sitespec/core@0.3.0

## 0.2.2

### Patch Changes

- @sitespec/core@0.2.2

## 0.2.1

### Patch Changes

- 80463a9: Expand the default v0.2 starter into an executable showcase of the composition model: deterministic dynamic feature routes with `param:` references, reusable section presets across pages, named navigation references, a pagination component backed by the v0.2 core type, a bundled local WOFF2 font, complete semantic site assets, richer starter inspection docs, and a concise project documentation entry point with getting-started and core-concepts guides.
  
  Rebase `previousHref` and `nextHref` values from typed pagination props when rendering sites under a deployment base path such as GitHub Pages.
- @sitespec/core@0.2.1

## 0.2.0

### Minor Changes

- 9576401: Ship the SiteSpec 0.2 composition model: formal UI primitives, reusable section presets, deterministic dynamic route expansion with route-parameter references, a pagination core type, richer agent inspection, and a v0.2 starter that dogfoods the new composition layers.

### Patch Changes

- Updated dependencies [9576401]
  - @sitespec/core@0.2.0

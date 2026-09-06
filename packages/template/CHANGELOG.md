# @sitespec/template

## 0.2.2

### Patch Changes

- a59ca72: Use self-hosted Inter as the default starter typeface and make the pagination showcase use real static page routes (/examples, /examples/page/2, /examples/page/3) so page state changes correctly without client JavaScript.

## 0.2.1

### Patch Changes

- 80463a9: Expand the default v0.2 starter into an executable showcase of the composition model: deterministic dynamic feature routes with `param:` references, reusable section presets across pages, named navigation references, a pagination component backed by the v0.2 core type, a bundled local WOFF2 font, complete semantic site assets, richer starter inspection docs, and a concise project documentation entry point with getting-started and core-concepts guides.
  
  Rebase `previousHref` and `nextHref` values from typed pagination props when rendering sites under a deployment base path such as GitHub Pages.

## 0.2.0

### Minor Changes

- 9576401: Ship the SiteSpec 0.2 composition model: formal UI primitives, reusable section presets, deterministic dynamic route expansion with route-parameter references, a pagination core type, richer agent inspection, and a v0.2 starter that dogfoods the new composition layers.

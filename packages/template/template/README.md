# __SITE_NAME__

SiteSpec v0.3 starter and executable contract showcase.

The starter stays deliberately small while demonstrating both composition and content:

- typed Markdown collections in `content/*`;
- content-driven detail routes with `content.entry` and `entry:` references;
- declarative listing queries with sorting and pagination through `query:` references;
- formal UI primitives in `ui/*`;
- reusable section presets in `sections/*`;
- deterministic non-content dynamic routes with `page.paths` and `param:<name>`;
- named navigation collections and `navigation:<id>` references;
- the `urn:site-spec:0.3:type:pagination` core type;
- self-hosted Inter web fonts declared in `design/fonts.yaml`;
- semantic favicon, Apple touch icon and default Open Graph image assets;
- user-owned Site Shell and semantic design tokens;
- agent-readable project and content inspection.

## Starter routes

- `/` — overview of the composition and content model.
- `/blog` — query-driven Markdown listing, page 1.
- `/blog/page/2` — generated from the same paginated content query.
- `/blog/content-driven` — generated from `content/posts/content-driven.md`.
- `/blog/hello-sitespec` — generated from `content/posts/hello-sitespec.md`.
- `/features` — links to the explicit dynamic feature routes.
- `/features/composition` — generated from `pages/feature.yaml`.
- `/features/dynamic-routes` — generated from `pages/feature.yaml`.
- `/features/agent-protocol` — generated from `pages/feature.yaml`.

## Inspect the contract

```bash
npm run site -- spec --json
npm run site -- spec content --json
npm run site -- spec collection:posts --json
npm run site -- spec entry:posts/content-driven --json
npm run site -- spec /blog/content-driven --json
npm run site -- spec shell --json
npm run site -- spec design --json
npm run site -- spec fonts --json
npm run site -- spec assets --json
npm run site -- spec ui --json
npm run site -- spec sections --json
npm run site -- spec navigation:primary --json
npm run site -- validate --json
```

## Run the site

```bash
npm run dev
npm run build
npm run preview
```

For GitHub Pages deployment:

```bash
npm run site -- deploy github-pages
```

# __SITE_NAME__

SiteSpec v0.2 project and executable composition-model showcase.

The starter intentionally demonstrates the v0.2 contract instead of shipping a large component gallery:

- formal UI primitives in `ui/*`;
- reusable section presets in `sections/*`;
- deterministic dynamic routes with `page.paths`;
- route-parameter references with `param:<name>`;
- named navigation collections and `navigation:<id>` references;
- the `urn:site-spec:0.2:type:pagination` core type;
- self-hosted Inter web fonts declared in `design/fonts.yaml` (OFL-1.1; no runtime Google Fonts request);
- semantic favicon, Apple touch icon and default Open Graph image assets;
- user-owned Site Shell and semantic design tokens;
- agent-readable project inspection.

## Starter routes

- `/` — overview of the composition model.
- `/features` — links to the generated dynamic feature routes.
- `/features/composition` — generated from `pages/feature.yaml`.
- `/features/dynamic-routes` — generated from `pages/feature.yaml`.
- `/features/agent-protocol` — generated from `pages/feature.yaml`.
- `/examples` — pagination example, page 1.
- `/examples/page/2` — pagination example, page 2.
- `/examples/page/3` — pagination example, page 3.

## Inspect the contract

```bash
npm run site -- spec --json
npm run site -- spec /features/composition --json
npm run site -- spec shell --json
npm run site -- spec design --json
npm run site -- spec fonts --json
npm run site -- spec assets --json
npm run site -- spec ui --json
npm run site -- spec sections --json
npm run site -- spec section:final-cta --json
npm run site -- spec navigation:primary --json
npm run site -- spec navigation:features --json
npm run site -- spec navigation:project --json
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

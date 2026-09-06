# Marketing Content Example

Executable SiteSpec v0.4 Design System and Content reference.

This example installs its own formal `sitespec-marketing` Design System contract and exercises the broader Content API beyond the intentionally small starter:

- `posts`, `authors`, `categories`, and `tags` typed collections;
- Markdown entries plus YAML data entries;
- generic one-to-one and one-to-many relations;
- canonical relation `href` values through content-driven entry pages;
- `entry:` and `query:` references;
- filtering and deterministic date sorting;
- generated query pagination at `/blog/page/[page]`;
- content-driven post, author, category, and tag routes;
- draft detail routes excluded from published queries and production output;
- content inspection through the CLI.

## Run from the monorepo

From the repository root:

```bash
npm install
npm run build
npm run dev -w @sitespec/example-marketing
```

The root build compiles the workspace packages used by the example. The stable `sitespec` CLI shim exists before build, so npm can link the executable during installation; if the compiled CLI is missing, the shim reports that the root build is required.

Other useful commands:

```bash
npm run validate -w @sitespec/example-marketing
npm run build -w @sitespec/example-marketing
npm run preview -w @sitespec/example-marketing
npm run site -w @sitespec/example-marketing -- spec design-system --json
npm run site -w @sitespec/example-marketing -- spec content --json
```

## Routes

Useful routes after starting the example:

```text
/blog
/blog/page/2
/blog/page/3
/blog/typed-relations
/blog/author/maya
/blog/category/engineering
/blog/tag/content
```

`/blog/roadmap-note` is a draft entry: it is available for development/inspection but excluded from normal listings and production output.

## Inspection

```bash
npm run site -w @sitespec/example-marketing -- spec --json
npm run site -w @sitespec/example-marketing -- spec content --json
npm run site -w @sitespec/example-marketing -- spec collection:posts --json
npm run site -w @sitespec/example-marketing -- spec collection:authors --json
npm run site -w @sitespec/example-marketing -- spec entry:posts/typed-relations --json
npm run site -w @sitespec/example-marketing -- spec /blog/category/engineering --json
```

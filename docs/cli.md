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

## Design System commands

Inspect the installed first-class Design System through the `site spec` surface requested by the v0.4 agent contract:

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

Install a pack into a SiteSpec v0.4 project:

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

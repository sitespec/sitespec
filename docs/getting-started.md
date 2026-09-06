# Getting started

This guide creates a standalone SiteSpec website, shows where its source lives, and walks through the basic inspect → edit → validate → build loop.

## Requirements

Use Node.js 22 or newer and npm.

Check your local versions:

```bash
node --version
npm --version
```

## 1. Create a site

Run the official project initializer:

```bash
npm create @sitespec@latest acme
```

Then enter the project:

```bash
cd acme
```

The initializer copies the default SiteSpec template, installs dependencies by default, initializes Git when available, and pins the SiteSpec CLI through the generated lockfile.

If you need a non-interfering scaffold for automation or testing, the initializer also supports:

```bash
npm create @sitespec@latest acme -- --no-install --no-git
```

## 2. Run the development server

```bash
npm run dev
```

Development mode resolves the SiteSpec source into the local Astro workspace, validates changes, and uses Astro HMR for the rendered site. Generated `.site/` files are build artifacts; do not edit them manually.

## 3. Inspect the project contract

SiteSpec exposes the resolved project model as JSON:

```bash
npm run site -- spec --json
```

Useful focused inspections include:

```bash
npm run site -- spec design --json
npm run site -- spec fonts --json
npm run site -- spec assets --json
npm run site -- spec ui --json
npm run site -- spec sections --json
npm run site -- spec navigation:primary --json
```

The default v0.2 starter is intentionally a working composition-model example, so these commands return real data instead of empty placeholder contracts.

## 4. Understand the source tree

The main website-owned sources are:

```text
site.yaml               global site contract
pages/*.yaml            route and page composition
sections/*.yaml         reusable configured section presets
components/*            public section components
ui/*                    internal UI primitives
design/tokens.json      primitive and semantic design tokens
design/fonts.yaml       local web-font declarations
shell/*                  user-owned document/site shell
public/*                 static assets
content/*                content sources
```

`site.yaml`, Page Specs, section presets, and component contracts describe the website. Astro files implement the markup for registered components, UI primitives, and the shell.

## 5. Edit a page

Open `pages/home.yaml`. A page selects registered section components and passes data that must satisfy each component's prop schema.

A small example:

```yaml
specVersion: "0.2"

page:
  id: home
  route: /
  archetype: marketing

seo:
  title: Home
  description: Example SiteSpec home page.

sections:
  - id: intro
    use: hero
    props:
      eyebrow: SiteSpec
      title: The specification is the source of truth
      text: Page composition lives in a validated, inspectable contract.

  - id: final-cta
    $ref: section:final-cta
```

The page does not contain Astro markup. `use: hero` points to a registered component, while `$ref: section:final-cta` reuses an already configured section preset.

## 6. Validate before building

Run validation directly:

```bash
npm run validate
```

For structured diagnostics suitable for agents and tooling:

```bash
npm run site -- validate --json
```

Validation covers the source contract, references, component props, composition rules, assets, design usage, routes, and other deterministic project constraints.

## 7. Build and preview

Create the production static output:

```bash
npm run build
```

Then preview that build:

```bash
npm run preview
```

`dist/` is generated output and should not be treated as website source.

## 8. Add controlled building blocks

Create a new public section component:

```bash
npm run site -- add component comparison-table
```

Create a new internal UI primitive:

```bash
npm run site -- add ui badge
```

SiteSpec generates the required contract files and refuses to overwrite an existing registered item.

## Next

Read [Core concepts](concepts.md) for the boundaries between Site, Page, section presets, components, UI primitives, design tokens, and the Site Shell.

For an existing v0.1 project, see [Migrating from specVersion 0.1 to 0.2](MIGRATING-0.2.md).

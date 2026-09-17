# Design Systems

SiteSpec v0.4 makes the Design System a first-class, versioned source contract rather than a collection of conventions spread across a project.

A Design System owns the reusable visual language and implementation layer that can be shared between sites:

```text
design-system.yaml
        ↓
tokens + fonts + themes + layout convention
        ↓
UI primitives
        ↓
section library + section presets
        ↓
shell packs
```

Page Specs and content remain site-owned. A Design System pack is copied into a site, so the built site has no runtime dependency on a separate design-system package.

## Contract

Every v0.4+ project has `design-system.yaml`; the current format is v0.7.

```yaml
specVersion: "0.7"

designSystem:
  id: inappstory
  name: InAppStory
  version: 1.0.0

tokens:
  source: design/tokens.json
  extension: design/extensions.json
  rules:
    primitive: locked
    semantic: additive

fonts:
  source: design/fonts.yaml
  assetsRoot: public/fonts

themes:
  default: default
  items:
    default:
      label: Default
    dark:
      label: Dark
      source: design/themes/dark.json

layout:
  convention: outer-gutter-inner-container
  tokens:
    pageGutter: space.page
    contentWidth: size.content
    sectionSpacing: space.section

libraries:
  ui: [button, container]
  sections: [hero, feature-grid, cta]
  presets: [final-cta]

shells:
  default: marketing
  items:
    marketing:
      entry: shell/marketing.astro
      files:
        - shell/marketing.astro
        - shell/Header.astro
        - shell/Footer.astro
```

The contract is validated against the current v0.7 Design System JSON Schema. Referenced UI primitives, sections, presets, shell files, theme files, and layout tokens must exist.

## Inspect the Design System

From a site:

```bash
npm run site -- spec design-system --json
```

The dedicated command returns the same Design System as a portable-pack inspection surface:

```bash
npm run site -- design-system --json
```

The JSON result includes identity/version, exported libraries, shell packs, themes, layout convention, token extension policy, token counts, font families, and copy/install semantics.

## Typography foundations

Typography follows the same primitive-to-semantic boundary as color, spacing, and radius. Primitive tokens hold the raw type decisions; reusable UI, section, and shell code consumes only semantic typography variables.

The bundled Design System models family, size, line-height, weight, and letter-spacing. For example:

```text
primitive.font.weight.bold           -> 700
semantic.font.weight.action          -> primitive.font.weight.bold
                                       -> --font-weight-action

primitive.font.letterSpacing.display -> -0.045em
semantic.font.letterSpacing.display  -> primitive.font.letterSpacing.display
                                       -> --font-letter-spacing-display
```

`font-weight` and `letter-spacing` are design-linted alongside `font-family`, `font-size`, and `line-height`. Raw reusable values such as `font-weight: 700` or `letter-spacing: -0.045em` are rejected inside UI primitives, sections, and Site Shell code; use the semantic token that describes the role instead.

Design Lab Foundations renders both the semantic typography vocabulary and the primitive typography scale so family, size, line-height, weight, and tracking can be reviewed visually.

## UI primitives and section libraries

`libraries.ui` is the exported internal UI layer. Page Specs cannot use these primitives directly.

`libraries.sections` is the exported page-composition library. Those components may be selected by Page Specs.

`libraries.presets` exports reusable configured sections from `sections/*.yaml`. An exported preset must target a section exported by the same Design System.

This keeps the public composition API separate from lower-level UI implementation details.

Interactive UI primitives can declare a separate state axis in `ui.yaml`:

```yaml
variants:
  - default
  - primary
  - secondary

states:
  - default
  - hover
  - active
  - focus-visible
  - disabled
```

`variants` describe intentional visual/API variants; `states` describe interaction states of each variant. They must not be flattened into names such as `primary-hover`. `action` and `navigation` primitives that omit expected interactive states remain compatible with existing v0.7 projects, but validation emits `UI_INTERACTIVE_STATES_INCOMPLETE` until the states are explicitly modeled. A declared state must be implemented by real production semantics (`:hover`, `:active`, `:focus-visible`, `:checked`, readonly/disabled attributes, or `aria-invalid`/native invalid semantics) and paired with the equivalent `[data-sitespec-state="<state>"]` selector. The latter is a deterministic Design Lab preview hook; it does not replace the real browser interaction selector.

Form controls use the explicit `form` UI role. The state vocabulary additionally includes `invalid`, `readonly`, and `checked`; form primitives declare only the states they actually support. The bundled Design System exports `text-field`, `textarea-field`, `select-field`, `checkbox`, `radio-group`, and `switch`. These primitives own label/control/help/error wiring so section implementations do not have to recreate accessibility relationships for every form.

The bundled Button is dual-mode: with `href` it renders an anchor-style action, and without `href` it renders a native `<button>` with `button`, `submit`, or `reset` type. This lets forms consume the same action primitive without turning submit controls into links.

Form presentation is tokenized through semantic `color.field.*`, `color.control.*`, control size, switch size, and full-radius tokens. Dark theme overrides those semantics rather than restyling primitives directly.

## Layout convention

v0.4 formalizes the layout boundary between the outer page/shell and inner content container.

The current convention is `outer-gutter-inner-container`:

- the outer shell or section owns responsive page gutter through the declared `pageGutter` semantic token;
- the inner container owns its maximum content width through `contentWidth`;
- vertical section rhythm comes from `sectionSpacing`.

The contract stores semantic token paths rather than concrete CSS values. Validation fails when a declared layout token does not exist in the Design System semantic vocabulary.

## Token extension rules

The installed Design System owns `design/tokens.json`. A site can add tokens in `design/extensions.json` without modifying the pack source.

Each layer is either:

- `locked` — site additions for that layer are forbidden;
- `additive` — new token paths are allowed, but overriding a pack token is forbidden.

Example site extension:

```json
{
  "primitive": {
    "color": {
      "campaign": { "$type": "color", "$value": "#725cff" }
    }
  },
  "semantic": {
    "color": {
      "campaign": { "$type": "color", "$value": "{primitive.color.campaign}" }
    }
  }
}
```

Semantic tokens and theme overrides must alias primitive tokens with a compatible type. Reusable UI/components/shell code continues to consume semantic CSS variables only.

`design/extensions.json` is site-owned and is intentionally not included in a portable Design System pack or deleted during `--replace`.

## Themes

Themes are named semantic-token override sets declared by the Design System.

A theme file may override existing semantic token paths only. It cannot add a new semantic vocabulary; new paths belong in the token extension layer.

A site chooses a theme in `site.yaml`:

```yaml
designSystem:
  theme: dark
```

The renderer compiles theme values under `data-site-theme="<id>"` and writes the selected theme on the document root.

## Shell packs

A Design System can contain more than one site shell. Each shell pack declares an Astro entry and every source file that belongs to that shell.

A site selects a shell in `site.yaml`:

```yaml
designSystem:
  shell: docs
```

Every shell entry must render `<slot />`. The renderer imports the selected shell instead of assuming `shell/default.astro`.

## Design Lab

Use the Design Lab while developing or reviewing the installed Design System:

```bash
npm run site -- design dev
```

When run from a normal SiteSpec project, the current directory is the project root. When run from the SiteSpec source repository itself, the repository root is not a website, so the command automatically opens `examples/marketing` as the bundled executable Design System fixture. Pass `--root <path>` to select another project explicitly.

`design lab` is an alias for the same command. The Lab is generated inside SiteSpec's existing Astro development runtime and does not add source files to the website. It renders the actual exported Design System implementation, not a parallel Storybook layer.

The Design Lab built on the v0.7 Design System contract provides four review surfaces:

- **Foundations** — semantic color, typography, spacing, size, radius, and other tokens;
- **UI** — every exported UI primitive as a `variant × state` matrix, including declared hover/active/focus-visible/disabled/invalid/readonly/checked states, plus a real Form composition benchmark when the form foundation is installed;
- **Sections** — every exported section across declared variant/theme combinations;
- **Pages** — the project's published pages in desktop, 768 px, and 375 px frames.

The global theme selector switches the real `data-site-theme` value everywhere, including the page iframe. **Stress** swaps generated contract-valid fixtures for longer copy and denser arrays, so wrapping and content-resilience problems become visible without changing Page Specs. In **Pages**, the preview uses a dedicated generated route for the selected page, theme, and stress state; section props are replaced only when SiteSpec can derive a valid stress fixture from `component.yaml`, navigation labels are expanded, and production rendering remains unchanged. Fixtures are derived from `ui.yaml` and `component.yaml`; if SiteSpec cannot generate a valid fixture for a contract, the Lab shows that UI/section case as unsupported or keeps the original page-section props instead of inventing invalid data.

The Lab is intentionally the first layer of the design-system generator. Candidate generation, mutation, locking, and side-by-side candidate comparison should build on this preview runtime rather than introduce a second rendering model.

## Pack and install workflow

Create a portable source pack from a project that contains the Design System you want to reuse:

```bash
npm run site -- design-system pack ../inappstory-design-system
```

The pack contains only Design System-owned source:

- `design-system.yaml`;
- base tokens and declared theme files;
- font declarations and the complete declared font asset root;
- exported UI primitives;
- exported section components and presets;
- declared shell-pack files.

It does not copy `site.yaml`, Page Specs, content, or `design/extensions.json`. After copying, `pack` validates the standalone directory again, so a Design System cannot accidentally depend on site-owned token extensions that will not travel with it.

Install that pack into another v0.7 site:

```bash
npm run site -- design-system install ../inappstory-design-system --replace
```

`--replace` removes files owned by the currently installed Design System and preserves site-owned token extensions. Without `--replace`, collisions are rejected. `--force` is available only for an intentional overwrite of unmanaged colliding files.

After installation the source is physically present in the target repository. Validation, agents, and the renderer need no network access and no runtime dependency on the original pack.

## Reusing an InAppStory Design System

A practical organization-level workflow is:

1. Build and validate the InAppStory Design System once in a dedicated SiteSpec project.
2. Set its stable identity and semantic version in `design-system.yaml`, for example `inappstory@1.4.0`.
3. Export it with `design-system pack`.
4. Install the copy into each SiteSpec v0.7 website.
5. Keep per-site visual additions in `design/extensions.json` where the contract allows them.
6. To adopt a newer InAppStory Design System, install the newer pack with `--replace`, validate the site, and commit the copied source change.

The Design System is reusable, but every website remains independently buildable from its own Git repository.


### Shell interaction reference

The bundled starter shell includes a token-driven `icon-button` UI primitive, a light/dark preference toggle persisted in `localStorage`, and a mobile navigation menu with `aria-expanded`, `aria-controls`, Escape-to-close, and focus restoration. Design Lab page previews use forced theme routes, so persisted user preferences never override the Lab-selected theme; internal shell navigation remains inside the same `theme × stress` preview namespace.

### Shell runtime

A shell pack that ships executable client JavaScript must declare `shells.items.<id>.runtime.javascript: true` in `design-system.yaml`. This opt-in covers the pack files listed by that shell and is enforced both at source-contract validation and rendered-output validation. Static shell packs can omit `runtime`.

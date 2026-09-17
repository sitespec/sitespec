# Design Lab

Design Lab is SiteSpec 0.8.0's built-in visual development and review environment for the installed Design System. It uses the same contracts, Astro implementations, tokens, themes, Site Shell, validation, and page renderer as the website itself; there is no parallel component-demo implementation to keep in sync.

The current document contract remains `specVersion: "0.7"`.

## Start the Lab

From a SiteSpec project:

```bash
npm run site -- design dev
```

`design lab` is an alias. Common options are:

```text
--root <path>
--host <host>
--port <port>
--json
```

When run from the SiteSpec source repository root, the command automatically uses `examples/marketing`, because the repository root itself is not a website. Use `--root <path>` to inspect another project explicitly.

The Lab is exposed at `/__sitespec/design/`. Generated Lab source lives under `.site/astro/` and is disposable. Do not copy it into the website source.

## Review surfaces

### Foundations

Foundations shows the installed token vocabulary rather than a separate hard-coded palette. It includes semantic colors, spacing, sizes, radii, and typography, plus the primitive typography scale used to review family, size, line-height, weight, and letter-spacing.

Reusable UI, sections, and shell code should consume semantic variables. A primitive value being visible in Foundations does not make direct `var(--primitive-...)` usage valid in reusable implementation code.

### UI

UI renders every primitive exported by `design-system.yaml`. Variants and states are independent axes, so a Button with three variants and five states is reviewed as a matrix rather than as flattened names such as `primary-hover`.

Current states are:

```text
default
hover
active
focus-visible
disabled
invalid
readonly
checked
```

Each primitive declares only the states it supports in `ui.yaml`. SiteSpec derives normal/stress fixtures from that contract. Unsupported fixture shapes are reported instead of being filled with invalid props.

Form controls use `ui.role: form`. The default Design System exports text/textarea/select fields, checkbox, radio group, and switch, and the Lab includes a composed form benchmark so spacing, labels, descriptions, errors, checked states, and submit actions can be reviewed together.

## Deterministic interaction-state previews

A declared state must have real production semantics and a deterministic Lab selector. For example:

```css
.button:is(:hover, [data-sitespec-state="hover"]) {
  /* semantic-token styles */
}

.button:is(:focus-visible, [data-sitespec-state="focus-visible"]) {
  /* semantic-token styles */
}
```

The browser pseudo-class/attribute remains the production behavior. `data-sitespec-state` is only the deterministic preview hook used by Design Lab. It must not replace the real interaction selector.

The Lab disables pointer interaction inside state-matrix cells so accidental mouse hover cannot change the state being reviewed.

### Sections

Sections renders the actual exported page-section implementations across their declared variants and themes. Fixtures come from `component.yaml`; the Lab does not invent arbitrary component props when the contract cannot support them.

### Pages

Pages renders real published SiteSpec pages at desktop, 768 px, and 375 px widths. This is where the Design System is reviewed as an assembled site rather than as isolated components.

The repository example includes `/contact`, which composes the form foundation through the normal hierarchy:

```text
Page Spec
  → contact-form section
    → form UI primitives
```

## Theme and Stress

The Theme control applies the selected Design System theme to Foundations, UI, Sections, and Pages. The Stress control uses contract-valid long/ dense fixtures to expose wrapping, overflow, spacing, and content-resilience problems.

Page previews use dedicated generated routes that encode the selected theme and stress mode, for example:

```text
/sitespec-design-preview/dark/stress/contact
```

Internal shell navigation stays inside that preview namespace, so navigating between pages does not reset the selected Theme or Stress mode.

The normal site may persist a user theme preference in its own Site Shell. Design Lab preview routes are forced review states and do not let that persisted preference override the Lab-selected theme.

## Production boundary

Design Lab behavior is development-only. Ordinary generated page sources and production routes do not contain Design Lab preview bootstrap identifiers or query-state logic.

If the Site Shell itself contains client JavaScript (for example theme persistence or a burger menu), that is normal site behavior and must be declared by the selected shell pack:

```yaml
shells:
  items:
    default:
      entry: shell/default.astro
      runtime:
        javascript: true
```

This shell runtime is validated separately from Design Lab preview behavior.

## Recommended review loop

For Design System work:

1. Run `npm run dev` for the real site.
2. Run `npm run site -- design dev` in a second terminal.
3. Change tokens/contracts/implementations in the project source.
4. Check Foundations before consuming new token roles.
5. Check UI state matrices, including dark theme and Stress.
6. Check relevant Sections.
7. Check real Pages at desktop and 375 px; use 768 px for the intermediate breakpoint.
8. Run `npm run validate` before committing.
9. Run `npm run build` (or the repository test suite when working on SiteSpec itself) before release.

The Lab is a review environment, not a second source of truth. Fix the Design System contracts/tokens/implementations in the repository and let the Lab reflect those changes.

## Related documentation

- [Design Systems](design-systems.md) — ownership, tokens, themes, UI/section libraries, shell packs, pack/install.
- [CLI reference](cli.md) — command syntax and root resolution.
- [Core concepts](concepts.md) — Page → Section → UI and Site Shell boundaries.
- [Getting started](getting-started.md) — normal project workflow.

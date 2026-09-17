# SiteSpec documentation

This documentation describes SiteSpec 0.8.0 and the current `specVersion: "0.7"` document contract. Engine/package releases and document versions are intentionally separate.

If you are new to SiteSpec, read:

1. [Getting started](getting-started.md) — create a site and use the edit → inspect → validate → build loop.
2. [Core concepts](concepts.md) — understand the contract, composition layers, content model, and renderer boundary.
3. [Design Systems](design-systems.md) — define, inspect, pack, install, theme, and extend reusable design systems.
4. [Design Lab](design-lab.md) — visually review foundations, UI states/forms, sections, themes, stress fixtures, and responsive pages.
5. [Content](content.md) — define typed collections, relations, queries, pagination, and content-driven routes.
6. [Existing-site migration](migration.md) — audit production pages, manually confirm representative visual regions, analyze shared design evidence, then extract a SiteSpec Design System.
7. [CLI reference](cli.md) — run, inspect, validate, build, preview, migrate, and work with the monorepo example.

## Guides and reference

### Getting started

- [Getting started](getting-started.md)

### Concepts

- [Core concepts](concepts.md)

### Specification

- [Design Systems](design-systems.md)
- [Design Lab](design-lab.md)
- [Content](content.md)
- [Media & SEO](media-seo.md)
- [Google Analytics and HubSpot](integrations.md)

The JSON Schemas in the codebase remain the machine-readable source of truth. Documentation explains how the current contract is intended to be used rather than duplicating every schema constraint.

### Migration

- [Existing-site migration](migration.md)

### CLI

- [CLI reference](cli.md)

### Project maintenance

- [Releasing SiteSpec](RELEASING.md)
- [Changelog](../CHANGELOG.md)

## Documentation rules

When changing SiteSpec:

- keep the root [`README.md`](../README.md) short and current;
- document the supported contract, not historical upgrade paths;
- put conceptual boundaries in concept documents;
- put task-oriented instructions in guides;
- update Design Systems, Design Lab, Content, Migration, and CLI docs when their contracts change;
- keep examples executable and aligned with the documented syntax.

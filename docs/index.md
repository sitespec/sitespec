# SiteSpec documentation

This documentation describes the current SiteSpec `specVersion: "0.5"` contract and the workflows supported by the repository today.

If you are new to SiteSpec, read:

1. [Getting started](getting-started.md) — create a site and use the edit → inspect → validate → build loop.
2. [Core concepts](concepts.md) — understand the contract, composition layers, content model, and renderer boundary.
3. [Design Systems](design-systems.md) — define, inspect, pack, install, theme, and extend reusable design systems.
4. [Content](content.md) — define typed collections, relations, queries, pagination, and content-driven routes.
5. [CLI reference](cli.md) — run, inspect, validate, build, preview, and work with the monorepo example.

## Guides and reference

### Getting started

- [Getting started](getting-started.md)

### Concepts

- [Core concepts](concepts.md)

### Specification

- [Design Systems](design-systems.md)
- [Content](content.md)
- [Media & SEO](media-seo.md)

The JSON Schemas in the codebase remain the machine-readable source of truth. Documentation explains how the current contract is intended to be used rather than duplicating every schema constraint.

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
- update Design Systems, Content, and CLI docs when their contracts change;
- keep examples executable and aligned with the documented syntax.

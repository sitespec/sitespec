# SiteSpec documentation

This documentation explains how to create, understand, and maintain SiteSpec projects without turning the repository README into a full specification manual.

If this is your first time using SiteSpec, read these two documents in order:

1. [Getting started](getting-started.md) — create a site, inspect it, edit it, validate it, and build it.
2. [Core concepts](concepts.md) — understand the contract, composition model, design model, routes, and agent-facing structure.

## How the documentation is organized

SiteSpec documentation is split by purpose rather than by repository package.

### Concepts

Concept documents explain how the system is intended to work and why its boundaries exist.

- [Core concepts](concepts.md)

### Guides

Guides answer a concrete "how do I do this?" question. The first guide is:

- [Getting started](getting-started.md)

As the project grows, focused guides should be added for tasks such as creating components, creating UI primitives, reusing section presets, adding dynamic routes, configuring local fonts, and deploying a site.

### Specification

Specification documents will describe the human-readable contract for source files such as `site.yaml`, Page Specs, section presets, components, UI primitives, design tokens, fonts, and dynamic routes.

The JSON Schemas in the codebase remain the machine-readable source of truth. Documentation should explain the contract rather than duplicate every schema constraint.

### Reference

Reference documents will contain exact lookup information such as CLI commands, reference syntax, core type URNs, and project structure.

### Project maintenance

These documents are for upgrading and maintaining SiteSpec itself:

- [Migrating from specVersion 0.1 to 0.2](MIGRATING-0.2.md)
- [Releasing SiteSpec](RELEASING.md)
- [Changelog](../CHANGELOG.md)

## Documentation rules

When adding documentation:

- keep the root [`README.md`](../README.md) focused on the project idea, quick start, and links into these docs;
- put conceptual explanations in concept documents, not in CLI reference pages;
- put task-oriented instructions in guides;
- use the implementation and JSON Schemas as the authority for exact behavior;
- prefer small executable examples over large hypothetical configurations;
- do not document generated `.site/` or `dist/` files as user-owned source;
- update documentation in the same change that alters a public contract.

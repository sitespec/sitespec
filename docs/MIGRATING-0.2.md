# Migrating a SiteSpec project from specVersion 0.1 to 0.2

SiteSpec engine 0.2 continues to validate and build existing `specVersion: "0.1"` projects. Upgrade the document format only when the site needs v0.2 composition features.

## 1. Upgrade source document versions

Change `specVersion` from `"0.1"` to `"0.2"` in:

- `site.yaml`
- every `pages/*.yaml`
- every `components/*/component.yaml`
- `design/fonts.yaml` when present

All source documents in one project must use the same spec version.

## 2. Upgrade core type URNs

Existing v0.1 core type URNs continue to describe the old format. For a v0.2 project, update component prop schemas to the v0.2 aliases:

```text
urn:site-spec:0.1:type:action     -> urn:site-spec:0.2:type:action
urn:site-spec:0.1:type:image      -> urn:site-spec:0.2:type:image
urn:site-spec:0.1:type:navigation -> urn:site-spec:0.2:type:navigation
```

v0.2 also adds:

```text
urn:site-spec:0.2:type:pagination
```

## 3. Optional: introduce UI primitives

Create internal design-system building blocks with:

```bash
npm run site -- add ui <id>
```

UI primitives live under `ui/<id>/` and may be imported by section components and Site Shell. Page Spec cannot use them directly.

## 4. Optional: introduce reusable section presets

Move exact reusable section configuration into `sections/<id>.yaml` and reference it from pages:

```yaml
sections:
  - id: final-cta
    $ref: section:final-cta
```

## 5. Optional: use deterministic dynamic routes

A v0.2 route template declares every concrete static path explicitly:

```yaml
page:
  id: product
  route: /products/[slug]
  archetype: detail
  paths:
    - slug: stories
    - slug: banners
```

Use `{ $ref: param:slug }` inside section props and `{slug}` inside SEO strings.

## 6. Validate the migration

```bash
npm run site -- spec --json
npm run site -- validate --json
npm run build
```

Do not manually edit `.site/` or `dist/` during migration.

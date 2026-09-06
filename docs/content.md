# Content

SiteSpec v0.5 retains the typed content contract introduced in v0.3 and treats content as part of the resolved project contract. Collections and entries are loaded by `@sitespec/core`; schemas, relations, queries, pagination, routes, and references are resolved before the Astro renderer runs.

That makes it possible to build blogs, documentation, case studies, catalogs, author pages, category pages, and similar sites from `spec` + content files without a runtime CMS.

## Content directory

Collections live directly under `content/`:

```text
content/
├── posts/
│   ├── collection.yaml
│   ├── hello-world.md
│   └── typed-relations.md
├── authors/
│   ├── collection.yaml
│   └── pavel.yaml
├── categories/
│   ├── collection.yaml
│   └── engineering.yaml
└── tags/
    ├── collection.yaml
    └── sitespec.yaml
```

Each collection directory has exactly one manifest named `collection.yaml`, `collection.yml`, or `collection.json`.

The collection ID must match the directory name.

## Collection manifest

```yaml
specVersion: "0.5"

collection:
  id: posts

entry:
  schema:
    type: object
    additionalProperties: false
    required:
      - title
      - description
      - author
      - categories
      - tags
    properties:
      title: { type: string }
      description: { type: string }
      author: { type: string }
      categories:
        type: array
        items: { type: string }
      tags:
        type: array
        items: { type: string }

relations:
  author:
    collection: authors
  categories:
    collection: categories
    many: true
  tags:
    collection: tags
    many: true
```

`entry.schema` is a JSON Schema for user-owned entry fields. SiteSpec validates system fields separately.

## Entry formats

A collection can contain:

- `.md` — YAML frontmatter plus Markdown body;
- `.yaml` / `.yml` — data-only entry;
- `.json` — data-only entry.

### Markdown entry

```md
---
slug: typed-relations
date: 2026-09-06
status: published
title: Typed relations
description: Relations are validated by core.
author: pavel
categories:
  - engineering
tags:
  - sitespec
---

# Typed relations

The Markdown body is part of the content entry.
```

Markdown is resolved to:

```text
body.format   "markdown"
body.source   original Markdown body
body.html     rendered safe HTML
```

### YAML entry

```yaml
slug: pavel
name: Pavel
bio: Builds SiteSpec.
```

YAML and JSON entries must contain an object at the document root.

## System fields

SiteSpec owns these fields:

| Field | Behavior |
| --- | --- |
| `id` | Derived from the file path relative to the collection directory, without extension. |
| `slug` | Explicit frontmatter/data value or the final segment of `id`. |
| `date` | Optional ISO date or datetime string. |
| `status` | `published` or `draft`; defaults to `published`. |
| `body` | Present for Markdown entries. |
| `href` | Added when SiteSpec can determine the canonical entry route. |

Entry IDs use lowercase letters, digits, hyphens, and optional `/` path segments. Slugs are lowercase kebab-case route segments and must be unique inside a collection.

The entry schema validates the remaining user data rather than the system fields above.

## Relations

Relations are generic. Authors, categories, tags, brands, clients, sections, and similar concepts are not special SiteSpec types.

```yaml
relations:
  author:
    collection: authors

  categories:
    collection: categories
    many: true
```

A single relation stores one target entry ID:

```yaml
author: pavel
```

A `many: true` relation stores entry IDs in an array:

```yaml
categories:
  - engineering
  - product
```

Validation checks that:

- the target collection exists;
- single relations contain a string entry ID;
- `many` relations contain string arrays;
- every referenced target entry exists.

When an entry is resolved for a page or query, relation fields become shallow resolved entry objects instead of raw IDs.

For example, this source:

```yaml
author: pavel
```

can resolve to an object containing values such as:

```json
{
  "id": "pavel",
  "slug": "pavel",
  "name": "Pavel",
  "href": "/blog/author/pavel"
}
```

Relation expansion is shallow. SiteSpec does not recursively expand the entire content graph.

## Entry-driven routes

Bind a dynamic Page Spec to a collection with `content.entry`:

```yaml
specVersion: "0.5"

page:
  id: post
  route: /blog/[slug]
  archetype: article

content:
  entry: posts

seo:
  title: "{entry.title}"
  description: "{entry.description}"

sections:
  - id: article
    use: article
    props:
      title: { $ref: "entry:title" }
      body: { $ref: "entry:body" }
      author: { $ref: "entry:author" }
```

Route parameters are read from the current entry. For `/blog/[slug]`, SiteSpec uses `entry.slug` and materializes one concrete route per entry.

This removes the need to maintain `page.paths` for content detail pages.

The same mechanism works for taxonomy pages:

```yaml
page:
  id: author
  route: /blog/author/[slug]
  archetype: listing

content:
  entry: authors
```

Once a collection has a content-driven entry page, resolved entries can expose the canonical `href` used by lists and relations.

## Entry references

A page with `content.entry` can use:

```text
entry:id
entry:slug
entry:date
entry:status
entry:body
entry:title
entry:author
entry:categories
```

Example:

```yaml
props:
  title: { $ref: "entry:title" }
  date: { $ref: "entry:date" }
  author: { $ref: "entry:author" }
```

References are resolved before component prop validation.

## Queries

A Page Spec can declare named collection queries:

```yaml
content:
  queries:
    posts:
      collection: posts
      filter:
        - field: featured
          eq: true
      sort:
        - field: date
          order: desc
```

Queries operate on published entries only.

Resolved query results expose:

```text
query:posts.items
query:posts.pagination
```

Example:

```yaml
sections:
  - id: posts
    use: post-list
    props:
      items: { $ref: "query:posts.items" }
```

## Filtering

Filters are declarative and are applied in order. All filters in a query must match for an entry to remain in the result.

Supported operators:

| Operator | Meaning |
| --- | --- |
| `eq` | Exact equality. |
| `ne` | Not equal. |
| `in` | The field value is in the provided array; array fields match if any item is in it. |
| `contains` | Array contains a value, or string contains a substring. |
| `gt` | Greater than. |
| `gte` | Greater than or equal. |
| `lt` | Less than. |
| `lte` | Less than or equal. |

Examples:

```yaml
filter:
  - field: featured
    eq: true

  - field: categories
    contains: engineering

  - field: date
    gte: 2026-01-01
```

Field paths can address nested values with dot notation.

## Queries scoped by the current entry

Filter values can reference the current entry:

```yaml
page:
  id: category
  route: /blog/category/[slug]
  archetype: listing

content:
  entry: categories
  queries:
    posts:
      collection: posts
      filter:
        - field: categories
          contains:
            $ref: entry:id
```

This gives each category page its own posts without JavaScript query logic inside the component.

The same pattern works for author, tag, brand, client, documentation-section, and similar pages.

## Sorting

```yaml
sort:
  - field: date
    order: desc
  - field: title
    order: asc
```

`order` is `asc` or `desc`. SiteSpec always applies `id ASC` as the final deterministic tie-breaker.

Null or missing values sort after defined values in ascending order.

## Pagination

```yaml
content:
  queries:
    posts:
      collection: posts
      sort:
        - field: date
          order: desc
      paginate:
        size: 10
        route: /blog/page/[page]
```

The page's own route is page 1:

```text
/blog
```

Additional pages use the pagination route:

```text
/blog/page/2
/blog/page/3
```

The pagination route must contain `[page]`. Any other parameters must already belong to the Page Spec route.

Resolved pagination contains:

```text
currentPage
totalPages
previousHref
nextHref
pages[]
```

Use it directly in component props:

```yaml
props:
  $ref: query:posts.pagination
```

## Draft and published content

```yaml
status: draft
```

Draft behavior is intentionally static-build friendly:

- draft entries are present in the content model for development and inspection;
- content-driven draft detail routes can be previewed in development;
- normal content queries exclude draft entries;
- production rendering excludes draft pages.

`status` defaults to `published` when omitted.

## SEO from entries

SEO strings can interpolate the current entry:

```yaml
seo:
  title: "{entry.title}"
  description: "{entry.description}"
```

This is resolved per concrete content route.

## Inspection

Inspect all content collections:

```bash
npm run site -- spec content --json
```

Inspect one collection:

```bash
npm run site -- spec collection:posts --json
```

Inspect one entry:

```bash
npm run site -- spec entry:posts/typed-relations --json
```

Inspect a concrete resolved page:

```bash
npm run site -- spec /blog/category/engineering --json
```

Inspection exposes the loaded collection contract, entries, status, relations, source files, resolved values, and canonical routes.

## Full repository example

`examples/marketing` is the executable v0.5 reference for the Content contract introduced in v0.3. It includes:

- `posts`, `authors`, `categories`, and `tags`;
- Markdown and YAML entries;
- single and many relations;
- canonical relation links;
- featured filtering;
- date sorting;
- `/blog/page/[page]` pagination;
- post, author, category, and tag routes;
- a draft post excluded from normal listings.

From the repository root:

```bash
npm install
npm run build
npm run dev -w @sitespec/example-marketing
```

Useful routes include:

```text
/blog
/blog/page/2
/blog/page/3
/blog/typed-relations
/blog/author/maya
/blog/category/engineering
/blog/tag/content
```

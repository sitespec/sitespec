# Media and SEO (v0.5)

SiteSpec 0.5 makes production media and search/social metadata part of the site contract. The generated Astro project is an implementation detail; projects should not need `astro.config.*`, image integrations, sitemap plugins, RSS plugins, or hand-written page head tags.

## Image pipeline

Images are declared with the core `urn:site-spec:0.5:type:image` type. A local `src` points into `public/`. During validation SiteSpec checks that the asset exists, can be decoded, has valid alt/decorative semantics, and does not declare a distorted aspect ratio. Remote images cannot be inspected and therefore require explicit `width` and `height`.

```yaml
image:
  src: /media/hero.png
  alt: Product interface overview
  widths: [480, 720, 960, 1280]
  sizes: "(max-width: 760px) 100vw, 50vw"
  formats: [avif, webp]
  crop:
    aspectRatio: "4:3"
    focalPoint: { x: 0.55, y: 0.42 }
  loading: eager
  fetchPriority: high
```

At render time SiteSpec generates hashed responsive derivatives under `media.output`, never upscales beyond the source/crop width, emits AVIF/WebP `<source>` sets plus a fallback `srcset`, and supplies intrinsic `width`/`height`. The generated `@site-generated/components/SiteImage.astro` component renders the resulting `<picture>`.

Site defaults live in `site.yaml`:

```yaml
media:
  output: /_media
  widths: [320, 640, 960, 1280, 1600]
  formats: [avif, webp]
  quality:
    avif: 50
    webp: 78
    jpeg: 82
    png: 85
```

## Page SEO

Every published page resolves a canonical URL, title, description, Open Graph metadata, Twitter metadata and JSON-LD. Page-level values override site defaults. Canonicals and internal hreflang clusters are validated before build; internal alternates must resolve to published canonical pages and reciprocal clusters are checked.

```yaml
page:
  id: docs-en
  route: /docs
  archetype: detail
  locale: en

seo:
  title: Documentation
  description: SiteSpec documentation.
  hreflang:
    en: /docs
    lv: /lv/docs
    x-default: /docs
  openGraph:
    type: website
  twitter:
    card: summary_large_image
```

`structuredData` accepts one object or an array. SiteSpec always emits a `WebSite` and `WebPage` graph, and adds an `Article` node for article archetypes. User nodes are appended to the same Schema.org graph.

## Generated metadata files

`site.yaml` controls metadata generation:

```yaml
seo:
  siteName: Example
  sitemap:
    enabled: true
  robots:
    index: true
    rules:
      - userAgent: "*"
        allow: [/]
        disallow: [/internal]
  llms:
    enabled: true
  rss:
    enabled: true
    path: /rss.xml
  socialImages:
    generate: true
    format: png
    width: 1200
    height: 630
```

SiteSpec materializes the same generated metadata files into the dev public directory and the production build. While `sitespec dev` is running they are served directly; `sitespec build` copies/materializes them into `dist/`:

- `sitemap.xml`, excluding drafts and `noindex` pages and including hreflang alternates when configured;
- `robots.txt`, including custom user-agent rules and the sitemap URL;
- `llms.txt`, with the site description and indexable page links;
- the configured RSS file, populated from published article pages;
- deterministic per-page social images under `/_social/` when no explicit page OG image is supplied.

Generated social images are referenced by both Open Graph and Twitter tags and include explicit OG image dimensions.

## Build guarantees

Validation operates at both ends of the pipeline. Source validation catches invalid/missing media and SEO graph errors. Post-build validation reads generated HTML and checks canonical, description, hreflang, core Open Graph/Twitter metadata, JSON-LD, image alt text and, for v0.5, numeric image dimensions.

This keeps Astro configuration out of normal SiteSpec projects: Astro remains the renderer, while the production contract belongs to SiteSpec.

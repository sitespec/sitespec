---
slug: content-driven
date: 2026-09-02
status: published
title: Content drives routes and listings
description: One collection feeds the blog listing, pagination, and generated detail routes.
---

The same `posts` collection powers both `/blog` and `/blog/[slug]`.

## No page list to maintain

Adding another Markdown file creates another detail route automatically. Listing order and pagination stay in Page Spec as declarative queries.

---
slug: hello-sitespec
date: 2026-09-01
status: published
title: Hello from SiteSpec content
description: A Markdown entry that becomes a typed static page through the SiteSpec content model.
---

This article lives in `content/posts/hello-sitespec.md`, not in an Astro page component.

## What happens at build time

SiteSpec validates the frontmatter, renders Markdown, resolves the entry against `pages/post.yaml`, and produces a static URL.

The component only receives typed props and renders them.

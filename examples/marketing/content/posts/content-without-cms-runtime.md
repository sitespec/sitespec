---
slug: content-without-cms-runtime
date: 2026-09-01
status: published
title: Content without a CMS runtime
description: Typed files can provide CMS-like structure while the deployed site stays completely static.
author: pavel
categories: [engineering]
tags: [content, static-sites]
featured: true
---

The deployed site does not query a database or remote API. Content work happens before rendering.

## The boundary stays simple

Core loads collections, resolves relations, runs queries, and materializes routes. Components receive finished props.

---
slug: typed-relations
date: 2026-09-03
status: published
title: Relations are ordinary collection fields
description: Authors, categories, and tags use the same generic relation mechanism as any other content model.
author: maya
categories: [engineering]
tags: [content, sitespec]
featured: true
---

There are no special `author` or `tag` entities in core. A relation declares the target collection and whether the field contains one id or many.

## Resolved links

When a related collection has an entry page, resolved relation objects also carry their canonical `href`.

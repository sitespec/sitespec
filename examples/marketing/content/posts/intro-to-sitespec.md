---
slug: intro-to-sitespec
date: 2026-08-30
status: published
title: A site described as data
description: SiteSpec keeps page intent, component contracts, content, and generated output in one inspectable system.
author: pavel
categories: [engineering]
tags: [sitespec, static-sites]
featured: true
---

SiteSpec treats the site specification as the source of truth and keeps rendering behind a strict resolved model.

## Content joins the same model

With v0.3, Markdown and data entries are loaded by core, validated against collection schemas, and resolved before Astro sees them.

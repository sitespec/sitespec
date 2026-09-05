---
"@sitespec/cli": patch
---

Make `sitespec dev` source watching deterministic by separating SiteSpec source observation from Astro/Vite's generated-source watcher, preventing the first edit after startup from being missed.

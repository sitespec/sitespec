---
"@sitespec/cli": patch
---

Wait for the SiteSpec source watcher to become ready before `sitespec dev` returns, preventing the first edit after startup from being lost on CI/Linux.

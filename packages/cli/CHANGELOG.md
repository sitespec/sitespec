# @sitespec/cli

## 0.1.1

### Patch Changes

- d888759: Wait for the SiteSpec source watcher to become ready before `sitespec dev` returns, preventing the first edit after startup from being lost on CI/Linux.
- 9b21877: improve starter shell layout
- 9b21877: Make `sitespec dev` source watching deterministic by separating SiteSpec source observation from Astro/Vite's generated-source watcher, preventing the first edit after startup from being missed.
- Updated dependencies [9b21877]
- Updated dependencies [9b21877]
  - @sitespec/template@0.1.1
  - @sitespec/astro@0.1.1
  - @sitespec/core@0.1.1

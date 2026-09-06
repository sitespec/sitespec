# @sitespec/cli

Project-local SiteSpec CLI.

The public binary is `sitespec`; normal websites invoke it through npm scripts such as `npm run dev` and `npm run site -- spec --json`.

The package exposes `sitespec` through `bin/sitespec.js`, a stable shim that is present before the TypeScript build output exists. The shim loads `dist/index.js` at runtime and prints a build instruction if the CLI has not been built yet. This keeps npm workspace binary linking deterministic during repository bootstrap.

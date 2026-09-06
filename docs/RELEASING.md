# Releasing SiteSpec

SiteSpec publishes five public npm packages on one synchronized release train:

- `@sitespec/core`
- `@sitespec/astro`
- `@sitespec/template`
- `@sitespec/cli`
- `@sitespec/create`

The Site Spec document version (`specVersion: "0.1"`) is independent from the npm engine version.

## Prerequisites

- Node.js 24 is the canonical local and CI release runtime. Changesets v3 also supports Node.js ^22.11 and >=26, but the SiteSpec release train is tested on Node 24.
- npm 11.19.1 for the synchronized SiteSpec release train.
- The npm scope `@sitespec` must exist and the publisher must be allowed to publish to it.
- `package-lock.json` must be committed. Generate it with the pinned npm version:

```bash
nvm install 24
nvm use 24
npm install --global npm@11.19.1
npm install
```

## Development changes

Every user-visible engine change should include a Changeset:

```bash
npm run changeset
```

All public packages are a fixed Changesets group. A patch/minor/major change therefore advances the whole SiteSpec release train together.

Before merging a release-sensitive change, run:

```bash
npm run release:check
```

That command runs the normal tests, validates package metadata, builds all packages, packs the exact npm tarballs, installs the packed packages into clean temporary projects, scaffolds a website through the packed `@sitespec/create`, and validates/builds that generated website.

## Automated releases after bootstrap

`.github/workflows/release.yml` uses Changesets v2 sub-actions:

1. `select-mode` decides whether the repository needs a version PR, a publish, or nothing.
2. `version` creates/updates the `chore: version packages` pull request.
3. After that PR is merged, `publish` publishes to npm and creates GitHub tags/releases.

The publish job is the only job with `id-token: write`.

## Release runtime preflight

All release commands verify the Node.js runtime before invoking Changesets. If an unsupported runtime such as Node 20 is active, the command exits immediately with instructions to switch to Node 24. The repository includes both `.nvmrc` and `.node-version` with `24`.

```bash
nvm use
npm install --global npm@11.19.1
npm ci
```

## First release bootstrap

npm Trusted Publishing cannot be attached to a package until that package exists in the registry. The first publish therefore needs interactive npm authentication.

1. Create/claim the `@sitespec` npm scope and ensure all package names are available.
2. Enable strong 2FA on the publishing npm account.
3. Generate and commit `package-lock.json`.
4. Run the full release gate:

```bash
npm run release:check
```

5. Authenticate interactively:

```bash
npm login
```

6. Publish the initial synchronized version:

```bash
npm run release:publish
```

For the initial repository state with unpublished `0.1.0` packages, Changesets will publish the packages that are not yet present in npm.

## Recover from a Node 20 bootstrap attempt

If `release:check` passed but `changeset publish` failed with `TypeError: enableCompileCache is not a function`, nothing was published. Switch the repository to Node 24, refresh dependencies/lock metadata, and resume at the publish step:

```bash
nvm install 24
nvm use 24
npm install --global npm@11.19.1
npm install
npm run release:publish
```

Use `npm install` once after changing the repository engine metadata so `package-lock.json` is synchronized. Subsequent clean installs should use `npm ci`.

## Enable npm Trusted Publishing

After the five packages exist, configure a Trusted Publisher separately for each package on npmjs.com.

Use the same GitHub repository and this exact workflow filename in npm Trusted Publisher settings:

```text
release.yml
```

Enter only the filename; npm expects the workflow itself to live under `.github/workflows/`.

After all five trusted publishers are configured, create a GitHub Actions repository variable:

```text
NPM_TRUSTED_PUBLISHING_ENABLED=true
```

The publish job is deliberately gated by this variable so that merging the release workflow before the first npm bootstrap cannot accidentally attempt an unconfigured OIDC publish.

Normal releases then require no `NPM_TOKEN`; the GitHub Actions publish job authenticates through OIDC. Do not add a long-lived npm token to the workflow.

## Normal release flow

```text
feature PR + changeset
        ↓
merge to main
        ↓
release.yml
        ↓
Version Packages PR
        ↓
merge Version Packages PR
        ↓
release.yml
        ↓
npm publish through OIDC
        ↓
Git tags + GitHub releases
```

## Pre-releases

The current workflow intentionally does not automate a `next` channel yet. Add prerelease automation only when SiteSpec has a real need to test incompatible engine changes against external site repositories.

# Google Analytics and HubSpot (`specVersion: "0.7"`)

SiteSpec 0.7 can connect a generated site to Google Analytics 4 and HubSpot without adding renderer-specific code to the Site Shell or section components.

Configure either or both providers in `site.yaml`:

```yaml
specVersion: "0.7"

integrations:
  googleAnalytics:
    measurementId: G-ABC123XYZ
  hubspot:
    portalId: "1234567"
```

The presence of a provider block enables it. Remove the block to disable that provider.

`googleAnalytics.measurementId` must be a GA4 Measurement ID beginning with `G-` and containing only uppercase letters and digits. SiteSpec emits the asynchronous Google tag loader and initializes `gtag` on every published page.

`hubspot.portalId` is the numeric HubSpot Portal ID. Quote it in YAML so the value remains a string. SiteSpec emits the asynchronous HubSpot tracking loader before the closing body tag on every published page.

Inspect the resolved configuration with:

```bash
npm run site -- spec integrations --json
```

Run `npm run validate` after editing the IDs. The build also verifies that every rendered page contains each configured provider loader. Integration support is intentionally declarative: SiteSpec does not accept arbitrary script URLs or inline JavaScript through `site.yaml`.

These loaders begin tracking according to the providers' behavior. Sites that require consent management should arrange consent before enabling the integrations or use provider-side consent settings appropriate to their jurisdiction.

# @sitespec/template

The default starter shipped with SiteSpec 0.8.0 uses the current `specVersion: "0.7"` document contract. It is an executable contract showcase rather than a component gallery.

The starter demonstrates:

- a first-class portable Design System with primitive/semantic tokens, typography weight/tracking, local fonts, themes, layout conventions, section presets, and selectable shell packs;
- exported UI primitives with separate `variant × state` modeling and deterministic Design Lab preview hooks;
- the native form foundation (`text-field`, `textarea-field`, `select-field`, `checkbox`, `radio-group`, `switch`) plus a submit-capable Button;
- a token-driven IconButton, persisted light/dark preference, accessible responsive mobile navigation, and explicit shell JavaScript runtime declaration;
- typed Markdown content, content-driven routes, query pagination, explicit dynamic routes/params, named navigation, semantic assets, and agent inspection.

The starter intentionally keeps content small: one `posts` collection, two Markdown entries, one listing page and one entry page. Richer relation/filter/taxonomy patterns and the real `/contact` form composition live in `examples/marketing`.

---
"@sitespec/core": minor
"@sitespec/astro": minor
"@sitespec/cli": minor
"@sitespec/template": minor
"@sitespec/create": minor
---

Add SiteSpec Design Lab as the built-in visual development and review environment for the installed Design System. `sitespec design dev` renders foundations, exported UI primitives as `variant × state` matrices, section variants/themes, contract-derived stress fixtures, form compositions, and responsive previews of real project pages. Page previews preserve selected theme/stress state across navigation without leaking preview-only behavior into production routes.

Expand the Design System interaction model with explicit UI states and a first-class `form` role. Add `hover`, `active`, `focus-visible`, `disabled`, `invalid`, `readonly`, and `checked` modeling; validate declared production and deterministic preview selectors; and keep legacy interactive contracts loadable with repair-oriented completeness warnings.

Complete the default visual foundation with semantic action/focus/form tokens, primitive and semantic font-weight and letter-spacing tokens, and stricter design lint for reusable typography and SVG paint handling.

Upgrade the default starter and marketing example with an exported IconButton, persistent light/dark theme switching, accessible responsive mobile navigation, declared Site Shell JavaScript runtime, and a complete native form foundation: TextField, TextareaField, SelectField, Checkbox, RadioGroup, Switch, and submit-capable Button.

Add a real `/contact` page to `examples/marketing`, composed through a reusable `contact-form` section and exported form primitives, so form behavior is exercised by normal SiteSpec page composition as well as the Design Lab benchmark.

Keep migration and validation compatible with the expanded Design System model: native form controls can materialize as `form` primitives, inferred implementations avoid forbidden raw typography, shell runtime is validated at source and rendered-output boundaries, and ordinary generated pages remain free of Design Lab-only bootstrap identifiers.

`specVersion` remains `"0.7"`; this is a synchronized engine/tooling release and does not require a Site Spec document-version migration.

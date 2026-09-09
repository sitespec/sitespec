---
"@sitespec/cli": minor
"@sitespec/core": patch
"@sitespec/template": patch
---

Add `sitespec migrate segment <audit>` as a live production DOM picker, persist exact selectors/fingerprints/content-style-structure evidence in `segments.json`, support Inspect/Interact modes, draggable/collapsible inspector UI, explicit Block names, reload/reinjection with state restoration, bounded scrolling for long block lists with stable scroll position during selection, multi-root logical blocks, batch selection and Merge/Ungroup/Delete of existing blocks, editable Header/Footer roots without duplicate-shell errors, fixed/sticky geometry handling, immediate return to Inspect after block edits, and single-tab Chrome reuse so the live picker does not open a redundant blank tab; make `migrate design` prefer completed manual DOM segments over automatic section candidates and preserve grouped root selectors in clustering provenance.

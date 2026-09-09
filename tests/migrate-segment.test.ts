import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDomSegmentArtifact,
  livePickerExpression,
  MigrateSegmentError,
  normalizeDomSelections,
  resolveSegmentAuditRoot
} from "../packages/cli/src/migrate-segment.ts";

function selection(overrides: Record<string, unknown> = {}) {
  return {
    role: "section",
    label: "Platform hero",
    selector: "main > div:nth-of-type(1)",
    tag: "div",
    fingerprint: {
      tag: "div",
      classes: ["container", "hero"],
      heading: "One platform",
      textHash: "a1b2c3d4",
      structureHash: "d4c3b2a1",
      ancestry: [{ tag: "main", classes: [] }],
      box: { x: 0, y: 100, width: 1440, height: 800 }
    },
    evidence: {
      selector: "main > div:nth-of-type(1)",
      tag: "div",
      heading: "One platform",
      content: { textLength: 500, headings: 1, links: 2, buttons: 2, images: 2, videos: 0, forms: 0, lists: 0 },
      structure: { directChildren: 2, directChildTags: ["div", "div"], descendantTags: { div: 8, h1: 1, p: 1, a: 2, img: 2 } },
      style: { display: "block", position: "static", backgroundColor: "rgb(255, 255, 255)", paddingTop: "96px", paddingBottom: "96px" },
      headingStyle: { fontFamily: "Roboto Flex", fontSize: "64px", fontWeight: "700", lineHeight: "64px", letterSpacing: "-1%", textTransform: "uppercase" },
      box: { x: 0, y: 100, width: 1440, height: 800 }
    },
    ...overrides
  };
}

test("migrate segment normalizes live DOM selections with exact evidence", () => {
  const result = normalizeDomSelections({
    observedUrl: "https://example.com/",
    viewport: { width: 1440, height: 1000 },
    segments: [
      selection({ role: "header", label: "Header", selector: "header", tag: "header", evidence: { ...selection().evidence, selector: "header", tag: "header", box: { x: 0, y: 0, width: 1440, height: 90 } }, fingerprint: { ...selection().fingerprint, tag: "header", box: { x: 0, y: 0, width: 1440, height: 90 } } }),
      selection(),
      selection({ role: "footer", label: "Footer", selector: "footer", tag: "footer", evidence: { ...selection().evidence, selector: "footer", tag: "footer", box: { x: 0, y: 5000, width: 1440, height: 700 } }, fingerprint: { ...selection().fingerprint, tag: "footer", box: { x: 0, y: 5000, width: 1440, height: 700 } } })
    ]
  });
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments[1]?.selector, "main > div:nth-of-type(1)");
  assert.equal(result.segments[1]?.fingerprint.textHash, "a1b2c3d4");
  assert.equal(result.segments[1]?.evidence.heading, "One platform");
});

test("migrate segment rejects duplicate selectors and duplicate shell roles", () => {
  assert.throws(() => normalizeDomSelections({
    observedUrl: "https://example.com/",
    viewport: { width: 1440, height: 1000 },
    segments: [selection(), selection()]
  }), (error: unknown) => {
    assert.ok(error instanceof MigrateSegmentError);
    assert.equal(error.code, "MIGRATE_SEGMENT_SELECTOR_INVALID");
    return true;
  });

  assert.throws(() => normalizeDomSelections({
    observedUrl: "https://example.com/",
    viewport: { width: 1440, height: 1000 },
    segments: [
      selection({ role: "header", selector: "header:nth-of-type(1)" }),
      selection({ role: "header", selector: "header:nth-of-type(2)" })
    ]
  }), (error: unknown) => {
    assert.ok(error instanceof MigrateSegmentError);
    assert.equal(error.code, "MIGRATE_SEGMENT_SHELL_DUPLICATE");
    return true;
  });
});

test("migrate segment writes deterministic DOM-oriented artifact ordering", () => {
  const artifact = buildDomSegmentArtifact("https://example.com/", {
    observedUrl: "https://example.com/",
    viewport: { width: 1440, height: 1000 },
    segments: [
      selection({ selector: "footer", role: "footer", evidence: { ...selection().evidence, selector: "footer", tag: "footer", box: { x: 0, y: 5000, width: 1440, height: 600 } }, fingerprint: { ...selection().fingerprint, box: { x: 0, y: 5000, width: 1440, height: 600 } } }),
      selection()
    ]
  });
  assert.equal(artifact.version, "0.3");
  assert.equal(artifact.source, "manual-dom");
  assert.equal(artifact.segments[0]?.id, "segment-01");
  assert.equal(artifact.segments[0]?.selector, "main > div:nth-of-type(1)");
  assert.equal(artifact.segments[1]?.selector, "footer");
});

test("live picker expression is production-DOM based and exposes Inspect/Interact workflow", () => {
  const expression = livePickerExpression([{ role: "section", label: "Hero", selectors: ["main > div:nth-of-type(1)"] }]);
  assert.match(expression, /sitespecSegmentSave/);
  assert.match(expression, /Live production DOM picker/);
  assert.match(expression, /Interact \(P\)/);
  assert.match(expression, /Reload production page/);
  assert.match(expression, /sitespecSegmentReload/);
  assert.match(expression, /Block name/);
  assert.match(expression, /Add root to block/);
  assert.match(expression, /Remove root/);
  assert.match(expression, /Merge selected/);
  assert.match(expression, /Delete selected/);
  assert.match(expression, /Cancel selection/);
  assert.match(expression, /Ungroup/);
  assert.match(expression, /Cmd\/Ctrl-click/);
  assert.match(expression, /batchSelections/);
  assert.match(expression, /editingSelection/);
  assert.match(expression, /editingRoot/);
  assert.match(expression, /listScrollTop/);
  assert.match(expression, /ss-list-body/);
  assert.match(expression, /Inspecting the next region/);
  assert.match(expression, /position==='fixed'/);
  assert.match(expression, /pointerdown/);
  assert.match(expression, /Collapse inspector/);
  assert.match(expression, /div,section,header,footer,main,article,nav/);
  assert.doesNotMatch(expression, /screenshot/i);
  assert.doesNotThrow(() => new Function(expression));
});



test("migrate segment aggregates multiple DOM roots into one logical block", () => {
  const base = selection();
  const second = selection({
    selector: "main > div:nth-of-type(3)",
    tag: "div",
    fingerprint: { ...selection().fingerprint, textHash: "b2c3d4e5", structureHash: "e5d4c3b2", box: { x: 0, y: 900, width: 1440, height: 300 } },
    evidence: {
      ...selection().evidence,
      selector: "main > div:nth-of-type(3)",
      heading: "",
      content: { textLength: 50, headings: 0, links: 1, buttons: 1, images: 1, videos: 0, forms: 0, lists: 0 },
      box: { x: 0, y: 900, width: 1440, height: 300 }
    }
  });
  const result = normalizeDomSelections({
    observedUrl: "https://example.com/",
    viewport: { width: 1440, height: 1000 },
    segments: [{ role: "section", label: "Hero", roots: [base, second] }]
  });
  const grouped = result.segments[0]!;
  assert.deepEqual(grouped.selectors, ["main > div:nth-of-type(1)", "main > div:nth-of-type(3)"]);
  assert.equal(grouped.roots.length, 2);
  assert.equal(grouped.tag, "group");
  assert.equal(grouped.evidence.box.y, 100);
  assert.equal(grouped.evidence.box.height, 1100);
  assert.equal(grouped.evidence.content?.buttons, 3);
  assert.equal(grouped.evidence.content?.images, 3);
  assert.equal(grouped.evidence.structure?.directChildren, 2);
});

test("migrate segment rejects a DOM root reused by another logical block", () => {
  assert.throws(() => normalizeDomSelections({
    observedUrl: "https://example.com/",
    viewport: { width: 1440, height: 1000 },
    segments: [
      { role: "section", label: "Hero", roots: [selection()] },
      { role: "section", label: "Another", roots: [selection()] }
    ]
  }), (error: unknown) => {
    assert.ok(error instanceof MigrateSegmentError);
    assert.equal(error.code, "MIGRATE_SEGMENT_SELECTOR_INVALID");
    return true;
  });
});

test("migrate segment resolves an audit directory or audit.json directly", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-live-segment-root-"));
  try {
    const audit = join(temp, "home");
    await mkdir(audit, { recursive: true });
    await writeFile(join(audit, "audit.json"), "{}\n");
    assert.equal(await resolveSegmentAuditRoot(audit), audit);
    assert.equal(await resolveSegmentAuditRoot(join(audit, "audit.json")), audit);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

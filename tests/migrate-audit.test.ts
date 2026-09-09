import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  aggregateDesignInventories,
  auditUrl,
  buildLeafUiInventoryExpression,
  buildManualRegionExpression,
  findAuditBrowser,
  mergeMediaInventories,
  parseAuditViewports,
  prepareAuditOutputDirectory,
  resolveAuditOutputDirectory,
  selectReusablePageTarget,
  MigrateAuditError,
  type AuditDesignInventory,
  type AuditMediaObservation
} from "../packages/cli/src/migrate-audit.ts";

function inventory(overrides: Partial<AuditDesignInventory> = {}): AuditDesignInventory {
  return {
    elements: { total: 10, visible: 8, textBearing: 4 },
    colors: { totalDistinct: 1, items: [{ key: "rgb(17, 17, 17)", value: "rgb(17, 17, 17)", count: 4, properties: { color: 4 } }] },
    typography: { totalDistinct: 1, items: [{ key: "Inter | 16px | 400 | 24px | normal | none", count: 3, style: { fontFamily: "Inter", fontSize: "16px", fontWeight: "400", lineHeight: "24px", letterSpacing: "normal", textTransform: "none" } }] },
    radii: { totalDistinct: 1, items: [{ key: "24px", value: "24px", count: 2 }] },
    shadows: { totalDistinct: 0, items: [] },
    spacing: { totalDistinct: 1, items: [{ key: "24px", value: "24px", count: 5, properties: { paddingTop: 2, paddingBottom: 3 } }] },
    containerWidths: { totalDistinct: 1, items: [{ key: "1200px", value: "1200px", count: 1 }] },
    ...overrides
  };
}

test("migrate browser reuses the existing page target before creating another tab", () => {
  const reusable = selectReusablePageTarget([
    { id: "worker", type: "service_worker", url: "https://example.com/sw.js", webSocketDebuggerUrl: "ws://worker" },
    { id: "page-existing", type: "page", url: "https://example.com/already-open", webSocketDebuggerUrl: "ws://existing" },
    { id: "page-blank", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" }
  ]);
  assert.equal(reusable?.id, "page-blank");

  const fallback = selectReusablePageTarget([
    { id: "page-existing", type: "page", url: "https://example.com/already-open", webSocketDebuggerUrl: "ws://existing" }
  ]);
  assert.equal(fallback?.id, "page-existing");
  assert.equal(selectReusablePageTarget([{ id: "worker", type: "worker", webSocketDebuggerUrl: "ws://worker" }]), undefined);
});

test("migrate audit resolves deterministic evidence directories", () => {
  const root = resolve("/tmp", "sitespec-audit-root");
  assert.equal(
    resolveAuditOutputDirectory(root, "https://www.example.com/"),
    join(root, ".sitespec", "audit", "example.com", "home")
  );
  assert.equal(
    resolveAuditOutputDirectory(root, "https://example.com/products/widget?source=test"),
    join(root, ".sitespec", "audit", "example.com", "products-widget")
  );
  assert.equal(resolveAuditOutputDirectory(root, "https://example.com/", "audit/home"), resolve(root, "audit/home"));
  assert.equal(
    resolveAuditOutputDirectory(root, "http://localhost:4321/demo"),
    join(root, ".sitespec", "audit", "localhost-4321", "demo")
  );
});

test("migrate audit parses the fixed v1 viewport matrix", () => {
  assert.deepEqual(parseAuditViewports(undefined), ["desktop", "tablet", "mobile"]);
  assert.deepEqual(parseAuditViewports("mobile,desktop,mobile"), ["mobile", "desktop"]);
  assert.throws(() => parseAuditViewports("desktop,watch"), (error: unknown) => {
    assert.ok(error instanceof MigrateAuditError);
    assert.equal(error.code, "MIGRATE_VIEWPORT_UNKNOWN");
    return true;
  });
});

test("migrate audit builds a syntactically valid targeted manual-root viewport expression", () => {
  const expression = buildManualRegionExpression([{
    targetId: "segment-02:root-1",
    segmentId: "segment-02",
    rootIndex: 0,
    selector: "main > div:nth-of-type(2)",
    tag: "div",
    fingerprint: {
      tag: "div",
      classes: ["feature"],
      heading: "Reusable feature",
      textHash: "deadbeef",
      structureHash: "feedface",
      ancestry: [{ tag: "main", classes: [] }]
    }
  }]);
  assert.doesNotThrow(() => new Function(`return ${expression};`));
  assert.match(expression, /main > div:nth-of-type\(2\)/);
  assert.match(expression, /fingerprint/);
  assert.match(expression, /commonAncestor/);
  assert.match(expression, /boundaryConfidence/);
});

test("migrate audit builds a syntactically valid leaf UI inventory expression linked to manual segments", () => {
  const expression = buildLeafUiInventoryExpression([{
    targetId: "segment-02:root-1",
    segmentId: "segment-02",
    rootIndex: 0,
    sourceSelector: "main > section:nth-of-type(2)",
    matchedSelector: "main > section:nth-of-type(2)",
    matchMethod: "selector",
    score: 1,
    item: {
      selector: "main > section:nth-of-type(2)",
      tag: "section",
      box: { x: 0, y: 100, width: 1440, height: 700 }
    }
  }]);
  assert.doesNotThrow(() => new Function(`return ${expression};`));
  assert.match(expression, /badge-candidate/);
  assert.match(expression, /card-candidate/);
  assert.match(expression, /segmentIdFor/);
  assert.match(expression, /main > section:nth-of-type\(2\)/);
});

test("migrate audit aggregates design evidence without normalizing source values", () => {
  const aggregate = aggregateDesignInventories({
    desktop: inventory(),
    mobile: inventory({
      elements: { total: 9, visible: 7, textBearing: 3 },
      colors: { totalDistinct: 2, items: [
        { key: "rgb(17, 17, 17)", value: "rgb(17, 17, 17)", count: 2, properties: { color: 2 } },
        { key: "rgb(128, 87, 255)", value: "rgb(128, 87, 255)", count: 1, properties: { backgroundColor: 1 } }
      ] }
    })
  });

  assert.equal(aggregate.elements.visible, 8);
  assert.equal(aggregate.colors.totalDistinct, 2);
  assert.equal(aggregate.colors.items[0]?.key, "rgb(17, 17, 17)");
  assert.equal(aggregate.colors.items[0]?.count, 6);
  assert.equal(aggregate.colors.items[0]?.viewports?.desktop, 4);
  assert.equal(aggregate.colors.items[0]?.viewports?.mobile, 2);
  assert.ok(aggregate.colors.items.some(item => item.key === "rgb(128, 87, 255)"));
});

test("migrate audit merges responsive media usages by resolved URL", () => {
  const image: AuditMediaObservation = {
    kind: "image",
    url: "https://example.com/media/hero.webp",
    alt: "Product UI",
    naturalWidth: 1600,
    naturalHeight: 1000,
    selector: "main > section > img",
    tag: "img",
    width: 720,
    height: 450
  };
  const external: AuditMediaObservation = {
    kind: "background-image",
    url: "https://cdn.example.test/background.webp",
    selector: ".campaign",
    tag: "div",
    width: 1440,
    height: 800
  };

  const merged = mergeMediaInventories("https://example.com/", [
    { viewport: "desktop", items: [image, external] },
    { viewport: "mobile", items: [{ ...image, width: 343, height: 214 }] }
  ]);

  assert.equal(merged.length, 2);
  const hero = merged.find(item => item.url?.includes("hero.webp"));
  assert.deepEqual(hero?.viewports, ["desktop", "mobile"]);
  assert.equal(hero?.usages.length, 2);
  assert.equal(hero?.external, false);
  assert.equal(merged.find(item => item.kind === "background-image")?.external, true);
});


test("migrate audit never deletes an arbitrary non-empty output directory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-output-"));
  try {
    await writeFile(join(temp, "keep.txt"), "important", "utf8");
    await assert.rejects(prepareAuditOutputDirectory(temp), (error: unknown) => {
      assert.ok(error instanceof MigrateAuditError);
      assert.equal(error.code, "MIGRATE_OUTPUT_NOT_EMPTY");
      return true;
    });
    assert.equal(await readFile(join(temp, "keep.txt"), "utf8"), "important");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate audit may replace a directory it previously owned", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-owned-"));
  try {
    await writeFile(join(temp, "audit.json"), JSON.stringify({ type: "sitespec-migrate-audit" }), "utf8");
    await writeFile(join(temp, "stale.txt"), "stale", "utf8");
    await prepareAuditOutputDirectory(temp);
    await assert.rejects(readFile(join(temp, "stale.txt"), "utf8"), (error: unknown) => (error as { code?: string }).code === "ENOENT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate audit reports an explicit missing browser path", async () => {
  await assert.rejects(
    findAuditBrowser(join(process.cwd(), "definitely-missing-browser")),
    (error: unknown) => {
      assert.ok(error instanceof MigrateAuditError);
      assert.equal(error.code, "MIGRATE_BROWSER_NOT_FOUND");
      return true;
    }
  );
});


test("migrate audit marks its output before browser startup so a failed run is safely retryable", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-retry-"));
  const output = join(temp, "audit");
  try {
    await assert.rejects(
      auditUrl({
        url: "https://example.com/",
        root: temp,
        output,
        browserPath: join(temp, "missing-browser")
      }),
      (error: unknown) => {
        assert.ok(error instanceof MigrateAuditError);
        assert.equal(error.code, "MIGRATE_BROWSER_NOT_FOUND");
        return true;
      }
    );
    const marker = JSON.parse(await readFile(join(output, "audit.json"), "utf8")) as { type?: string; status?: string };
    assert.equal(marker.type, "sitespec-migrate-audit");
    assert.equal(marker.status, "capturing");
    await prepareAuditOutputDirectory(output);
    await assert.rejects(readFile(join(output, "audit.json"), "utf8"), (error: unknown) => (error as { code?: string }).code === "ENOENT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate audit preserves completed manual segments while refreshing owned evidence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-preserve-segments-"));
  const output = join(temp, "audit");
  const sourceUrl = "https://example.com/";
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "audit.json"), JSON.stringify({ type: "sitespec-migrate-audit", status: "complete", sourceUrl }), "utf8");
    const segments = {
      version: "0.3",
      type: "sitespec-migrate-segments",
      status: "complete",
      source: "manual-dom",
      sourceUrl,
      observedUrl: sourceUrl,
      sourceAudit: ".",
      viewport: { name: "desktop", width: 1440, height: 1200 },
      createdAt: new Date(0).toISOString(),
      segments: [{ id: "segment-01", source: "manual-dom", role: "section", label: "Hero", selectors: ["main > div"], roots: [], selector: "main > div", tag: "div", fingerprint: { tag: "div", classes: [], textHash: "a", structureHash: "b", ancestry: [], box: { x: 0, y: 100, width: 1440, height: 800 } }, evidence: { selector: "main > div", tag: "div", box: { x: 0, y: 100, width: 1440, height: 800 } } }]
    };
    await writeFile(join(output, "segments.json"), `${JSON.stringify(segments, null, 2)}\n`, "utf8");

    await assert.rejects(
      auditUrl({ url: sourceUrl, root: temp, output, browserPath: join(temp, "missing-browser") }),
      (error: unknown) => error instanceof MigrateAuditError && error.code === "MIGRATE_BROWSER_NOT_FOUND"
    );

    const preserved = JSON.parse(await readFile(join(output, "segments.json"), "utf8")) as { type?: string; segments?: unknown[] };
    assert.equal(preserved.type, "sitespec-migrate-segments");
    assert.equal(preserved.segments?.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

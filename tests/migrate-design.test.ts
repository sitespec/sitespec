import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AuditDesignInventory, AuditLeafUiObservation, AuditMediaItem } from "../packages/cli/src/migrate-audit.ts";
import {
  MigrateDesignError,
  aggregateAuditFoundations,
  buildComponentFamilyModel,
  buildFoundationProposal,
  buildSectionRhythmModel,
  buildTokenCandidates,
  clusterSections,
  compareSections,
  designAudits,
  inferManualSectionIntent,
  prepareDesignOutputDirectory,
  resolveDesignOutputDirectory,
  type AuditSection,
  type PrimitiveTokenCandidate,
  type SectionObservation
} from "../packages/cli/src/migrate-design.ts";

function inventory(options: { color?: string; colorCount?: number; radius?: string; spacing?: string; fontSize?: string } = {}): AuditDesignInventory {
  const color = options.color ?? "rgb(17, 17, 17)";
  const colorCount = options.colorCount ?? 8;
  const fontSize = options.fontSize ?? "16px";
  return {
    elements: { total: 100, visible: 80, textBearing: 30 },
    colors: { totalDistinct: 1, items: [{ key: color, value: color, count: colorCount, properties: { color: Math.max(1, colorCount - 2), backgroundColor: 2 } }] },
    typography: { totalDistinct: 1, items: [{
      key: `Inter | ${fontSize} | 400 | 24px | normal | none`,
      count: 12,
      style: { fontFamily: "Inter, sans-serif", fontSize, fontWeight: "400", lineHeight: "24px", letterSpacing: "normal", textTransform: "none" }
    }] },
    radii: { totalDistinct: 1, items: [{ key: options.radius ?? "32px", value: options.radius ?? "32px", count: 5 }] },
    shadows: { totalDistinct: 1, items: [{ key: "rgba(0, 0, 0, 0.12) 0px 8px 24px", count: 2 }] },
    spacing: { totalDistinct: 1, items: [{ key: options.spacing ?? "24px", value: options.spacing ?? "24px", count: 15, properties: { paddingTop: 5, paddingBottom: 5, gap: 5 } }] },
    containerWidths: { totalDistinct: 1, items: [{ key: "1200px", value: "1200px", count: 3 }] }
  };
}

function section(id: string, overrides: Partial<AuditSection> = {}): AuditSection {
  return {
    auditId: id,
    label: "Product hero",
    tag: "section",
    selector: `main > section:nth-of-type(${Number(id.match(/\d+/)?.[0] ?? 1)})`,
    heading: "Engage users inside your app",
    background: "rgb(255, 255, 255)",
    box: { x: 0, y: 120, width: 1440, height: 780 },
    content: { textLength: 500, headings: 1, links: 2, buttons: 2, images: 2, videos: 0, forms: 0, lists: 0 },
    structure: { directChildren: 2, directChildTags: ["div", "div"], descendantTags: { div: 10, h1: 1, p: 2, a: 2, img: 2 } },
    style: {
      display: "block",
      position: "static",
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgb(255, 255, 255)",
      borderRadius: "0px",
      paddingTop: "96px",
      paddingRight: "48px",
      paddingBottom: "96px",
      paddingLeft: "48px",
      gap: "normal",
      gridTemplateColumns: "none",
      flexDirection: "row",
      alignItems: "normal",
      justifyContent: "normal"
    },
    headingStyle: { fontFamily: "Inter, sans-serif", fontSize: "64px", fontWeight: "700", lineHeight: "64px", letterSpacing: "-1px", textTransform: "uppercase" },
    ...overrides
  };
}

function observation(page: string, sourceUrl: string, item: AuditSection): SectionObservation {
  const root = {
    selector: item.selector ?? "section",
    tag: item.tag ?? "section",
    heading: item.heading,
    content: item.content,
    structure: item.structure,
    style: item.style,
    headingStyle: item.headingStyle,
    box: item.box
  };
  return {
    page,
    sourceUrl,
    section: item,
    viewportWidth: 1440,
    viewports: Object.fromEntries([["desktop", 1440], ["tablet", 768], ["mobile", 375]].map(([viewport, width]) => [viewport, {
      viewport: String(viewport),
      width: Number(width),
      roots: [root],
      box: item.box,
      matchedSelectors: 1,
      totalSelectors: 1
    }]))
  };
}

async function writeAudit(root: string, id: string, sourceUrl: string, options: {
  design?: AuditDesignInventory;
  sections?: AuditSection[];
  media?: AuditMediaItem[];
  ui?: Array<AuditLeafUiObservation & { viewport?: string }>;
} = {}): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const files = {
    page: "page.json",
    designInventory: "design-inventory.json",
    media: "media.json",
    sections: "sections.json",
    ...(options.ui ? { ui: "ui-inventory.json" } : {})
  };
  await writeFile(join(dir, "audit.json"), `${JSON.stringify({
    version: "0.1",
    type: "sitespec-migrate-audit",
    status: "complete",
    sourceUrl,
    finalUrl: sourceUrl,
    files
  }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "page.json"), `${JSON.stringify({ version: "0.1", sourceUrl, title: id }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "design-inventory.json"), `${JSON.stringify({ version: "0.1", sourceUrl, aggregate: options.design ?? inventory() }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "sections.json"), `${JSON.stringify({ version: "0.1", sourceUrl, viewport: { width: 1440, height: 1200 }, items: options.sections ?? [section("section-01")] }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "media.json"), `${JSON.stringify({ version: "0.1", sourceUrl, items: options.media ?? [] }, null, 2)}\n`, "utf8");
  if (options.ui) await writeFile(join(dir, "ui-inventory.json"), `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-audit-ui-inventory", sourceUrl, items: options.ui }, null, 2)}\n`, "utf8");
  return dir;
}

test("migrate design resolves a deterministic generated analysis directory", () => {
  const root = resolve("/tmp", "sitespec-design-root");
  assert.equal(resolveDesignOutputDirectory(root, "www.example.com"), join(root, ".sitespec", "migration", "www.example.com", "design"));
  assert.equal(resolveDesignOutputDirectory(root, "example.com", "audit/design"), resolve(root, "audit/design"));
});

test("migrate design aggregates exact production foundations across pages with provenance", () => {
  const foundations = aggregateAuditFoundations([
    { sourceUrl: "https://example.com/", design: { aggregate: inventory({ colorCount: 8 }) } },
    { sourceUrl: "https://example.com/products/widget", design: { aggregate: inventory({ colorCount: 4, spacing: "32px" }) } }
  ]);
  assert.equal(foundations.pages, 2);
  assert.equal(foundations.colors[0]?.count, 12);
  assert.deepEqual(foundations.colors[0]?.pages, ["home", "products-widget"]);
  assert.equal(foundations.colors[0]?.coverage, 1);
  assert.ok(foundations.spacing.some(item => item.key === "24px"));
  assert.ok(foundations.spacing.some(item => item.key === "32px"));
});

test("migrate design proposes primitive tokens conservatively and semantic roles with lower confidence", () => {
  const foundations = aggregateAuditFoundations([
    { sourceUrl: "https://example.com/", design: { aggregate: inventory() } },
    { sourceUrl: "https://example.com/products/widget", design: { aggregate: inventory() } }
  ]);
  const candidates = buildTokenCandidates(foundations);
  assert.ok(candidates.primitive.some(item => item.id === "primitive.color.01" && item.type === "color"));
  assert.ok(candidates.primitive.some(item => item.group === "font.family" && item.value === "Inter, sans-serif"));
  assert.ok(candidates.primitive.some(item => item.group === "font.lineHeight" && item.type === "number" && item.value === 1.5));
  const text = candidates.semantic.find(item => item.role === "color.text");
  assert.ok(text);
  assert.ok(text.confidence < candidates.primitive.find(item => item.id === text.primitive)!.confidence);
  assert.ok(candidates.typography.some(item => item.suggestedRole.startsWith("body-")));
  assert.equal(candidates.normalization.rawEvidenceValues, 6);
  assert.ok(candidates.normalization.normalizedEvidenceGroups <= candidates.normalization.rawEvidenceValues);
});

test("migrate design rationalizes normalized candidates into a proposed foundation model", () => {
  const foundations = aggregateAuditFoundations([
    { sourceUrl: "https://example.com/", design: { aggregate: inventory() } },
    { sourceUrl: "https://example.com/products/widget", design: { aggregate: inventory() } }
  ]);
  const candidates = buildTokenCandidates(foundations);
  candidates.primitive = candidates.primitive.filter(item => item.group !== "space" && item.group !== "size");
  candidates.primitive.push(
    { id: "primitive.space.01", group: "space", type: "dimension", value: "32px", confidence: 1, evidence: { count: 600, pages: ["home", "stories"], coverage: 1 } },
    { id: "primitive.space.02", group: "space", type: "dimension", value: "24px", confidence: 1, evidence: { count: 500, pages: ["home", "stories"], coverage: 1 } },
    { id: "primitive.space.03", group: "space", type: "dimension", value: "16px", confidence: 1, evidence: { count: 400, pages: ["home", "stories"], coverage: 1 } },
    { id: "primitive.space.04", group: "space", type: "dimension", value: "12px", confidence: 0.95, evidence: { count: 200, pages: ["home", "stories"], coverage: 1 } },
    { id: "primitive.space.05", group: "space", type: "dimension", value: "8px", confidence: 0.95, evidence: { count: 200, pages: ["home", "stories"], coverage: 1 } },
    { id: "primitive.space.06", group: "space", type: "dimension", value: "4px", confidence: 0.9, evidence: { count: 100, pages: ["home", "stories"], coverage: 1 } },
    { id: "primitive.size.01", group: "size", type: "dimension", value: "1376px", confidence: 1, evidence: { count: 148, pages: ["home", "stories"], coverage: 1, viewports: { desktop: 148 } } },
    { id: "primitive.size.02", group: "size", type: "dimension", value: "1312px", confidence: 1, evidence: { count: 104, pages: ["home", "stories"], coverage: 1, viewports: { desktop: 104 } } },
    { id: "primitive.size.03", group: "size", type: "dimension", value: "720px", confidence: 1, evidence: { count: 171, pages: ["home", "stories"], coverage: 1, viewports: { tablet: 171 } } },
    { id: "primitive.size.04", group: "size", type: "dimension", value: "672px", confidence: 0.98, evidence: { count: 63, pages: ["home", "stories"], coverage: 1, viewports: { tablet: 63 } } },
    { id: "primitive.size.05", group: "size", type: "dimension", value: "343px", confidence: 1, evidence: { count: 239, pages: ["home", "stories"], coverage: 1, viewports: { mobile: 239 } } },
    { id: "primitive.size.06", group: "size", type: "dimension", value: "311px", confidence: 1, evidence: { count: 141, pages: ["home", "stories"], coverage: 1, viewports: { mobile: 141 } } }
  );

  const proposal = buildFoundationProposal(candidates);
  assert.equal(proposal.primitive.spacing.baseUnit, "4px");
  assert.ok(proposal.primitive.spacing.baseUnitConfidence >= 0.9);
  assert.equal(proposal.layout.pageGutter.status, "proposed");
  assert.deepEqual(proposal.layout.pageGutter.values.map(item => [item.viewport, item.value, item.confirmedBySpacing]), [
    ["desktop", "32px", true],
    ["tablet", "24px", true],
    ["mobile", "16px", true]
  ]);
  assert.equal(proposal.layout.contentWidth?.max, "1376px");
  assert.ok(proposal.semantic.some(item => item.path === "semantic.size.content" && item.primitive === "primitive.size.1376"));
  assert.ok(proposal.typography.some(item => item.role.startsWith("text.md.") && !item.style.fontFamily.startsWith("unresolved:")));
});

test("migrate design infers canonical section rhythm only from balanced reusable section-root evidence", () => {
  const observations = [
    observation("home", "https://example.com/", section("section-02", { source: "manual", label: "Feature block", heading: "One platform" })),
    observation("home", "https://example.com/", section("section-03", { source: "manual", label: "Feature block", heading: "Built for teams", box: { x: 0, y: 1000, width: 1440, height: 780 } })),
    observation("stories", "https://example.com/products/widget", section("section-02", { source: "manual", label: "Feature block", heading: "Native stories" })),
    observation("stories", "https://example.com/products/widget", section("section-03", { source: "manual", label: "Feature block", heading: "Zero-party data", box: { x: 0, y: 1000, width: 1440, height: 780 } })),
    observation("home", "https://example.com/", section("section-09", {
      source: "manual",
      label: "Page offset",
      style: { ...section("x").style, paddingTop: "100px", paddingBottom: "32px" },
      box: { x: 0, y: 5000, width: 1440, height: 500 }
    })),
    observation("stories", "https://example.com/products/widget", section("section-09", {
      source: "manual",
      label: "Page offset",
      style: { ...section("x").style, paddingTop: "100px", paddingBottom: "32px" },
      box: { x: 0, y: 5000, width: 1440, height: 500 }
    }))
  ];
  const clusters = clusterSections(observations).clusters;
  const primitives: PrimitiveTokenCandidate[] = [
    {
      id: "primitive.space.96",
      group: "space" as const,
      type: "dimension" as const,
      value: "96px",
      confidence: 0.94,
      evidence: {
        count: 24,
        pages: ["home", "stories"],
        coverage: 1,
        properties: { paddingTop: 12, paddingBottom: 12 },
        viewports: { desktop: 8, tablet: 8, mobile: 8 }
      }
    },
    {
      id: "primitive.space.100",
      group: "space" as const,
      type: "dimension" as const,
      value: "100px",
      confidence: 0.86,
      evidence: {
        count: 6,
        pages: ["home", "stories"],
        coverage: 1,
        properties: { paddingTop: 6 },
        viewports: { desktop: 2, tablet: 2, mobile: 2 }
      }
    },
    {
      id: "primitive.space.32",
      group: "space" as const,
      type: "dimension" as const,
      value: "32px",
      confidence: 1,
      evidence: {
        count: 600,
        pages: ["home", "stories"],
        coverage: 1,
        properties: { paddingLeft: 220, paddingRight: 220, paddingTop: 60, paddingBottom: 60, gap: 40 },
        viewports: { desktop: 300, tablet: 180, mobile: 120 }
      }
    }
  ];

  const rhythm = buildSectionRhythmModel(observations, clusters, primitives);
  assert.equal(rhythm.status, "proposed");
  assert.equal(rhythm.recommended?.value, "96px");
  assert.ok((rhythm.recommended?.confidence ?? 0) >= 0.78);
  assert.equal(rhythm.candidates.find(item => item.value === "100px")?.strength, "weak");
  assert.notEqual(rhythm.recommended?.value, "32px");

  const proposal = buildFoundationProposal({ primitive: primitives, semantic: [], typography: [] }, rhythm);
  assert.equal(proposal.layout.sectionSpacing.status, "proposed");
  assert.equal(proposal.layout.sectionSpacing.primitive, "primitive.space.96");
  assert.equal(proposal.layout.sectionSpacing.value, "96px");
  assert.ok(!proposal.unresolved.some(item => item.area === "space.section"));
});


test("migrate design resolves grouped manual section boundaries independently across viewports", () => {
  const grouped = (page: string, sourceUrl: string, index: number): SectionObservation => {
    const selectors = [`main > div:nth-of-type(${index})`, `main > div:nth-of-type(${index + 1})`];
    const item = section(`section-${String(index).padStart(2, "0")}`, {
      source: "manual",
      label: "Feature group",
      tag: "group",
      selector: selectors[0],
      selectors,
      style: { display: "group" },
      box: { x: 0, y: index * 1000, width: 1440, height: 680 }
    });
    const viewportEvidence = (viewport: string, width: number) => ({
      viewport,
      width,
      roots: [
        { selector: selectors[0]!, tag: "div", style: { paddingTop: "96px", paddingBottom: "20px" }, box: { x: 0, y: index * 1000, width, height: 300 } },
        { selector: selectors[1]!, tag: "div", style: { paddingTop: "20px", paddingBottom: "96px" }, box: { x: 0, y: index * 1000 + 300, width, height: 300 } }
      ],
      box: { x: 0, y: index * 1000, width, height: 600 },
      matchedSelectors: 2,
      totalSelectors: 2
    });
    return {
      page, sourceUrl, section: item, viewportWidth: 1440,
      viewports: { desktop: viewportEvidence("desktop", 1440), tablet: viewportEvidence("tablet", 768), mobile: viewportEvidence("mobile", 375) }
    };
  };
  const observations = [
    grouped("home", "https://example.com/", 2),
    grouped("home", "https://example.com/", 4),
    grouped("stories", "https://example.com/products/widget", 2),
    grouped("stories", "https://example.com/products/widget", 4)
  ];
  const primitives: PrimitiveTokenCandidate[] = [{
    id: "primitive.space.96", group: "space", type: "dimension", value: "96px", confidence: 0.94,
    evidence: { count: 24, pages: ["home", "stories"], coverage: 1, properties: { paddingTop: 12, paddingBottom: 12 }, viewports: { desktop: 8, tablet: 8, mobile: 8 } }
  }];
  const rhythm = buildSectionRhythmModel(observations, clusterSections(observations).clusters, primitives);
  assert.equal(rhythm.status, "proposed");
  assert.equal(rhythm.recommended?.value, "96px");
  const candidate = rhythm.candidates[0]!;
  assert.equal(candidate.evidence.sections, 4);
  assert.equal(candidate.evidence.viewportOccurrences, 12);
  assert.equal(candidate.evidence.responsiveSections, 4);
  assert.equal(candidate.evidence.selectorCoverage, 1);
  assert.deepEqual(candidate.evidence.sectionViewports, ["desktop", "tablet", "mobile"]);
});

test("migrate design uses audit manualRegions to resolve reviewed roots on every viewport", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-manual-regions-"));
  try {
    const writeReviewedAudit = async (id: string, sourceUrl: string): Promise<string> => {
      const design = inventory({ spacing: "96px" });
      design.spacing.items[0] = {
        key: "96px",
        value: "96px",
        count: 18,
        properties: { paddingTop: 6, paddingBottom: 6, gap: 6 },
        viewports: { desktop: 6, tablet: 6, mobile: 6 }
      };
      const dir = await writeAudit(temp, id, sourceUrl, { design });
      const selector = "main > div:nth-of-type(2)";
      const rootNode = (viewport: "desktop" | "tablet" | "mobile", width: number) => ({
        selector: viewport === "desktop" ? selector : `main > div.viewport-${viewport}`,
        tag: "div",
        heading: "Reusable feature",
        style: { paddingTop: "96px", paddingBottom: "96px" },
        box: { x: 0, y: 500, width, height: 600 }
      });
      const segments = {
        version: "0.3",
        type: "sitespec-migrate-segments",
        status: "complete",
        source: "manual-dom",
        sourceUrl,
        observedUrl: sourceUrl,
        viewport: { name: "desktop", width: 1440, height: 1200 },
        segments: [{
          id: "segment-01",
          source: "manual-dom",
          role: "section",
          label: "Reusable feature",
          selectors: [selector],
          roots: [{
            selector,
            tag: "div",
            fingerprint: { tag: "div", classes: ["feature"], heading: "Reusable feature", textHash: "a", structureHash: "b", ancestry: [], box: { x: 0, y: 500, width: 1440, height: 600 } },
            evidence: rootNode("desktop", 1440)
          }],
          selector,
          tag: "div",
          fingerprint: { tag: "div", classes: ["feature"], heading: "Reusable feature", textHash: "a", structureHash: "b", ancestry: [], box: { x: 0, y: 500, width: 1440, height: 600 } },
          evidence: rootNode("desktop", 1440)
        }]
      };
      await writeFile(join(dir, "segments.json"), `${JSON.stringify(segments, null, 2)}\n`, "utf8");
      const audit = JSON.parse(await readFile(join(dir, "audit.json"), "utf8")) as { files: Record<string, string> };
      audit.files.segments = "segments.json";
      await writeFile(join(dir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
      const sections = JSON.parse(await readFile(join(dir, "sections.json"), "utf8")) as Record<string, unknown>;
      sections.version = "0.3";
      sections.manualRegions = Object.fromEntries([
        ["desktop", 1440],
        ["tablet", 768],
        ["mobile", 375]
      ].map(([viewport, width]) => [viewport, {
        viewport: { name: viewport, width, height: 1000 },
        count: 1,
        items: [{
          targetId: "segment-01:root-1",
          segmentId: "segment-01",
          rootIndex: 0,
          sourceSelector: selector,
          matchedSelector: viewport === "desktop" ? selector : `main > div.viewport-${viewport}`,
          matchMethod: viewport === "desktop" ? "selector" : "fingerprint",
          score: viewport === "desktop" ? 1 : 0.9,
          item: rootNode(viewport as "desktop" | "tablet" | "mobile", Number(width))
        }]
      }]));
      await writeFile(join(dir, "sections.json"), `${JSON.stringify(sections, null, 2)}\n`, "utf8");
      return dir;
    };

    const first = await writeReviewedAudit("home", "https://example.com/");
    const second = await writeReviewedAudit("stories", "https://example.com/products/widget");
    const result = await designAudits({ audits: [first, second], root: temp });
    const rhythm = JSON.parse(await readFile(join(result.output, "section-rhythm.json"), "utf8")) as {
      status: string;
      recommended?: { value?: string };
      candidates: Array<{ value: string; evidence: { responsiveSections: number; selectorCoverage: number; sectionViewports: string[] } }>;
    };
    const candidate = rhythm.candidates.find(item => item.value === "96px");
    assert.ok(candidate);
    assert.equal(candidate.evidence.responsiveSections, 2);
    assert.equal(candidate.evidence.selectorCoverage, 0.933);
    assert.deepEqual(candidate.evidence.sectionViewports, ["desktop", "tablet", "mobile"]);
    assert.equal(rhythm.status, "proposed");
    assert.equal(rhythm.recommended?.value, "96px");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate design uses resolved common-ancestor boundaries for grouped manual sections", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-manual-boundaries-"));
  try {
    const writeGroupedAudit = async (id: string, sourceUrl: string): Promise<string> => {
      const design = inventory({ spacing: "96px" });
      design.spacing.items[0] = {
        key: "96px",
        value: "96px",
        count: 24,
        properties: { paddingTop: 9, paddingBottom: 9, gap: 6 },
        viewports: { desktop: 8, tablet: 8, mobile: 8 }
      };
      const dir = await writeAudit(temp, id, sourceUrl, { design });
      const selectors = ["main > section.feature > div:nth-of-type(1)", "main > section.feature > div:nth-of-type(2)"];
      const rootNode = (selector: string, width: number, y: number) => ({
        selector,
        tag: "div",
        heading: "Reusable feature",
        style: { paddingTop: "0px", paddingBottom: "0px" },
        box: { x: 32, y, width: width - 64, height: 260 }
      });
      const boundaryNode = (viewport: string, width: number) => ({
        selector: `main > section.feature-${viewport}`,
        tag: "section",
        heading: "Reusable feature",
        style: { paddingTop: "96px", paddingBottom: "96px" },
        box: { x: 0, y: 400, width, height: 720 }
      });
      const segments = {
        version: "0.3",
        type: "sitespec-migrate-segments",
        status: "complete",
        source: "manual-dom",
        sourceUrl,
        observedUrl: sourceUrl,
        viewport: { name: "desktop", width: 1440, height: 1200 },
        segments: [{
          id: "segment-01",
          source: "manual-dom",
          role: "section",
          label: "Reusable feature",
          selectors,
          roots: selectors.map((selector, rootIndex) => ({
            selector,
            tag: "div",
            fingerprint: { tag: "div", classes: ["feature-part"], heading: "Reusable feature", textHash: `text-${rootIndex}`, structureHash: `structure-${rootIndex}`, ancestry: [], box: { x: 32, y: 500 + rootIndex * 260, width: 1376, height: 260 } },
            evidence: rootNode(selector, 1440, 500 + rootIndex * 260)
          })),
          selector: selectors[0],
          tag: "group",
          fingerprint: { tag: "group", classes: [], textHash: "group", structureHash: "group", ancestry: [], box: { x: 0, y: 400, width: 1440, height: 720 } },
          evidence: { selector: selectors[0], tag: "group", heading: "Reusable feature", box: { x: 0, y: 400, width: 1440, height: 720 } }
        }]
      };
      await writeFile(join(dir, "segments.json"), `${JSON.stringify(segments, null, 2)}\n`, "utf8");
      const audit = JSON.parse(await readFile(join(dir, "audit.json"), "utf8")) as { files: Record<string, string> };
      audit.files.segments = "segments.json";
      await writeFile(join(dir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
      const sections = JSON.parse(await readFile(join(dir, "sections.json"), "utf8")) as Record<string, unknown>;
      sections.version = "0.4";
      sections.manualRegions = Object.fromEntries([
        ["desktop", 1440],
        ["tablet", 768],
        ["mobile", 375]
      ].map(([viewport, width]) => [viewport, {
        viewport: { name: viewport, width, height: 1000 },
        count: 2,
        items: selectors.map((sourceSelector, rootIndex) => {
          const matchedSelector = `${sourceSelector}.viewport-${viewport}`;
          return {
            targetId: `segment-01:root-${rootIndex + 1}`,
            segmentId: "segment-01",
            rootIndex,
            sourceSelector,
            matchedSelector,
            matchMethod: viewport === "desktop" ? "selector" : "fingerprint",
            score: viewport === "desktop" ? 1 : 0.92,
            item: rootNode(matchedSelector, Number(width), 500 + rootIndex * 260),
            boundary: boundaryNode(String(viewport), Number(width)),
            boundaryConfidence: 0.94
          };
        })
      }]));
      await writeFile(join(dir, "sections.json"), `${JSON.stringify(sections, null, 2)}\n`, "utf8");
      return dir;
    };

    const first = await writeGroupedAudit("home", "https://example.com/");
    const second = await writeGroupedAudit("stories", "https://example.com/products/widget");
    const result = await designAudits({ audits: [first, second], root: temp });
    const rhythm = JSON.parse(await readFile(join(result.output, "section-rhythm.json"), "utf8")) as {
      status: string;
      recommended?: { value?: string };
      candidates: Array<{ value: string; evidence: { responsiveSections: number; selectorCoverage: number; examples: Array<{ boundarySource?: string; boundarySelector?: string }> } }>;
    };
    const candidate = rhythm.candidates.find(item => item.value === "96px");
    assert.ok(candidate);
    assert.equal(candidate.evidence.responsiveSections, 2);
    assert.ok(candidate.evidence.selectorCoverage >= 0.84);
    assert.ok(candidate.evidence.examples.every(item => item.boundarySource === "common-ancestor"));
    assert.ok(candidate.evidence.examples.every(item => item.boundarySelector?.includes("section.feature-")));
    assert.equal(rhythm.status, "proposed");
    assert.equal(rhythm.recommended?.value, "96px");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate design normalizes noisy production evidence without mutating foundations", () => {
  const noisy = inventory({ color: "rgb(255, 255, 255)" });
  noisy.colors.items.push(
    { key: "oklab(0.999994 0.0000455678 0.0000200868)", value: "oklab(0.999994 0.0000455678 0.0000200868)", count: 4, properties: { backgroundColor: 4 } },
    { key: 'url("#paint0")', value: 'url("#paint0")', count: 8, properties: { stroke: 8 } },
    { key: "rgb(0, 0, 0)", value: "rgb(0, 0, 0)", count: 40, properties: { borderTopColor: 10, borderRightColor: 10, borderBottomColor: 10, borderLeftColor: 10 } }
  );
  noisy.spacing.items.push(
    { key: "-10px", value: "-10px", count: 10, properties: { marginRight: 10 } },
    { key: "248.062px", value: "248.062px", count: 4, properties: { marginLeft: 4 } },
    { key: "40px 24px", value: "40px 24px", count: 6, properties: { gap: 6 } }
  );
  noisy.radii.items.push({ key: "3.35544e+07px", value: "3.35544e+07px", count: 6 });
  noisy.containerWidths.items = [
    { key: "1376px", value: "1376px", count: 20, viewports: { desktop: 20 } },
    { key: "1312px", value: "1312px", count: 15, viewports: { desktop: 15 } },
    { key: "1248px", value: "1248px", count: 10, viewports: { desktop: 10 } },
    { key: "1096px", value: "1096px", count: 8, viewports: { desktop: 8 } },
    { key: "720px", value: "720px", count: 12, viewports: { tablet: 12 } }
  ];
  noisy.typography.items.push(
    {
      key: "Inter duplicate fallback | 16px | 400 | 24px | normal | none",
      count: 5,
      style: { fontFamily: "Inter, system-ui, Arial, system-ui, sans-serif", fontSize: "16px", fontWeight: "400", lineHeight: "24px", letterSpacing: "normal", textTransform: "none" }
    },
    {
      key: "Inter tiny | 7px | 500 | 7px | normal | none",
      count: 4,
      style: { fontFamily: "Inter, sans-serif", fontSize: "7px", fontWeight: "500", lineHeight: "7px", letterSpacing: "normal", textTransform: "none" }
    }
  );
  const foundations = aggregateAuditFoundations([
    { sourceUrl: "https://example.com/", design: { aggregate: noisy } },
    { sourceUrl: "https://example.com/products/widget", design: { aggregate: noisy } }
  ]);
  const before = JSON.stringify(foundations);
  const candidates = buildTokenCandidates(foundations);
  assert.equal(JSON.stringify(foundations), before, "normalization must not rewrite raw foundations");

  const white = candidates.primitive.find(item => item.group === "color" && item.value === "#ffffff");
  assert.ok(white);
  assert.ok(white.evidence.rawValues?.some(value => value.startsWith("oklab(")));
  assert.ok(!candidates.primitive.some(item => item.group === "color" && String(item.value).startsWith("url(")));
  assert.ok(!candidates.primitive.some(item => item.group === "space" && ["-10px", "248.062px", "40px 24px"].includes(String(item.value))));
  assert.ok(candidates.primitive.some(item => item.id === "primitive.radius.full" && item.value === "9999px"));
  assert.equal(candidates.primitive.filter(item => item.group === "size" && (item.evidence.viewports?.desktop ?? 0) > 0).length, 3);
  assert.ok(candidates.primitive.some(item => item.group === "font.family" && item.value === "Inter, sans-serif"));
  assert.ok(candidates.primitive.some(item => item.group === "font.lineHeight" && item.type === "number"));
  assert.ok((candidates.normalization.reasons.svgPaintReference ?? 0) > 0);
  assert.ok((candidates.normalization.reasons.negativeSpacing ?? 0) > 0);
  assert.ok((candidates.normalization.reasons.subpixelLayoutArtifact ?? 0) > 0);
  assert.ok((candidates.normalization.reasons.nonAtomicSpacing ?? 0) > 0);
  assert.ok((candidates.normalization.adjustments.defaultBorderOccurrencesIgnored ?? 0) > 0);
  assert.ok((candidates.normalization.adjustments.equivalentColorValuesMerged ?? 0) > 0);
});

test("migrate design compares enhanced section signatures structurally rather than by copied text", () => {
  const first = observation("home", "https://example.com/", section("section-02", { heading: "One platform for engagement" }));
  const second = observation("stories", "https://example.com/products/widget", section("section-02", { heading: "Stories that move users forward", label: "Stories hero" }));
  const unrelated = observation("stories", "https://example.com/products/widget", section("section-08", {
    label: "FAQ",
    heading: "Questions",
    box: { x: 120, y: 5000, width: 1200, height: 380 },
    content: { textLength: 1200, headings: 1, links: 0, buttons: 0, images: 0, videos: 0, forms: 0, lists: 6 },
    structure: { directChildren: 8, directChildTags: ["h2", "details", "details", "details", "details"], descendantTags: { h2: 1, details: 7, summary: 7, p: 7 } },
    style: { ...section("x").style, backgroundColor: "rgb(247, 247, 247)", display: "grid", gap: "24px" },
    headingStyle: { ...section("x").headingStyle, fontSize: "40px", lineHeight: "44px", textTransform: "none" }
  }));
  const similar = compareSections(first, second);
  const different = compareSections(first, unrelated);
  assert.ok(similar.score > 0.75, `expected similar sections to score highly, got ${similar.score}`);
  assert.ok(similar.score > different.score + 0.15, `${similar.score} should exceed ${different.score}`);
});

test("migrate design clusters repeated cross-page sections and identifies shared shell landmarks", () => {
  const observations = [
    observation("home", "https://example.com/", section("section-01", { tag: "header", label: "header", heading: undefined, box: { x: 0, y: 0, width: 1440, height: 88 }, content: { textLength: 200, headings: 0, links: 8, buttons: 1, images: 1, videos: 0, forms: 0, lists: 1 } })),
    observation("stories", "https://example.com/products/widget", section("section-01", { tag: "header", label: "header", heading: undefined, box: { x: 0, y: 0, width: 1440, height: 88 }, content: { textLength: 220, headings: 0, links: 8, buttons: 1, images: 1, videos: 0, forms: 0, lists: 1 } })),
    observation("home", "https://example.com/", section("section-02", { heading: "Home hero" })),
    observation("stories", "https://example.com/products/widget", section("section-02", { heading: "Stories hero" })),
    observation("home", "https://example.com/", section("section-10", { tag: "footer", label: "footer", heading: undefined, box: { x: 0, y: 9000, width: 1440, height: 700 }, content: { textLength: 1500, headings: 0, links: 40, buttons: 0, images: 1, videos: 0, forms: 0, lists: 6 } })),
    observation("stories", "https://example.com/products/widget", section("section-09", { tag: "footer", label: "footer", heading: undefined, box: { x: 0, y: 8000, width: 1440, height: 700 }, content: { textLength: 1500, headings: 0, links: 40, buttons: 0, images: 1, videos: 0, forms: 0, lists: 6 } }))
  ];
  const result = clusterSections(observations);
  assert.ok(result.clusters.some(item => item.suggestedFamily === "site-header"));
  assert.ok(result.clusters.some(item => item.suggestedFamily === "site-footer"));
  assert.ok(result.clusters.some(item => item.suggestedFamily === "hero"));
  assert.equal(result.unclustered.length, 0);
});

test("migrate design clusters repeated manual sections within one page without relaxing automatic segmentation", () => {
  const manualFeatures = [
    "Native questions",
    "Zero-party data",
    "Returning sessions",
    "Product discovery",
    "Feature adoption"
  ].map((heading, index) => observation(
    "products-widget",
    "https://example.com/products/widget",
    section(`segment-${String(index + 7).padStart(2, "0")}`, {
      source: "manual",
      label: "Feature block",
      heading,
      selector: `main > section.feature:nth-of-type(${index + 1})`,
      box: { x: 0, y: 1200 + index * 820, width: 1440, height: 780 }
    })
  ));

  const manualResult = clusterSections(manualFeatures);
  assert.equal(manualResult.clusters.length, 1);
  assert.equal(manualResult.clusters[0]?.members.length, 5);
  assert.deepEqual(manualResult.clusters[0]?.pages, ["products-widget"]);
  assert.equal(manualResult.clusters[0]?.segmentation, "manual");
  assert.equal(manualResult.clusters[0]?.suggestedFamily, "features");
  assert.equal(manualResult.unclustered.length, 0);

  const automaticResult = clusterSections([
    observation("legacy", "https://example.com/legacy", section("section-01", { source: "automatic", label: "Feature block" })),
    observation("legacy", "https://example.com/legacy", section("section-02", { source: "automatic", label: "Feature block" }))
  ]);
  assert.equal(automaticResult.clusters.length, 0);
  assert.equal(automaticResult.unclustered.length, 2);
});

test("migrate design promotes repeated reviewed section families while keeping one-offs local", () => {
  const manual = (page: string, id: string, label: string, overrides: Partial<AuditSection> = {}) => observation(
    page,
    `https://example.com/${page === "home" ? "" : page}`,
    section(id, { source: "manual", label, ...overrides })
  );
  const observations = [
    manual("home", "segment-01", "Header", { role: "header", tag: "header", heading: undefined }),
    manual("stories", "segment-01", "Header", { role: "header", tag: "header", heading: undefined }),
    manual("home", "segment-02", "Hero"),
    manual("stories", "segment-03", "Hero"),
    manual("home", "segment-04", "Customers", { heading: undefined, content: { textLength: 0, headings: 0, links: 0, buttons: 0, images: 12, videos: 0, forms: 0, lists: 0 } }),
    manual("stories", "segment-05", "Customer logos", { heading: undefined, content: { textLength: 0, headings: 0, links: 0, buttons: 0, images: 12, videos: 0, forms: 0, lists: 0 } }),
    manual("home", "segment-09", "Loved By Teams. Proven In Product."),
    manual("stories", "segment-13", "Testimonials"),
    manual("home", "segment-10", "Testimonials carousel"),
    ...[1, 2, 3, 4, 5].map((number, index) => manual("stories", `segment-${String(index + 20).padStart(2, "0")}`, `Numerable feature block (${number})`, { box: { x: 0, y: 1500 + index * 800, width: 1440, height: 780 } })),
    manual("stories", "segment-40", "FAQ", { heading: "FAQ" }),
    manual("stories", "segment-41", "Breadcrumbs", { heading: undefined, content: { textLength: 80, headings: 0, links: 4, buttons: 0, images: 0, videos: 0, forms: 0, lists: 1 } })
  ];
  const clusters = clusterSections(observations).clusters;
  const model = buildComponentFamilyModel(observations, clusters, 2);

  assert.equal(model.families.find(item => item.id === "site-header")?.status, "core");
  assert.equal(model.families.find(item => item.id === "hero")?.status, "core");
  assert.equal(model.families.find(item => item.id === "logo-cloud")?.status, "core");
  assert.equal(model.families.find(item => item.id === "features")?.status, "core");
  const testimonials = model.families.find(item => item.id === "testimonials");
  assert.equal(testimonials?.status, "core");
  assert.deepEqual(testimonials?.variants.map(item => item.id), ["default", "carousel"]);
  assert.equal(testimonials?.contractHints.props.find(item => item.name === "media")?.presenceRatio, 1);
  assert.equal(testimonials?.contractHints.props.find(item => item.name === "media")?.requiredRecommendation, "optional");
  assert.equal(model.families.find(item => item.id === "hero")?.contractHints.props.find(item => item.name === "title")?.requiredRecommendation, "required");
  assert.equal(model.families.find(item => item.id === "faq")?.status, "local");
  assert.equal(model.families.find(item => item.id === "breadcrumbs")?.role, "utility");
  assert.equal(model.coverage.leafControls, "not-modeled");
  assert.ok(model.unresolved.some(item => item.area === "leaf-controls"));
});

test("migrate design gates cross-page manual clustering by conservative semantic intent", () => {
  const manual = (page: string, id: string, label: string, heading?: string, overrides: Partial<AuditSection> = {}) => observation(
    page,
    `https://example.com/${page === "home" ? "" : page}`,
    section(id, { source: "manual", label, heading, ...overrides })
  );

  assert.equal(inferManualSectionIntent(manual("home", "segment-01", "Screencast").section)?.name, "product-media");
  assert.equal(inferManualSectionIntent(manual("stories", "segment-01", "FAQ", "FAQ").section)?.name, "faq");
  assert.equal(inferManualSectionIntent(manual("home", "segment-02", "Engagement formats").section)?.name, "feature-showcase");
  assert.equal(inferManualSectionIntent(manual("stories", "segment-02", "Who should use in-app stories?", "Who should use in-app stories?").section)?.name, "audience");
  assert.equal(inferManualSectionIntent(manual("home", "segment-03", "Carousel").section)?.name, "product-media");
  assert.equal(inferManualSectionIntent(manual("stories", "segment-03", "Hero media").section)?.name, "hero-media");

  const conflicts = clusterSections([
    manual("home", "segment-01", "Screencast", "Product walkthrough"),
    manual("stories", "segment-01", "FAQ", "FAQ"),
    manual("home", "segment-02", "Engagement formats", "Everything you need for in-app engagement"),
    manual("stories", "segment-02", "Who should use in-app stories?", "Who should use in-app stories?"),
    manual("home", "segment-03", "Carousel"),
    manual("stories", "segment-03", "Hero media")
  ]);
  assert.equal(conflicts.clusters.length, 0);
  assert.equal(conflicts.unclustered.length, 6);

  const supported = clusterSections([
    manual("home", "segment-04", "Customers", undefined, { content: { textLength: 0, headings: 0, links: 0, buttons: 0, images: 20, videos: 0, forms: 0, lists: 0 } }),
    manual("stories", "segment-04", "Customer logos", undefined, { content: { textLength: 0, headings: 0, links: 0, buttons: 0, images: 20, videos: 0, forms: 0, lists: 0 } }),
    manual("home", "segment-05", "Get user cases form", "Start strong with real-world use cases"),
    manual("stories", "segment-05", "Request a demo form", "Boost in-app engagement")
  ]);
  assert.equal(supported.clusters.length, 2);
  assert.ok(supported.clusters.some(cluster => cluster.members.every(member => member.semanticIntent?.name === "logo-cloud")));
  assert.ok(supported.clusters.some(cluster => cluster.members.every(member => member.semanticIntent?.name === "lead-form")));
});

test("migrate design supports legacy audits while marking their section evidence quality", () => {
  const legacyA = observation("home", "https://example.com/", { auditId: "section-01", tag: "header", label: "header", box: { x: 0, y: 0, width: 1440, height: 88 }, background: "rgb(255, 255, 255)" });
  const legacyB = observation("stories", "https://example.com/products/widget", { auditId: "section-01", tag: "header", label: "header", box: { x: 0, y: 0, width: 1440, height: 88 }, background: "rgb(255, 255, 255)" });
  const result = clusterSections([legacyA, legacyB]);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]?.evidenceQuality, "legacy");
});

test("migrate design end-to-end writes reviewable evidence and never mutates SiteSpec source", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-"));
  try {
    const first = await writeAudit(temp, "home", "https://example.com/", {
      sections: [
        section("section-01", { tag: "header", label: "header", heading: undefined, box: { x: 0, y: 0, width: 1440, height: 88 } }),
        section("section-02", { heading: "Platform hero" })
      ],
      media: [{ kind: "image", url: "https://example.com/logo.svg", alt: "Example logo", viewports: ["desktop"], usages: [{ viewport: "desktop", selector: "header img", tag: "img", width: 140, height: 32 }] }]
    });
    const second = await writeAudit(temp, "stories", "https://example.com/products/widget", {
      sections: [
        section("section-01", { tag: "header", label: "header", heading: undefined, box: { x: 0, y: 0, width: 1440, height: 88 } }),
        section("section-02", { heading: "Stories hero" })
      ],
      media: [{ kind: "image", url: "https://example.com/products/widget-dashboard.webp", alt: "Stories editor screenshot", naturalWidth: 1600, naturalHeight: 1000, viewports: ["desktop"], usages: [{ viewport: "desktop", selector: "main img", tag: "img", width: 720, height: 450 }] }]
    });

    const result = await designAudits({ audits: [first, second], root: temp });
    assert.equal(result.summary.pages, 2);
    assert.ok(result.summary.primitiveTokenCandidates > 0);
    assert.ok(result.summary.sectionClusters >= 2);
    assert.equal(result.output, join(temp, ".sitespec", "migration", "example.com", "design"));

    const report = JSON.parse(await readFile(join(result.output, "report.json"), "utf8")) as { type: string; status: string; summary: { tokenNormalization: { rawEvidenceValues: number; normalizedEvidenceGroups: number } }; nextActions: string[] };
    const tokens = JSON.parse(await readFile(join(result.output, "token-candidates.json"), "utf8")) as { version: string; rule: string; normalization: { rejected: unknown[] }; primitive: unknown[] };
    const foundationProposal = JSON.parse(await readFile(join(result.output, "foundation-proposal.json"), "utf8")) as { type: string; model: { layers: string[] }; summary: { primitiveTokens: number; typographyRoles: number }; unresolved: unknown[] };
    const rhythm = JSON.parse(await readFile(join(result.output, "section-rhythm.json"), "utf8")) as { type: string; status: string; candidates: unknown[] };
    const componentFamilies = JSON.parse(await readFile(join(result.output, "component-families.json"), "utf8")) as { type: string; families: unknown[]; coverage: { leafControls: string } };
    const media = JSON.parse(await readFile(join(result.output, "media-roles.json"), "utf8")) as { items: Array<{ role: string }> };
    assert.equal(report.type, "sitespec-migrate-design");
    assert.equal(report.status, "complete");
    assert.equal(tokens.version, "0.2");
    assert.match(tokens.rule, /proposals only/i);
    assert.ok(tokens.primitive.length > 0);
    assert.ok(Array.isArray(tokens.normalization.rejected));
    assert.equal(foundationProposal.type, "sitespec-migrate-design-foundation-proposal");
    assert.equal(rhythm.type, "sitespec-migrate-design-section-rhythm");
    assert.equal(componentFamilies.type, "sitespec-migrate-design-component-families");
    assert.ok(componentFamilies.families.length > 0);
    assert.equal(componentFamilies.coverage.leafControls, "not-modeled");
    assert.ok(Array.isArray(rhythm.candidates));
    assert.deepEqual(foundationProposal.model.layers, ["evidence", "normalized-candidates", "foundation-proposal"]);
    assert.ok(foundationProposal.summary.primitiveTokens > 0);
    assert.ok(foundationProposal.summary.typographyRoles > 0);
    assert.ok(Array.isArray(foundationProposal.unresolved));
    assert.equal(result.files.foundationProposal, "foundation-proposal.json");
    assert.equal(result.files.sectionRhythm, "section-rhythm.json");
    assert.equal(result.files.componentFamilies, "component-families.json");
    assert.equal(result.summary.foundationProposal.primitiveTokens, foundationProposal.summary.primitiveTokens);
    assert.equal(report.summary.tokenNormalization.rawEvidenceValues, result.summary.foundationValues);
    assert.ok(report.summary.tokenNormalization.normalizedEvidenceGroups <= report.summary.tokenNormalization.rawEvidenceValues);
    assert.ok(media.items.some(item => item.role === "logo"));
    assert.ok(media.items.some(item => item.role === "product-shot"));
    await assert.rejects(readFile(join(temp, "design", "tokens.json"), "utf8"), (error: unknown) => (error as { code?: string }).code === "ENOENT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate design consumes direct audit leaf UI evidence without deriving controls from section counts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-ui-"));
  const uiItem = (selector: string): AuditLeafUiObservation & { viewport?: string } => ({
    kind: "button",
    selector,
    tag: "a",
    text: "Get started",
    href: "https://example.com/demo",
    segmentId: "segment-02",
    viewport: "desktop",
    style: {
      display: "inline-flex",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(17, 97, 231)",
      borderTopWidth: "0px",
      borderTopColor: "rgb(17, 97, 231)",
      borderRadius: "8px",
      paddingTop: "12px",
      paddingRight: "20px",
      paddingBottom: "12px",
      paddingLeft: "20px",
      fontSize: "16px",
      fontWeight: "600",
      lineHeight: "24px"
    },
    structure: { directChildren: 0, icons: 0, images: 0 },
    box: { x: 40, y: 300, width: 140, height: 48 }
  });
  try {
    const first = await writeAudit(temp, "home", "https://example.com/", { ui: [uiItem("#home-cta")] });
    const second = await writeAudit(temp, "stories", "https://example.com/products/widget", { ui: [uiItem("#stories-cta")] });
    const result = await designAudits({ audits: [first, second], root: temp });
    assert.equal(result.summary.uiFamilies.observed, 2);
    assert.equal(result.summary.uiFamilies.core, 1);
    assert.equal(result.files.uiFamilies, "ui-families.json");

    const ui = JSON.parse(await readFile(join(result.output, "ui-families.json"), "utf8")) as any;
    assert.equal(ui.type, "sitespec-migrate-design-ui-families");
    assert.equal(ui.families.find((item: any) => item.id === "button").status, "core");
    const components = JSON.parse(await readFile(join(result.output, "component-families.json"), "utf8")) as any;
    assert.equal(components.coverage.leafControls, "observed");
    assert.ok(!components.unresolved.some((item: any) => item.area === "leaf-controls"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate design prefers completed manual segments over automatic audit sections and excludes ignored regions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-manual-"));
  try {
    const first = await writeAudit(temp, "home", "https://example.com/", {
      sections: [section("section-01", { label: "Automatic whole-page wrapper", box: { x: 0, y: 0, width: 1440, height: 9000 } })]
    });
    const second = await writeAudit(temp, "stories", "https://example.com/products/widget", {
      sections: [section("section-01", { label: "Automatic whole-page wrapper", box: { x: 0, y: 0, width: 1440, height: 8500 } })]
    });

    for (const [dir, heroLabel] of [[first, "Platform hero"], [second, "Stories hero"]] as const) {
      const audit = JSON.parse(await readFile(join(dir, "audit.json"), "utf8")) as { files: Record<string, string> };
      audit.files.segments = "segments.json";
      await writeFile(join(dir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
      await writeFile(join(dir, "segments.json"), `${JSON.stringify({
        version: "0.3",
        type: "sitespec-migrate-segments",
        status: "complete",
        source: "manual-dom",
        sourceUrl: dir === first ? "https://example.com/" : "https://example.com/products/widget",
        observedUrl: dir === first ? "https://example.com/" : "https://example.com/products/widget",
        viewport: { name: "desktop", width: 1440, height: 1200 },
        segments: [
          { id: "segment-01", source: "manual-dom", role: "header", label: "Header", selector: "header", tag: "header", fingerprint: { tag: "header", classes: [], textHash: "a", structureHash: "b", ancestry: [], box: { x: 0, y: 0, width: 1440, height: 90 } }, evidence: section("x", { selector: "header", tag: "header", heading: undefined, box: { x: 0, y: 0, width: 1440, height: 90 } }) },
          { id: "segment-02", source: "manual-dom", role: "section", label: heroLabel, selectors: ["main > div:nth-of-type(1)", "main > div:nth-of-type(3)"], roots: [{ selector: "main > div:nth-of-type(1)" }, { selector: "main > div:nth-of-type(3)" }], selector: "main > div:nth-of-type(1)", tag: "group", fingerprint: { tag: "group", classes: [], textHash: "c", structureHash: "d", ancestry: [], box: { x: 0, y: 90, width: 1440, height: 780 } }, evidence: section("x", { selector: "main > div:nth-of-type(1)", tag: "group", heading: heroLabel, box: { x: 0, y: 90, width: 1440, height: 780 } }) },
          { id: "segment-03", source: "manual-dom", role: "ignore", label: "Cookie UI", selector: "#cookie", tag: "div", fingerprint: { tag: "div", classes: [], textHash: "e", structureHash: "f", ancestry: [], box: { x: 0, y: 870, width: 1440, height: 100 } } },
          { id: "segment-04", source: "manual-dom", role: "footer", label: "Footer", selector: "footer", tag: "footer", fingerprint: { tag: "footer", classes: [], textHash: "g", structureHash: "h", ancestry: [], box: { x: 0, y: 970, width: 1440, height: 600 } }, evidence: section("x", { selector: "footer", tag: "footer", heading: undefined, box: { x: 0, y: 970, width: 1440, height: 600 } }) }
        ]
      }, null, 2)}\n`, "utf8");
    }

    const result = await designAudits({ audits: [first, second], root: temp });
    assert.equal(result.summary.manualSegmentPages, 2);
    const clusters = JSON.parse(await readFile(join(result.output, "section-clusters.json"), "utf8")) as { clusters: Array<{ segmentation?: string; members: Array<{ label?: string; selectors?: string[] }> }>; unclustered: Array<{ label?: string; selectors?: string[] }> };
    assert.ok(clusters.clusters.some(cluster => cluster.segmentation === "manual"));
    const heroMember = clusters.clusters.flatMap(cluster => cluster.members).find(member => member.label === "Platform hero");
    assert.deepEqual(heroMember?.selectors, ["main > div:nth-of-type(1)", "main > div:nth-of-type(3)"]);
    const labels = [...clusters.clusters.flatMap(cluster => cluster.members.map(member => member.label)), ...clusters.unclustered.map(item => item.label)];
    assert.ok(!labels.includes("Automatic whole-page wrapper"));
    assert.ok(!labels.includes("Cookie UI"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate design requires at least two completed audits from one host", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-errors-"));
  try {
    const first = await writeAudit(temp, "home", "https://example.com/");
    await assert.rejects(designAudits({ audits: [first], root: temp }), (error: unknown) => {
      assert.ok(error instanceof MigrateDesignError);
      assert.equal(error.code, "MIGRATE_DESIGN_AUDITS_TOO_FEW");
      return true;
    });
    await assert.rejects(designAudits({ audits: [first, first], root: temp }), (error: unknown) => {
      assert.ok(error instanceof MigrateDesignError);
      assert.equal(error.code, "MIGRATE_DESIGN_AUDITS_DUPLICATE");
      return true;
    });
    const foreign = await writeAudit(temp, "foreign", "https://other.example/");
    await assert.rejects(designAudits({ audits: [first, foreign], root: temp }), (error: unknown) => {
      assert.ok(error instanceof MigrateDesignError);
      assert.equal(error.code, "MIGRATE_DESIGN_SITE_MISMATCH");
      return true;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate design output cleanup is ownership-safe", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-migrate-design-output-"));
  try {
    await writeFile(join(temp, "keep.txt"), "important", "utf8");
    await assert.rejects(prepareDesignOutputDirectory(temp), (error: unknown) => {
      assert.ok(error instanceof MigrateDesignError);
      assert.equal(error.code, "MIGRATE_DESIGN_OUTPUT_NOT_EMPTY");
      return true;
    });
    assert.equal(await readFile(join(temp, "keep.txt"), "utf8"), "important");
    await writeFile(join(temp, "report.json"), JSON.stringify({ type: "sitespec-migrate-design" }), "utf8");
    await writeFile(join(temp, "foundation-review.json"), JSON.stringify({ type: "sitespec-migrate-foundation-review", marker: "human-decision" }), "utf8");
    await writeFile(join(temp, "component-review.json"), JSON.stringify({ type: "sitespec-migrate-component-review", marker: "component-decision" }), "utf8");
    await writeFile(join(temp, "ui-review.json"), JSON.stringify({ type: "sitespec-migrate-ui-review", marker: "ui-decision" }), "utf8");
    await prepareDesignOutputDirectory(temp);
    await assert.rejects(readFile(join(temp, "keep.txt"), "utf8"), (error: unknown) => (error as { code?: string }).code === "ENOENT");
    assert.match(await readFile(join(temp, "foundation-review.json"), "utf8"), /human-decision/);
    assert.match(await readFile(join(temp, "component-review.json"), "utf8"), /component-decision/);
    assert.match(await readFile(join(temp, "ui-review.json"), "utf8"), /ui-decision/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

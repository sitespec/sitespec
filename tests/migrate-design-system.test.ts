import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createComponentReview, materializeComponentContracts } from "../packages/cli/src/migrate-components.ts";
import { createUiReview, materializeUiContracts } from "../packages/cli/src/migrate-ui-contracts.ts";
import { materializeDesignSystemStaging, materializeShellContracts, MigrateDesignSystemError } from "../packages/cli/src/migrate-design-system.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function componentFamily(id: string, layer: "shell" | "section", role: "intro" | "utility", pages = ["home", "stories"]) {
  return {
    id,
    suggestedComponentId: id,
    layer,
    role,
    status: "core",
    confidence: layer === "shell" ? 0.97 : 0.92,
    reason: `${id} repeated`,
    evidence: {
      instances: pages.length,
      pages,
      pageCoverage: 1,
      crossPage: true,
      repeatedWithinPage: false,
      manualInstances: pages.length,
      semanticIntentSupport: pages.length,
      semanticIntentConfidence: 0.95,
      clusters: [],
      clusterSimilarity: 0.9,
      observedContent: {
        headings: { min: id === "hero" ? 1 : 0, max: 1, average: 1 },
        links: { min: 1, max: 4, average: 2 },
        buttons: { min: 0, max: 1, average: 0.5 },
        images: { min: 0, max: 1, average: 0.5 },
        forms: { min: 0, max: 0, average: 0 },
        lists: { min: 0, max: 1, average: 0.5 }
      }
    },
    variants: [{ id: "default", confidence: 0.9, source: "default", members: pages.map(page => ({ page, auditId: `${page}-${id}` })), reason: "default" }],
    contractHints: {
      role,
      ...(id === "hero" ? { maxPerPage: 1, placement: "first", pageHeading: true } : {}),
      props: id === "hero" ? [{ name: "title", kind: "string", confidence: 0.95, presenceRatio: 1, variantCoverage: 1, requiredRecommendation: "required", reason: "heading" }] : []
    },
    members: pages.map(page => ({ page, sourceUrl: `https://example.com/${page}`, auditId: `${page}-${id}`, source: "manual", variant: "default" }))
  };
}

function uiFamily(id: string, eligibility: "auto" | "review-required", role: "action" | "navigation" | "content") {
  return {
    id,
    suggestedUiId: id,
    sourceKinds: id === "card" ? ["card-candidate"] : [id],
    role,
    status: "core",
    materialization: { eligibility, reason: eligibility },
    confidence: id === "card" ? 0.8 : 0.93,
    reason: `${id} repeated`,
    evidence: {
      instances: 4,
      viewportOccurrences: 12,
      pages: ["home", "stories"],
      pageCoverage: 1,
      manualLinkedInstances: 3,
      manualLinkRatio: 0.75,
      styleClusters: 2,
      examples: []
    },
    variants: id === "button"
      ? [
          { id: "ghost", confidence: 0.9, instances: 2, reason: "ghost" },
          { id: "solid", confidence: 0.9, instances: 2, reason: "solid" }
        ]
      : [{ id: "default", confidence: 0.9, instances: 4, reason: "default" }],
    contractHints: {
      props: id === "button"
        ? [{ name: "label", kind: "string", required: true, confidence: 0.95, reason: "label" }]
        : id === "link"
          ? [{ name: "label", kind: "string", required: true, confidence: 0.95, reason: "label" }, { name: "href", kind: "url", required: true, confidence: 0.99, reason: "href" }]
          : []
    }
  };
}

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-design-system-stage-"));
  const analysis = join(temp, "design");
  await mkdir(analysis, { recursive: true });

  const componentProposal = {
    version: "0.2",
    type: "sitespec-migrate-design-component-families",
    site: "example.com",
    rule: "component proposal",
    families: [
      componentFamily("site-header", "shell", "utility"),
      componentFamily("site-footer", "shell", "utility"),
      componentFamily("hero", "section", "intro")
    ],
    unresolved: [],
    coverage: { sectionFamilies: "modeled", shellFamilies: "modeled", leafControls: "observed", reason: "fixture" },
    summary: { total: 3, core: 3, supporting: 0, local: 0, shell: 2, section: 1, variants: 3, unresolved: 0 }
  };
  await writeFile(join(analysis, "component-families.json"), `${JSON.stringify(componentProposal, null, 2)}\n`, "utf8");
  const componentReview = await createComponentReview({ analysis, root: temp });
  const componentContracts = await materializeComponentContracts({ review: componentReview.output, root: temp });

  const uiProposal = {
    version: "0.2",
    type: "sitespec-migrate-design-ui-families",
    site: "example.com",
    rule: "ui proposal",
    families: [
      uiFamily("button", "auto", "action"),
      uiFamily("link", "auto", "navigation"),
      uiFamily("card", "review-required", "content")
    ],
    unresolved: [{ area: "candidate-surfaces", reason: "card review", families: ["card"] }],
    summary: { observed: 30, total: 3, core: 3, supporting: 0, local: 0, variants: 3, candidateFamilies: 1 }
  };
  await writeFile(join(analysis, "ui-families.json"), `${JSON.stringify(uiProposal, null, 2)}\n`, "utf8");
  const uiReview = await createUiReview({ analysis, root: temp });
  const uiContracts = await materializeUiContracts({ review: uiReview.output, root: temp });

  const foundationProposal = `${JSON.stringify({ version: "0.1", type: "sitespec-migrate-foundation-proposal", site: "example.com" }, null, 2)}\n`;
  await writeFile(join(analysis, "foundation-proposal.json"), foundationProposal, "utf8");
  const foundationReview = {
    version: "0.2",
    type: "sitespec-migrate-foundation-review",
    site: "example.com",
    source: { proposal: "foundation-proposal.json", proposalSha256: sha256(foundationProposal), proposalVersion: "0.1" },
    decisions: {}
  };
  await writeFile(join(analysis, "foundation-review.json"), `${JSON.stringify(foundationReview, null, 2)}\n`, "utf8");
  const foundationTokens = {
    primitive: {
      font: { family: { sans: { $type: "fontFamily", $value: "\"Roboto Flex\", sans-serif" } } },
      space: { page: { $type: "dimension", $value: "24px" }, section: { $type: "dimension", $value: "96px" } },
      size: { content: { $type: "dimension", $value: "1376px" } }
    },
    semantic: {
      space: {
        page: { $type: "dimension", $value: "{primitive.space.page}" },
        section: { $type: "dimension", $value: "{primitive.space.section}" }
      },
      size: { content: { $type: "dimension", $value: "{primitive.size.content}" } },
      font: { family: { body: { $type: "fontFamily", $value: "{primitive.font.family.sans}" } } }
    }
  };
  await writeFile(join(analysis, "foundation-tokens.json"), `${JSON.stringify(foundationTokens, null, 2)}\n`, "utf8");
  await writeFile(join(analysis, "foundation-materialization.json"), `${JSON.stringify({
    version: "0.2",
    type: "sitespec-migrate-foundation-materialization",
    site: "example.com",
    review: "foundation-review.json",
    proposal: "foundation-proposal.json",
    status: "ready",
    quality: "provisional",
    output: "foundation-tokens.json",
    blockers: [],
    warnings: ["space.section provisional"],
    summary: { primitive: 4, semantic: 4, typographyRoles: 0, synthesizedPrimitive: 0, provisionalTokens: 2, carriedSemanticTokens: 0 }
  }, null, 2)}\n`, "utf8");

  return { temp, analysis, componentReview, componentContracts, uiReview, uiContracts };
}

test("accepted shell families become a default shell-pack contract without fabricated Astro", async () => {
  const data = await fixture();
  try {
    const result = await materializeShellContracts({ review: data.componentReview.output, root: data.temp });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.summary, { acceptedShellFamilies: 2, packs: 1, headerRegions: 1, footerRegions: 1, otherRegions: 0 });
    const doc = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(doc.packs[0].entry, "shell/default.astro");
    assert.deepEqual(doc.packs[0].files, ["shell/default.astro", "shell/Header.astro", "shell/Footer.astro"]);
    assert.ok(doc.packs[0].unresolved.some((item: string) => item.includes("implementations")));
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

test("contract staging assembles only accepted manifests and reports implementation/font blockers", async () => {
  const data = await fixture();
  try {
    await materializeShellContracts({ review: data.componentReview.output, root: data.temp });
    const result = await materializeDesignSystemStaging({ analysis: data.analysis, root: data.temp });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.uiContracts, 2);
    assert.equal(result.summary.sectionContracts, 1);
    assert.equal(result.summary.shellPacks, 1);
    assert.equal(result.summary.implementationBlockers, 6);
    assert.equal(result.summary.fontBlockers, 1);
    assert.equal(await readFile(join(result.output, "ui", "card", "ui.yaml"), "utf8").then(() => true, () => false), false);
    const buttonManifest = await readFile(join(result.output, "ui", "button", "ui.yaml"), "utf8");
    assert.match(buttonManifest, /id: "button"/);
    assert.match(buttonManifest, /- "default"/);
    assert.match(buttonManifest, /- "solid"/);
    assert.doesNotMatch(buttonManifest, /- "ghost"/);
    assert.match(await readFile(join(result.output, "components", "hero", "component.yaml"), "utf8"), /id: "hero"/);
    const manifest = await readFile(join(result.output, "design-system.yaml"), "utf8");
    assert.match(manifest, /id: "example"/);
    assert.match(manifest, /- "button"/);
    assert.match(manifest, /- "link"/);
    assert.match(manifest, /- "hero"/);
    assert.doesNotMatch(manifest, /- "card"/);
    assert.match(manifest, /entry: "shell\/default\.astro"/);
    const report = JSON.parse(await readFile(result.report, "utf8")) as any;
    assert.ok(report.blockers.some((item: string) => item === "implementation missing: ui/button/index.astro"));
    assert.ok(report.blockers.some((item: string) => item.includes("Roboto Flex")));
    assert.match(report.excluded.rule, /Only accepted/);
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

test("design system staging refuses to erase an unowned output directory", async () => {
  const data = await fixture();
  try {
    await materializeShellContracts({ review: data.componentReview.output, root: data.temp });
    const output = join(data.analysis, "custom-stage");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "keep.txt"), "keep", "utf8");
    await assert.rejects(
      materializeDesignSystemStaging({ analysis: data.analysis, root: data.temp, output }),
      (error: unknown) => error instanceof MigrateDesignSystemError && error.code === "MIGRATE_DESIGN_SYSTEM_OUTPUT_NOT_OWNED"
    );
    assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(data.temp, { recursive: true, force: true });
  }
});

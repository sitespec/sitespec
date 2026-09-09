import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createComponentReview,
  materializeComponentContracts,
  MigrateComponentsError,
  validateComponentReview
} from "../packages/cli/src/migrate-components.ts";

function proposal() {
  const family = (id: string, status: "core" | "supporting" | "local", layer: "shell" | "section", confidence: number, variants = ["default"]) => ({
    id,
    suggestedComponentId: id,
    layer,
    ...(layer === "section" ? { role: id === "hero" ? "intro" : id === "breadcrumbs" ? "utility" : "content" } : {}),
    status,
    confidence,
    reason: `${id} reason`,
    evidence: {
      instances: status === "local" ? 1 : 2,
      pages: status === "local" ? ["stories"] : ["home", "stories"],
      pageCoverage: status === "local" ? 0.5 : 1,
      crossPage: status !== "local",
      repeatedWithinPage: false,
      manualInstances: status === "local" ? 1 : 2,
      semanticIntentSupport: 1,
      semanticIntentConfidence: confidence,
      clusters: [],
      clusterSimilarity: 0.9,
      observedContent: {
        headings: { min: 1, max: 1, average: 1 },
        links: { min: 0, max: 1, average: 0.5 },
        buttons: { min: 0, max: 1, average: 0.5 },
        images: { min: 0, max: 1, average: 0.5 },
        forms: { min: 0, max: 0, average: 0 },
        lists: { min: 0, max: 0, average: 0 }
      }
    },
    variants: variants.map(variant => ({ id: variant, confidence, source: variant === "default" ? "default" : "reviewer-label", members: [], reason: `${variant} reason` })),
    contractHints: {
      ...(layer === "section" ? { role: id === "hero" ? "intro" : id === "breadcrumbs" ? "utility" : "content" } : {}),
      ...(id === "hero" ? { maxPerPage: 1, placement: "first", pageHeading: true } : {}),
      props: id === "hero" ? [{ name: "title", kind: "string", confidence: 0.95, reason: "headings repeat" }] : []
    },
    members: []
  });
  return {
    version: "0.1",
    type: "sitespec-migrate-design-component-families",
    site: "example.com",
    rule: "proposal",
    families: [
      family("site-header", "core", "shell", 0.99),
      family("hero", "core", "section", 0.92, ["default", "split"]),
      family("product-media", "supporting", "section", 0.76, ["carousel", "screencast"]),
      family("breadcrumbs", "local", "section", 0.95)
    ],
    unresolved: [{ area: "leaf-controls", reason: "not modeled" }],
    coverage: { sectionFamilies: "modeled", shellFamilies: "modeled", leafControls: "not-modeled", reason: "section only" },
    summary: { total: 4, core: 2, supporting: 1, local: 1, shell: 1, section: 3, variants: 6, unresolved: 1 }
  };
}

async function fixture(): Promise<{ temp: string; analysis: string }> {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-components-review-"));
  const analysis = join(temp, "design");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(analysis, { recursive: true }));
  await writeFile(join(analysis, "component-families.json"), `${JSON.stringify(proposal(), null, 2)}\n`, "utf8");
  return { temp, analysis };
}

test("component review conservatively accepts only core families and their variants", async () => {
  const { temp, analysis } = await fixture();
  try {
    const result = await createComponentReview({ analysis, root: temp });
    assert.deepEqual(result.summary.families, { accept: 2, reject: 0, pending: 2 });
    assert.deepEqual(result.summary.shell, { accept: 1, reject: 0, pending: 0 });
    assert.deepEqual(result.summary.section, { accept: 1, reject: 0, pending: 2 });
    assert.deepEqual(result.summary.acceptedComponentIds, ["hero", "site-header"]);
    assert.deepEqual(result.summary.pendingLocalFamilies, ["breadcrumbs"]);

    const review = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(review.type, "sitespec-migrate-component-review");
    assert.equal(review.decisions.families.find((item: any) => item.family === "hero").action, "accept");
    assert.deepEqual(review.decisions.families.find((item: any) => item.family === "hero").variants.map((item: any) => [item.id, item.action]), [["default", "accept"], ["split", "accept"]]);
    assert.equal(review.decisions.families.find((item: any) => item.family === "product-media").action, "pending");
    assert.equal(review.coverage.leafControls, "not-modeled");
    assert.match(review.source.proposalSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("component review supports manual/all policies and protects existing reviewer decisions", async () => {
  const { temp, analysis } = await fixture();
  try {
    const manual = await createComponentReview({ analysis, root: temp, policy: "manual" });
    assert.deepEqual(manual.summary.families, { accept: 0, reject: 0, pending: 4 });
    await assert.rejects(
      createComponentReview({ analysis, root: temp, policy: "all" }),
      (error: unknown) => error instanceof MigrateComponentsError && error.code === "MIGRATE_COMPONENTS_REVIEW_EXISTS"
    );
    const all = await createComponentReview({ analysis, root: temp, policy: "all", force: true });
    assert.deepEqual(all.summary.families, { accept: 4, reject: 0, pending: 0 });
    assert.deepEqual(all.summary.variants, { accept: 6, reject: 0, pending: 0 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("component review validation rejects duplicate accepted ids and invalid variant ids", () => {
  const value: any = {
    version: "0.1",
    type: "sitespec-migrate-component-review",
    site: "example.com",
    source: { proposal: "component-families.json", proposalSha256: "a".repeat(64), proposalVersion: "0.1" },
    policy: "manual",
    rule: "review",
    decisions: {
      families: [
        { source: "hero", family: "hero", componentId: "hero", layer: "section", role: "intro", status: "core", confidence: 0.9, action: "accept", reason: "x", variants: [{ source: "default", id: "default", action: "accept", confidence: 0.9, reason: "x" }] },
        { source: "intro", family: "intro", componentId: "hero", layer: "section", role: "intro", status: "local", confidence: 0.8, action: "accept", reason: "x", variants: [{ source: "bad", id: "Bad Variant", action: "accept", confidence: 0.8, reason: "x" }] }
      ]
    },
    unresolved: [],
    coverage: { sectionFamilies: "modeled", shellFamilies: "modeled", leafControls: "not-modeled", reason: "x" },
    summary: {}
  };
  assert.throws(() => validateComponentReview(value), (error: unknown) => error instanceof MigrateComponentsError && error.code === "MIGRATE_COMPONENTS_REVIEW_INVALID");
});

test("accepted section families materialize as component.yaml proposals while shell families stay deferred", async () => {
  const { temp, analysis } = await fixture();
  try {
    const reviewResult = await createComponentReview({ analysis, root: temp });
    const result = await materializeComponentContracts({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "ready");
    assert.equal(result.summary.acceptedFamilies, 2);
    assert.equal(result.summary.sectionContracts, 1);
    assert.equal(result.summary.shellDeferred, 1);
    assert.deepEqual(result.files, ["hero/component.yaml"]);

    const hero = await readFile(join(result.output, "hero", "component.yaml"), "utf8");
    assert.match(hero, /specVersion: "0.5"/);
    assert.match(hero, /id: "hero"/);
    assert.match(hero, /role: "intro"/);
    assert.match(hero, /- "default"/);
    assert.match(hero, /- "split"/);
    assert.match(hero, /pageHeading: true/);

    const report = JSON.parse(await readFile(result.report, "utf8")) as any;
    assert.equal(report.type, "sitespec-migrate-component-contracts");
    assert.equal(report.contracts.length, 1);
    assert.equal(report.shell.length, 1);
    assert.equal(report.shell[0].id, "site-header");
    assert.match(report.shell[0].reason, /shell packs/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("component contract proposal rejects stale reviews and accepted families without default variant", async () => {
  const { temp, analysis } = await fixture();
  try {
    const reviewResult = await createComponentReview({ analysis, root: temp });
    const proposalFile = join(analysis, "component-families.json");
    const original = await readFile(proposalFile, "utf8");
    await writeFile(proposalFile, `${original.trim()}\n `, "utf8");
    await assert.rejects(
      materializeComponentContracts({ review: reviewResult.output, root: temp }),
      (error: unknown) => error instanceof MigrateComponentsError && error.code === "MIGRATE_COMPONENTS_REVIEW_STALE"
    );

    await writeFile(proposalFile, original, "utf8");
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as any;
    const hero = review.decisions.families.find((item: any) => item.family === "hero");
    hero.variants.find((item: any) => item.source === "default").action = "reject";
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    const result = await materializeComponentContracts({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some(blocker => blocker.includes("default variant")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("component contract proposal never deletes an arbitrary non-owned output directory", async () => {
  const { temp, analysis } = await fixture();
  try {
    const reviewResult = await createComponentReview({ analysis, root: temp });
    const output = join(temp, "existing-components");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(output, { recursive: true }));
    await writeFile(join(output, "keep.txt"), "do not delete\n", "utf8");
    await assert.rejects(
      materializeComponentContracts({ review: reviewResult.output, root: temp, output }),
      (error: unknown) => error instanceof MigrateComponentsError && error.code === "MIGRATE_COMPONENTS_OUTPUT_NOT_OWNED"
    );
    assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "do not delete\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

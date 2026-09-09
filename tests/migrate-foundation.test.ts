import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MigrateFoundationError,
  createFoundationReview,
  materializeFoundationReview,
  type FoundationReviewDocument
} from "../packages/cli/src/migrate-foundation.ts";

function primitive(path: string, type: string, value: string | number, status: "core" | "supporting" | "exception" = "core", confidence = 0.9) {
  return { path, type, value, status, confidence, sources: [`candidate:${path}`], reason: `Evidence for ${path}` };
}

function proposal() {
  return {
    version: "0.1",
    type: "sitespec-migrate-design-foundation-proposal",
    site: "example.com",
    source: { tokenCandidates: "token-candidates.json" },
    model: {
      layers: ["evidence", "normalized-candidates", "foundation-proposal"],
      rule: "reviewable proposal"
    },
    primitive: {
      color: [
        primitive("primitive.color.brand.500", "color", "#1161e7"),
        primitive("primitive.color.white", "color", "#ffffff")
      ],
      spacing: {
        baseUnit: "4px",
        baseUnitConfidence: 0.94,
        tokens: [
          primitive("primitive.space.16", "dimension", "16px"),
          primitive("primitive.space.24", "dimension", "24px"),
          primitive("primitive.space.32", "dimension", "32px"),
          primitive("primitive.space.40", "dimension", "40px"),
          primitive("primitive.space.64", "dimension", "64px", "supporting", 0.62)
        ]
      },
      radius: [],
      shadow: [],
      size: [primitive("primitive.size.1376", "dimension", "1376px")],
      font: {
        family: [primitive("primitive.font.family.sans", "fontFamily", "Roboto Flex, sans-serif")],
        size: [primitive("primitive.font.size.16", "dimension", "16px")],
        weight: [primitive("primitive.font.weight.500", "number", 500)],
        lineHeight: [primitive("primitive.font.lineHeight.1-5", "number", 1.5)],
        letterSpacing: []
      }
    },
    semantic: [
      {
        path: "semantic.color.accent.default",
        primitive: "primitive.color.brand.500",
        confidence: 0.88,
        sources: ["candidate:brand"],
        reason: "Brand accent"
      },
      {
        path: "semantic.size.content",
        primitive: "primitive.size.1376",
        confidence: 0.95,
        sources: ["candidate:size"],
        reason: "Content width"
      }
    ],
    typography: [
      {
        role: "text.md.default",
        status: "core",
        confidence: 0.8,
        style: {
          fontFamily: "primitive.font.family.sans",
          fontSize: "primitive.font.size.16",
          fontWeight: "primitive.font.weight.500",
          lineHeight: "primitive.font.lineHeight.1-5"
        },
        source: "typography.body",
        alternates: [],
        evidence: { count: 100, pages: ["home", "stories"], coverage: 1 }
      }
    ],
    layout: {
      convention: "outer-gutter-inner-container",
      contentWidth: {
        primitive: "primitive.size.1376",
        max: "1376px",
        confidence: 0.95,
        reason: "Responsive content width",
        responsiveEvidence: [
          { viewport: "desktop", viewportWidth: "1440px", observedWidth: "1376px", source: "size.desktop" },
          { viewport: "tablet", viewportWidth: "768px", observedWidth: "720px", source: "size.tablet" },
          { viewport: "mobile", viewportWidth: "375px", observedWidth: "343px", source: "size.mobile" }
        ]
      },
      pageGutter: {
        status: "proposed",
        confidence: 0.94,
        values: [
          { viewport: "desktop", value: "32px", primitive: "primitive.space.32", source: "size.desktop", confirmedBySpacing: true },
          { viewport: "tablet", value: "24px", primitive: "primitive.space.24", source: "size.tablet", confirmedBySpacing: true },
          { viewport: "mobile", value: "16px", primitive: "primitive.space.16", source: "size.mobile", confirmedBySpacing: true }
        ],
        reason: "Symmetric outer gutter"
      },
      innerContainerCandidates: []
    },
    unresolved: [
      { area: "space.section", reason: "Needs section evidence." }
    ],
    summary: {
      primitiveTokens: 12,
      corePrimitiveTokens: 11,
      semanticRoles: 2,
      typographyRoles: 1,
      unresolved: 1
    }
  };
}

async function writeProposal(root: string): Promise<string> {
  const file = join(root, "foundation-proposal.json");
  await writeFile(file, `${JSON.stringify(proposal(), null, 2)}\n`, "utf8");
  return file;
}

async function copyTemplateProject(root: string): Promise<void> {
  await cp(join(process.cwd(), "packages/template/template"), root, { recursive: true });
}

test("migrate foundation review makes unresolved section spacing provisional when the target Design System has a safe fallback", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-provisional-review-"));
  try {
    await copyTemplateProject(temp);
    await writeProposal(temp);
    const result = await createFoundationReview({ analysis: temp, root: temp });
    assert.deepEqual(result.summary.blocking, []);
    assert.deepEqual(result.summary.provisional, ["layout.sectionSpacing"]);

    const review = JSON.parse(await readFile(result.output, "utf8")) as FoundationReviewDocument;
    assert.equal(review.version, "0.2");
    assert.equal(review.decisions.layout.sectionSpacing.action, "provisional");
    assert.equal(review.decisions.layout.sectionSpacing.provisional?.primitivePath, "primitive.space.section");
    assert.equal(review.decisions.layout.sectionSpacing.provisional?.value, "clamp(4.5rem, 9vw, 8rem)");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation materialization carries unresolved target semantics as explicit provisional compatibility tokens", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-provisional-materialize-"));
  try {
    await copyTemplateProject(temp);
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "ready");
    assert.equal(result.quality, "provisional");
    assert.ok(result.summary.provisionalTokens > 0);
    assert.ok(result.summary.carriedSemanticTokens > 0);
    assert.match(result.warnings.join("\n"), /layout\.sectionSpacing is provisional/);
    assert.match(result.warnings.join("\n"), /existing target semantic tokens provisionally/);

    const tokens = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(tokens.semantic.space.section.$value, "{primitive.space.section}");
    assert.equal(tokens.semantic.space.section.$extensions["org.sitespec.migration"].status, "provisional");
    assert.equal(tokens.semantic.color.surface.default.$value, "{primitive.color.white}");
    assert.equal(tokens.semantic.color.surface.default.$extensions["org.sitespec.migration"].status, "provisional");
    assert.equal(tokens.semantic.color.accent.default.$value, "{primitive.color.brand.500}");
    assert.equal(tokens.semantic.color.accent.default.$extensions, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation never uses compatibility carry-forward to override an explicit rejected section spacing decision", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-provisional-reject-"));
  try {
    await copyTemplateProject(temp);
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    review.decisions.layout.sectionSpacing.action = "reject";
    delete review.decisions.layout.sectionSpacing.provisional;
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes("layout.sectionSpacing"));
    const tokens = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(tokens.semantic.space?.section, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation review resolves the ESM-only packaged default-template fallback without a target project", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-review-"));
  try {
    const templatePackage = JSON.parse(await readFile(join(process.cwd(), "packages/template/package.json"), "utf8")) as any;
    assert.equal(templatePackage.exports["."].require, undefined);
    assert.equal(templatePackage.exports["."].import, "./dist/index.js");

    await writeProposal(temp);
    const result = await createFoundationReview({ analysis: temp, root: temp });
    assert.equal(result.policy, "conservative");
    assert.equal(result.summary.primitive.accept, 11);
    assert.equal(result.summary.primitive.pending, 1);
    assert.equal(result.summary.semantic.accept, 2);
    assert.equal(result.summary.typography.accept, 1);
    assert.deepEqual(result.summary.blocking, []);
    assert.deepEqual(result.summary.provisional, ["layout.sectionSpacing"]);

    const review = JSON.parse(await readFile(result.output, "utf8")) as FoundationReviewDocument;
    assert.equal(review.source.proposal, "foundation-proposal.json");
    assert.match(review.source.proposalSha256, /^[a-f0-9]{64}$/);
    assert.equal(review.decisions.layout.pageGutter.action, "accept");
    assert.equal(review.decisions.layout.pageGutter.value, "clamp(16px, 3.125vw, 32px)");
    assert.equal(review.decisions.layout.sectionSpacing.action, "provisional");
    assert.equal(review.decisions.layout.sectionSpacing.provisional?.source, "sitespec-default-template");
    assert.deepEqual(review.decisions.layout.sectionSpacing.candidates.map(item => item.primitive), ["primitive.space.32", "primitive.space.40", "primitive.space.64"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation materialization is partial while required layout decisions remain pending and preserves primitive renames", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-materialize-blocked-"));
  try {
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    const brand = review.decisions.primitive.find(item => item.source === "primitive.color.brand.500")!;
    brand.path = "primitive.color.brand.primary";
    review.decisions.layout.sectionSpacing.action = "pending";
    delete review.decisions.layout.sectionSpacing.provisional;
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.blockers, ["layout.sectionSpacing"]);
    assert.equal(result.hints.length, 1);
    assert.match(result.hints[0]!, /predates section-rhythm inference/);
    assert.equal(result.summary.synthesizedPrimitive, 1);
    const tokens = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(tokens.primitive.color.brand.primary.$value, "#1161e7");
    assert.equal(tokens.semantic.color.accent.default.$value, "{primitive.color.brand.primary}");
    assert.equal(tokens.primitive.space.page.$value, "clamp(16px, 3.125vw, 32px)");
    assert.equal(tokens.semantic.space.page.$value, "{primitive.space.page}");
    assert.equal(tokens.semantic.font.role.text.md.default.size.$value, "{primitive.font.size.16}");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation materialization becomes ready only after section spacing is explicitly resolved", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-materialize-ready-"));
  try {
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    review.decisions.layout.sectionSpacing.action = "accept";
    review.decisions.layout.sectionSpacing.primitive = "primitive.space.40";
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.blockers, []);
    const tokens = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(tokens.semantic.space.section.$value, "{primitive.space.40}");
    assert.equal(tokens.semantic.size.content.$value, "{primitive.size.1376}");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation conservative review accepts a high-confidence inferred section rhythm and its supporting primitive", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-inferred-section-"));
  try {
    const inferred = proposal();
    (inferred.layout as any).sectionSpacing = {
      status: "proposed",
      primitive: "primitive.space.64",
      value: "64px",
      confidence: 0.86,
      sourceCandidate: "primitive.space.64",
      reason: "Balanced reusable section-root rhythm."
    };
    inferred.unresolved = [];
    inferred.summary.unresolved = 0;
    await writeFile(join(temp, "foundation-proposal.json"), `${JSON.stringify(inferred, null, 2)}\n`, "utf8");

    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    assert.equal(review.decisions.primitive.find(item => item.source === "primitive.space.64")?.action, "accept");
    assert.equal(review.decisions.layout.sectionSpacing.action, "accept");
    assert.equal(review.decisions.layout.sectionSpacing.primitive, "primitive.space.64");
    assert.deepEqual(review.summary.blocking, []);

    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "ready");
    const tokens = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(tokens.semantic.space.section.$value, "{primitive.space.64}");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation refuses a stale review after proposal evidence changes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-stale-"));
  try {
    const proposalFile = await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const changed = proposal();
    changed.primitive.color[0]!.value = "#0000ff";
    await writeFile(proposalFile, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

    await assert.rejects(materializeFoundationReview({ review: reviewResult.output, root: temp }), (error: unknown) => {
      assert.ok(error instanceof MigrateFoundationError);
      assert.equal(error.code, "MIGRATE_FOUNDATION_PROPOSAL_CHANGED");
      return true;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("migrate foundation rejects invalid manually edited review actions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-invalid-review-"));
  try {
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    (review.decisions.primitive[0] as any).action = "approved";
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    await assert.rejects(materializeFoundationReview({ review: reviewResult.output, root: temp }), (error: unknown) => {
      assert.ok(error instanceof MigrateFoundationError);
      assert.equal(error.code, "MIGRATE_FOUNDATION_REVIEW_INVALID");
      assert.match(error.message, /expected accept, reject, or pending/);
      return true;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("migrate foundation blocks semantic remaps across primitive token types", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-semantic-type-"));
  try {
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    review.decisions.layout.sectionSpacing.action = "accept";
    review.decisions.layout.sectionSpacing.primitive = "primitive.space.40";
    const accent = review.decisions.semantic.find(item => item.source === "semantic.color.accent.default")!;
    accent.primitive = "primitive.space.16";
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes("semantic semantic.color.accent.default cannot change token type from color to dimension"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("migrate foundation blocks non-dimension primitives for required layout tokens", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-foundation-layout-type-"));
  try {
    await writeProposal(temp);
    const reviewResult = await createFoundationReview({ analysis: temp, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as FoundationReviewDocument;
    review.decisions.layout.sectionSpacing.action = "accept";
    review.decisions.layout.sectionSpacing.primitive = "primitive.color.brand.500";
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");

    const result = await materializeFoundationReview({ review: reviewResult.output, root: temp });
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes("layout.sectionSpacing requires a dimension primitive, got color"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

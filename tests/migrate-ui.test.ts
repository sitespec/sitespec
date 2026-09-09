import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUiFamilyModel } from "../packages/cli/src/migrate-ui.ts";
import type { AuditLeafUiObservation } from "../packages/cli/src/migrate-audit.ts";
import {
  createUiReview,
  materializeUiContracts,
  MigrateUiError
} from "../packages/cli/src/migrate-ui-contracts.ts";

function item(kind: AuditLeafUiObservation["kind"], selector: string, overrides: Partial<AuditLeafUiObservation> = {}): AuditLeafUiObservation {
  return {
    kind,
    selector,
    tag: kind === "link" || kind === "button" ? "a" : kind === "card-candidate" ? "article" : "span",
    text: "Example",
    segmentId: "segment-01",
    style: {
      display: "inline-flex",
      color: "rgb(255, 255, 255)",
      backgroundColor: kind === "button" ? "rgb(17, 97, 231)" : "transparent",
      borderTopWidth: kind === "button" ? "0px" : "1px",
      borderTopColor: "rgb(17, 97, 231)",
      borderRadius: kind === "button" ? "8px" : "16px",
      paddingTop: "12px",
      paddingRight: "20px",
      paddingBottom: "12px",
      paddingLeft: "20px",
      fontSize: "16px",
      fontWeight: "600",
      lineHeight: "24px",
      boxShadow: "none"
    },
    structure: { directChildren: 1, icons: 0, images: 0 },
    box: { x: 20, y: 20, width: 160, height: 48 },
    ...overrides
  };
}

test("leaf UI family inference promotes repeated direct controls across pages", () => {
  const model = buildUiFamilyModel([
    {
      page: "home",
      sourceUrl: "https://example.com/",
      items: [
        { ...item("button", "#hero-cta"), viewport: "desktop" },
        { ...item("button", "#hero-cta"), viewport: "mobile" },
        { ...item("link", "#nav-docs", { href: "https://example.com/docs" }), viewport: "desktop" }
      ]
    },
    {
      page: "stories",
      sourceUrl: "https://example.com/stories",
      items: [
        { ...item("button", "#form-submit"), viewport: "desktop" },
        { ...item("button", "#form-submit"), viewport: "mobile" },
        { ...item("link", "#nav-docs", { href: "https://example.com/docs" }), viewport: "desktop" }
      ]
    }
  ]);

  const button = model.families.find(family => family.id === "button");
  assert.equal(button?.status, "core");
  assert.equal(button?.evidence.instances, 2);
  assert.equal(button?.evidence.viewportOccurrences, 4);
  assert.deepEqual(button?.evidence.pages, ["home", "stories"]);
  assert.deepEqual(button?.variants.map(variant => variant.id), ["solid"]);
  assert.ok(button?.contractHints.props.some(prop => prop.name === "label"));
});

test("badge/card remain candidate-weighted until reuse evidence is stronger", () => {
  const model = buildUiFamilyModel([
    {
      page: "home",
      sourceUrl: "https://example.com/",
      items: [
        { ...item("badge-candidate", ".badge-new"), viewport: "desktop" },
        { ...item("card-candidate", ".feature-card"), viewport: "desktop" }
      ]
    }
  ]);
  assert.equal(model.families.find(family => family.id === "badge")?.status, "local");
  assert.equal(model.families.find(family => family.id === "card")?.status, "local");
  assert.ok(model.unresolved.some(item => item.area === "candidate-surfaces"));
  assert.ok(model.unresolved.some(item => item.area === "interactive-states"));
});

test("form-control proposals expose the current UiRole vocabulary gap", () => {
  const model = buildUiFamilyModel([
    {
      page: "home",
      sourceUrl: "https://example.com/",
      items: [
        { ...item("input", "#email", { tag: "input", name: "email", placeholder: "Email" }), viewport: "desktop" },
        { ...item("select", "#country", { tag: "select", name: "country" }), viewport: "desktop" }
      ]
    }
  ]);
  assert.ok(model.families.some(family => family.id === "text-input"));
  assert.ok(model.families.some(family => family.id === "select"));
  assert.ok(model.unresolved.some(entry => entry.area === "form-control-role"));
});

function uiProposal() {
  const family = (id: string, status: "core" | "supporting" | "local", eligibility: "auto" | "review-required", role: "action" | "navigation" | "content", variants: string[], sourceKinds: AuditLeafUiObservation["kind"][]) => ({
    id,
    suggestedUiId: id,
    sourceKinds,
    role,
    status,
    materialization: { eligibility, reason: `${id} ${eligibility}` },
    confidence: status === "core" ? 0.9 : 0.7,
    reason: `${id} reason`,
    evidence: {
      instances: status === "core" ? 4 : 1,
      viewportOccurrences: status === "core" ? 12 : 3,
      pages: status === "core" ? ["home", "stories"] : ["home"],
      pageCoverage: status === "core" ? 1 : 0.5,
      manualLinkedInstances: 2,
      manualLinkRatio: 0.5,
      styleClusters: 2,
      examples: []
    },
    variants: variants.map(variant => ({ id: variant, confidence: 0.9, instances: 2, reason: `${variant} reason` })),
    contractHints: {
      props: id === "button"
        ? [
            { name: "label", kind: "string", required: true, confidence: 0.95, reason: "labels" },
            { name: "href", kind: "url", required: false, confidence: 0.8, reason: "optional anchors" }
          ]
        : id === "link"
          ? [
              { name: "label", kind: "string", required: true, confidence: 0.96, reason: "labels" },
              { name: "href", kind: "url", required: true, confidence: 0.99, reason: "anchors" }
            ]
          : []
    }
  });
  return {
    version: "0.1",
    type: "sitespec-migrate-design-ui-families",
    site: "example.com",
    rule: "proposal",
    families: [
      family("link", "core", "auto", "navigation", ["default"], ["link"]),
      family("button", "core", "auto", "action", ["ghost", "solid"], ["button"]),
      family("card", "core", "review-required", "content", ["default"], ["card-candidate"])
    ],
    unresolved: [
      { area: "candidate-surfaces", reason: "review", families: ["card"] },
      { area: "interactive-states", reason: "not modeled" }
    ],
    summary: { observed: 50, total: 3, core: 3, supporting: 0, local: 0, variants: 4, candidateFamilies: 1 }
  };
}

async function uiFixture(): Promise<{ temp: string; analysis: string }> {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-ui-review-"));
  const analysis = join(temp, "design");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(analysis, { recursive: true }));
  await writeFile(join(analysis, "ui-families.json"), `${JSON.stringify(uiProposal(), null, 2)}\n`, "utf8");
  return { temp, analysis };
}

test("UI review separates reuse strength from materialization eligibility", async () => {
  const { temp, analysis } = await uiFixture();
  try {
    const result = await createUiReview({ analysis, root: temp });
    assert.deepEqual(result.summary.families, { accept: 2, reject: 0, pending: 1 });
    assert.equal(result.summary.autoEligible, 2);
    assert.equal(result.summary.reviewRequired, 1);
    assert.deepEqual(result.summary.acceptedUiIds, ["button", "link"]);
    const review = JSON.parse(await readFile(result.output, "utf8")) as any;
    assert.equal(review.decisions.families.find((entry: any) => entry.family === "card").action, "pending");
    assert.equal(review.decisions.families.find((entry: any) => entry.family === "card").status, "core");
    assert.equal(review.decisions.families.find((entry: any) => entry.family === "card").eligibility, "review-required");
    const button = review.decisions.families.find((entry: any) => entry.family === "button");
    assert.equal(button.defaultVariantSource, "ghost");
    assert.equal(button.variants.find((entry: any) => entry.source === "ghost").id, "default");
    assert.equal(button.variants.find((entry: any) => entry.source === "solid").id, "solid");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("accepted leaf UI families materialize as schema-shaped ui.yaml contract proposals", async () => {
  const { temp, analysis } = await uiFixture();
  try {
    const review = await createUiReview({ analysis, root: temp });
    const result = await materializeUiContracts({ review: review.output, root: temp });
    assert.equal(result.status, "ready");
    assert.equal(result.summary.uiContracts, 2);
    assert.equal(result.summary.reviewRequiredAccepted, 0);
    assert.deepEqual(result.files, ["link/ui.yaml", "button/ui.yaml"]);
    const button = await readFile(join(result.output, "button", "ui.yaml"), "utf8");
    assert.match(button, /id: "button"/);
    assert.match(button, /role: "action"/);
    assert.match(button, /- "default"/);
    assert.match(button, /- "solid"/);
    assert.doesNotMatch(button, /- "ghost"/);
    assert.match(button, /required:\n\s+- "label"/);
    assert.doesNotMatch(button, /runtime:/);
    const report = JSON.parse(await readFile(result.report, "utf8")) as any;
    assert.equal(report.contracts.some((entry: any) => entry.uiId === "card"), false);
    const buttonContract = report.contracts.find((entry: any) => entry.uiId === "button");
    assert.deepEqual(buttonContract.variantSources, [
      { source: "ghost", id: "default" },
      { source: "solid", id: "solid" }
    ]);
    assert.equal(buttonContract.defaultVariantSource, "ghost");
    assert.ok(report.warnings.some((entry: string) => entry.includes("Interactive")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("UI contracts reject accepted reviews that omit the canonical default variant", async () => {
  const { temp, analysis } = await uiFixture();
  try {
    const reviewResult = await createUiReview({ analysis, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as any;
    const button = review.decisions.families.find((entry: any) => entry.family === "button");
    button.variants = button.variants.map((variant: any) => ({ ...variant, id: variant.source }));
    delete button.defaultVariantSource;
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    const materialized = await materializeUiContracts({ review: reviewResult.output, root: temp });
    assert.equal(materialized.status, "partial");
    assert.ok(materialized.blockers.some(entry => entry.includes("canonical id \"default\"")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("explicit review can materialize a candidate family and stale reviews remain protected", async () => {
  const { temp, analysis } = await uiFixture();
  try {
    const reviewResult = await createUiReview({ analysis, root: temp });
    const review = JSON.parse(await readFile(reviewResult.output, "utf8")) as any;
    const card = review.decisions.families.find((entry: any) => entry.family === "card");
    card.action = "accept";
    card.variants.forEach((variant: any) => { variant.action = "accept"; });
    await writeFile(reviewResult.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    const materialized = await materializeUiContracts({ review: reviewResult.output, root: temp });
    assert.equal(materialized.summary.reviewRequiredAccepted, 1);
    assert.ok(materialized.warnings.some(entry => entry.includes("explicitly overrode")));

    const proposalFile = join(analysis, "ui-families.json");
    const raw = await readFile(proposalFile, "utf8");
    await writeFile(proposalFile, `${raw.trim()}\n `, "utf8");
    await assert.rejects(
      materializeUiContracts({ review: reviewResult.output, root: temp }),
      (error: unknown) => error instanceof MigrateUiError && error.code === "MIGRATE_UI_REVIEW_STALE"
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

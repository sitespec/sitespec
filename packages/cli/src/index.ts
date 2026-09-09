#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { inspectDesignSystem, inspectProject, loadProject, validateLoadedProject, type Diagnostic } from "@sitespec/core";
import { initProject } from "./init.js";
import { buildProject } from "./build.js";
import { addComponent } from "./add-component.js";
import { addUi } from "./add-ui.js";
import { validateAstroComponentContracts } from "@sitespec/astro";
import { PreviewError, startPreview } from "./preview.js";
import { startDev, type DevEvent } from "./dev.js";
import { deployGitHubPages, GitHubPagesDeployError } from "./deploy-github-pages.js";
import { installDesignSystem, packDesignSystem } from "./design-system.js";
import { auditUrl, MigrateAuditError, parseAuditViewports } from "./migrate-audit.js";
import { designAudits, MigrateDesignError } from "./migrate-design.js";
import { createFoundationReview, materializeFoundationReview, MigrateFoundationError, type FoundationReviewPolicy } from "./migrate-foundation.js";
import { createComponentReview, materializeComponentContracts, MigrateComponentsError, type ComponentReviewPolicy } from "./migrate-components.js";
import { createUiReview, materializeUiContracts, MigrateUiError, type UiReviewPolicy } from "./migrate-ui-contracts.js";
import { materializeDesignSystemStaging, materializeShellContracts, MigrateDesignSystemError } from "./migrate-design-system.js";
import { inferImplementations, MigrateImplementationError } from "./migrate-implementations.js";
import { segmentAudit, MigrateSegmentError } from "./migrate-segment.js";

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const place = [diagnostic.file, diagnostic.page, diagnostic.section].filter(Boolean).join(" :: ");
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${place ? `  ${place}` : ""}`);
    console.log(`  ${diagnostic.message}`);
    if (diagnostic.sourceFile) console.log(`  source: ${diagnostic.sourceFile}${diagnostic.sourcePath ?? ""}`);
    if (diagnostic.hint) console.log(`  hint: ${diagnostic.hint}`);
    if (diagnostic.allowed?.length) console.log(`  allowed: ${diagnostic.allowed.map(value => JSON.stringify(value)).join(", ")}`);
    for (const suggestion of diagnostic.suggestions ?? []) {
      const detail = suggestion.command
        ? suggestion.command
        : suggestion.candidates?.length
          ? suggestion.candidates.join(", ")
          : suggestion.value !== undefined
            ? JSON.stringify(suggestion.value)
            : suggestion.message;
      console.log(`  repair: ${suggestion.action}${detail ? ` -> ${detail}` : ""}`);
    }
  }
}

const cliPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };

const program = new Command();
program.name("sitespec").description("SiteSpec CLI").version(cliPackage.version);

program
  .command("init")
  .description("Create a minimal Site Spec project")
  .argument("[directory]", "target directory", ".")
  .option("--name <name>", "display name for the site")
  .option("--json", "print machine-readable JSON")
  .action(async (directory: string, options: { name?: string; json?: boolean }) => {
    try {
      const result = await initProject({ directory, name: options.name });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", success: true, ...result }, null, 2));
      } else {
        console.log(`Initialized ${result.name}`);
        console.log(`  root: ${result.root}`);
        console.log(`  files: ${result.files.length}`);
        console.log("\nNext:");
        console.log(`  cd ${JSON.stringify(result.root)}`);
        console.log("  npm install");
        console.log("  npm run validate");
        console.log("  npm run dev");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", success: false, error: message }, null, 2));
      } else {
        console.error(`ERROR INIT_FAILED\n  ${message}`);
      }
      process.exitCode = 2;
    }
  });

const add = program.command("add").description("Add a sanctioned Site Spec resource");

add
  .command("component")
  .description("Create a registered section component")
  .argument("<id>", "component id, for example comparison-table")
  .option("--role <role>", "semantic role", "content")
  .option("--root <path>", "project root", ".")
  .option("--json", "print machine-readable JSON")
  .action(async (id: string, options: { role: string; root: string; json?: boolean }) => {
    try {
      const result = await addComponent({ root: resolve(options.root), id, role: options.role });
      const nextActions = [
        { action: "inspect-project", command: "npm run site -- spec --json" },
        { action: "inspect-design", command: "npm run site -- spec design --json" },
        { action: "define-contract", file: `components/${result.id}/component.yaml` },
        { action: "implement-component", file: `components/${result.id}/index.astro` },
        { action: "validate", command: "npm run site -- validate --json" },
        { action: "build", command: "npm run build" }
      ];
      if (options.json) {
        console.log(JSON.stringify({
          version: "0.2",
          success: true,
          component: { id: result.id, role: result.role },
          files: result.files,
          nextActions
        }, null, 2));
      } else {
        console.log(`Added component ${result.id}`);
        for (const file of result.files) console.log(`  ${file}`);
        console.log("\nNext:");
        console.log("  npm run site -- spec --json");
        console.log("  npm run site -- spec design --json");
        console.log(`  define props in components/${result.id}/component.yaml`);
        console.log(`  implement components/${result.id}/index.astro`);
        console.log("  npm run site -- validate --json");
        console.log("  npm run build");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", success: false, error: message }, null, 2));
      } else {
        console.error(`ERROR ADD_COMPONENT_FAILED\n  ${message}`);
      }
      process.exitCode = 2;
    }
  });

add
  .command("ui")
  .description("Create an internal UI primitive")
  .argument("<id>", "UI primitive id, for example button")
  .option("--role <role>", "UI role", "content")
  .option("--root <path>", "project root", ".")
  .option("--json", "print machine-readable JSON")
  .action(async (id: string, options: { role: string; root: string; json?: boolean }) => {
    try {
      const result = await addUi({ root: resolve(options.root), id, role: options.role });
      const nextActions = [
        { action: "inspect-ui", command: `npm run site -- spec ui:${result.id} --json` },
        { action: "define-contract", file: `ui/${result.id}/ui.yaml` },
        { action: "implement-ui", file: `ui/${result.id}/index.astro` },
        { action: "validate", command: "npm run site -- validate --json" }
      ];
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", success: true, ui: { id: result.id, role: result.role }, files: result.files, nextActions }, null, 2));
      } else {
        console.log(`Added UI primitive ${result.id}`);
        for (const file of result.files) console.log(`  ${file}`);
        console.log(`\nInspect: npm run site -- spec ui:${result.id} --json`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ version: "0.2", success: false, error: message }, null, 2));
      else console.error(`ERROR ADD_UI_FAILED\n  ${message}`);
      process.exitCode = 2;
    }
  });

const designSystemCommand = program
  .command("design-system")
  .description("Inspect, pack, or install a SiteSpec 0.4+ Design System")
  .option("--root <path>", "project root", ".")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const result = await inspectDesignSystem(resolve(options.root));
    if (options.json) {
      console.log(JSON.stringify({ version: "0.5", ...result }, null, 2));
    } else if (result.designSystem) {
      const ds = result.designSystem as {
        id: string; name: string; version: string;
        themes: { default: string; items: Array<{ id: string }> };
        libraries: { ui: unknown[]; sections: unknown[]; presets: unknown[] };
        shells: { default: string; items: Array<{ id: string }> };
        tokens: { primitive: number; semantic: number; extension: string; rules: Record<string, string> };
      };
      console.log(`${ds.name} (${ds.id}) v${ds.version}`);
      console.log(`tokens: ${ds.tokens.primitive} primitive, ${ds.tokens.semantic} semantic`);
      console.log(`extensions: ${ds.tokens.extension} (${Object.entries(ds.tokens.rules).map(([key, value]) => `${key}=${value}`).join(", ")})`);
      console.log(`themes: ${ds.themes.items.map(item => item.id).join(", ")} (default: ${ds.themes.default})`);
      console.log(`shells: ${ds.shells.items.map(item => item.id).join(", ")} (default: ${ds.shells.default})`);
      console.log(`library: ${ds.libraries.ui.length} UI, ${ds.libraries.sections.length} sections, ${ds.libraries.presets.length} presets`);
      if (result.diagnostics.length > 0) printDiagnostics(result.diagnostics);
    } else {
      printDiagnostics(result.diagnostics);
    }
    process.exitCode = result.valid ? 0 : 1;
  });

designSystemCommand
  .command("pack")
  .description("Copy the current Design System into a portable pack directory")
  .argument("<directory>", "empty target directory for the pack")
  .option("--root <path>", "project root", ".")
  .option("--json", "print machine-readable JSON")
  .action(async (directory: string, options: { root: string; json?: boolean }) => {
    try {
      const result = await packDesignSystem({ root: resolve(options.root), directory });
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: true, designSystem: { id: result.id, version: result.version }, root: result.root, files: result.files }, null, 2));
      else {
        console.log(`Packed Design System ${result.id}@${result.version}`);
        console.log(`  target: ${result.root}`);
        console.log(`  files: ${result.files.length}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: message }, null, 2));
      else console.error(`ERROR DESIGN_SYSTEM_PACK_FAILED\n  ${message}`);
      process.exitCode = 2;
    }
  });

designSystemCommand
  .command("install")
  .description("Copy a portable Design System pack into this SiteSpec 0.4+ project")
  .argument("<source>", "Design System pack directory")
  .option("--root <path>", "project root", ".")
  .option("--replace", "replace files owned by the currently installed Design System pack")
  .option("--force", "overwrite colliding site-owned files")
  .option("--json", "print machine-readable JSON")
  .action(async (source: string, options: { root: string; replace?: boolean; force?: boolean; json?: boolean }) => {
    try {
      const result = await installDesignSystem({ root: resolve(options.root), source, replace: options.replace, force: options.force });
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: true, designSystem: { id: result.id, version: result.version }, root: result.root, files: result.files }, null, 2));
      else {
        console.log(`Installed Design System ${result.id}@${result.version}`);
        console.log(`  root: ${result.root}`);
        console.log(`  files: ${result.files.length}`);
        console.log("\nNext: npm run site -- validate --json");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: message }, null, 2));
      else console.error(`ERROR DESIGN_SYSTEM_INSTALL_FAILED\n  ${message}`);
      process.exitCode = 2;
    }
  });

const migrate = program.command("migrate").description("Audit and migrate an existing website into SiteSpec");

migrate
  .command("audit")
  .description("Capture one production page as migration evidence without creating a Design System")
  .argument("<url>", "public http(s) URL to audit")
  .option("--root <path>", "base directory for the default .sitespec/audit output", ".")
  .option("--output <path>", "explicit audit output directory")
  .option("--browser-path <path>", "Chrome/Chromium executable; alternatively set SITESPEC_CHROME_PATH")
  .option("--viewports <list>", "comma-separated desktop,tablet,mobile viewport names", "desktop,tablet,mobile")
  .option("--timeout <ms>", "navigation/browser timeout in milliseconds", (value: string) => Number(value), 30000)
  .option("--settle <ms>", "quiet time after lazy-media scrolling in milliseconds", (value: string) => Number(value), 600)
  .option("--json", "print machine-readable JSON")
  .action(async (url: string, options: { root: string; output?: string; browserPath?: string; viewports: string; timeout: number; settle: number; json?: boolean }) => {
    try {
      const result = await auditUrl({
        url,
        root: resolve(options.root),
        output: options.output,
        browserPath: options.browserPath,
        viewports: parseAuditViewports(options.viewports),
        timeoutMs: options.timeout,
        settleMs: options.settle
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, audit: result }, null, 2));
      } else {
        console.log("Migration audit captured.");
        console.log(`  source: ${result.sourceUrl}`);
        if (result.finalUrl !== result.sourceUrl) console.log(`  final: ${result.finalUrl}`);
        console.log(`  output: ${result.output}`);
        console.log(`  screenshots: ${result.summary.screenshots}`);
        console.log(`  sections: ${result.summary.sections}`);
        console.log(`  section viewport regions: ${result.summary.sectionRegionNodes}`);
        if (result.summary.manualRegionMatches !== undefined) console.log(`  manual root viewport matches: ${result.summary.manualRegionMatches}`);
        if (result.summary.manualBoundaryGroups !== undefined) console.log(`  manual group boundary matches: ${result.summary.manualBoundaryGroups}`);
        console.log(`  layout nodes: ${result.summary.layoutNodes}`);
        console.log(`  media: ${result.summary.media}`);
        console.log(`  leaf UI observations: ${result.summary.uiElements}`);
        console.log(`  visible elements: ${result.summary.visibleElements}`);
        console.log(`  design inventory: ${result.summary.colors} colors, ${result.summary.typography} typography styles, ${result.summary.radii} radii`);
        console.log("\nNext:");
        console.log(`  inspect ${resolve(result.output, "audit.json")}`);
        console.log("  audit a second representative page before extracting shared Design System rules");
      }
    } catch (error) {
      const code = error instanceof MigrateAuditError ? error.code : "MIGRATE_AUDIT_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateAuditError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else {
        console.error(`ERROR ${code}\n  ${message}`);
        if (details?.browserPath) console.error(`  browser: ${String(details.browserPath)}`);
      }
      process.exitCode = 2;
    }
  });


migrate
  .command("segment")
  .description("Select human-confirmed production DOM regions in a live Chrome session")
  .argument("<audit>", "completed migrate audit directory (or audit.json file)")
  .option("--root <path>", "base directory for the audit path", ".")
  .option("--browser-path <path>", "Chrome/Chromium executable; alternatively set SITESPEC_CHROME_PATH")
  .option("--timeout <ms>", "production navigation/browser startup timeout in milliseconds", (value: string) => Number(value), 30000)
  .option("--json", "print machine-readable JSON after Save & finish")
  .action(async (audit: string, options: { root: string; browserPath?: string; timeout: number; json?: boolean }) => {
    try {
      const result = await segmentAudit({
        audit,
        root: resolve(options.root),
        browserPath: options.browserPath,
        timeoutMs: options.timeout,
        onReady: url => {
          const message = `Live production DOM picker: ${url}`;
          if (options.json) console.error(message);
          else {
            console.log(message);
            console.log("  Inspect mode: hover/click a DOM root; use arrows for parent/child/siblings; Add/update immediately resumes hover inspection");
            console.log("  Add root to block (G) groups sibling DOM roots into one logical block; long block lists scroll independently");
            console.log("  Drag/collapse the inspector as needed; Reload restores grouped selections; P toggles Interact mode");
            console.log("  Save & finish writes segments.json");
          }
        }
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, segmentation: result }, null, 2));
      } else {
        console.log("Live DOM segmentation saved.");
        console.log(`  source: ${result.observedUrl}`);
        console.log(`  audit: ${result.audit}`);
        console.log(`  output: ${result.output}`);
        console.log(`  logical DOM blocks: ${result.summary.segments} (${result.summary.sections} sections, ${result.summary.ignored} ignored)`);
        console.log(`  shell: header=${result.summary.header ? "yes" : "no"}, footer=${result.summary.footer ? "yes" : "no"}`);
        console.log("\nNext:");
        console.log("  segment the second representative audit, then run migrate design again");
      }
    } catch (error) {
      const code = error instanceof MigrateSegmentError ? error.code : "MIGRATE_SEGMENT_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateSegmentError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

migrate
  .command("design")
  .description("Analyze two or more migration audits and propose shared Design System evidence without generating source")
  .argument("<audits...>", "completed migrate audit directories (or audit.json files) from the same site")
  .option("--root <path>", "base directory for audit paths and default .sitespec/migration output", ".")
  .option("--output <path>", "explicit design analysis output directory")
  .option("--json", "print machine-readable JSON")
  .action(async (audits: string[], options: { root: string; output?: string; json?: boolean }) => {
    try {
      const result = await designAudits({ audits, root: resolve(options.root), output: options.output });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, design: result }, null, 2));
      } else {
        console.log("Migration design analysis complete.");
        console.log(`  site: ${result.site}`);
        console.log(`  pages: ${result.summary.pages}`);
        console.log(`  manual segmentation: ${result.summary.manualSegmentPages}/${result.summary.pages} pages`);
        console.log(`  output: ${result.output}`);
        console.log(`  foundations: ${result.summary.foundationValues} observed values`);
        console.log(`  normalization: ${result.summary.tokenNormalization.rawEvidenceValues} raw -> ${result.summary.tokenNormalization.normalizedEvidenceGroups} groups (${result.summary.tokenNormalization.rejectedEvidenceValues} rejected, ${result.summary.tokenNormalization.mergedEvidenceValues} merged)`);
        console.log(`  token candidates: ${result.summary.primitiveTokenCandidates} primitive, ${result.summary.semanticTokenCandidates} semantic, ${result.summary.typographyCandidates} typography roles`);
        console.log(`  foundation proposal: ${result.summary.foundationProposal.corePrimitiveTokens}/${result.summary.foundationProposal.primitiveTokens} core primitives, ${result.summary.foundationProposal.semanticRoles} semantic roles, ${result.summary.foundationProposal.typographyRoles} typography roles, ${result.summary.foundationProposal.unresolved} unresolved decisions`);
        console.log(`  section rhythm: ${result.summary.sectionRhythm.status}${result.summary.sectionRhythm.recommended ? ` (${result.summary.sectionRhythm.recommended}, confidence ${result.summary.sectionRhythm.confidence})` : ` (${result.summary.sectionRhythm.candidates} candidates)`}`);
        console.log(`  section clusters: ${result.summary.sectionClusters} (${result.summary.clusteredSections} clustered, ${result.summary.unclusteredSections} unclustered)`);
        console.log(`  component families: ${result.summary.componentFamilies.total} (${result.summary.componentFamilies.core} core, ${result.summary.componentFamilies.supporting} supporting, ${result.summary.componentFamilies.local} local; ${result.summary.componentFamilies.variants} variants)`);
        console.log(`  leaf UI families: ${result.summary.uiFamilies.total} (${result.summary.uiFamilies.core} core, ${result.summary.uiFamilies.supporting} supporting, ${result.summary.uiFamilies.local} local; ${result.summary.uiFamilies.observed} observations)`);
        console.log(`  shell candidates: ${result.summary.shellCandidates}`);
        console.log(`  media roles: ${result.summary.mediaRoleCandidates}`);
        console.log("\nNext:");
        console.log(`  review ${resolve(result.output, "foundations.json")}`);
        console.log(`  review ${resolve(result.output, "token-candidates.json")}`);
        console.log(`  review ${resolve(result.output, "section-rhythm.json")} for inferred vertical section rhythm`);
        console.log(`  review ${resolve(result.output, "foundation-proposal.json")} as the proposed scale/foundation model`);
        console.log(`  compare ${resolve(result.output, "section-clusters.json")} with the source section screenshots`);
        console.log(`  review ${resolve(result.output, "component-families.json")} as the proposed component architecture`);
        console.log(`  review ${resolve(result.output, "ui-families.json")} as direct leaf UI evidence`);
        console.log(`  npm run site -- migrate foundation review ${JSON.stringify(result.output)}`);
        console.log(`  npm run site -- migrate components review ${JSON.stringify(result.output)}`);
        console.log(`  npm run site -- migrate ui review ${JSON.stringify(result.output)}`);
      }
    } catch (error) {
      const code = error instanceof MigrateDesignError ? error.code : "MIGRATE_DESIGN_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateDesignError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

const migrateShell = migrate.command("shell").description("Propose reviewed shell-pack contracts from accepted shell families");

migrateShell
  .command("contracts")
  .description("Create a shell-pack contract proposal from accepted shell family decisions")
  .argument("<review>", "component-review.json or its analysis directory")
  .option("--root <path>", "base directory for review/output paths", ".")
  .option("--output <path>", "shell contract JSON path; defaults beside component-review.json")
  .option("--json", "print machine-readable JSON")
  .action(async (review: string, options: { root: string; output?: string; json?: boolean }) => {
    try {
      const result = await materializeShellContracts({ review, root: resolve(options.root), output: options.output });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, shellContracts: result }, null, 2));
      } else {
        console.log("Shell contract proposal ready.");
        console.log(`  site: ${result.site}`);
        console.log(`  output: ${result.output}`);
        console.log(`  packs: ${result.summary.packs}`);
        console.log(`  regions: ${result.summary.headerRegions} header, ${result.summary.footerRegions} footer, ${result.summary.otherRegions} other`);
        if (result.blockers.length) {
          console.log("  blockers:");
          result.blockers.forEach(item => console.log(`    - ${item}`));
        }
        if (result.warnings.length) {
          console.log("  warnings:");
          result.warnings.forEach(item => console.log(`    - ${item}`));
        }
        console.log("\nNext:");
        console.log(`  review ${result.output}`);
        console.log(`  npm run site -- migrate implementations infer ${JSON.stringify(resolve(result.output, ".."))}`);
      }
      if (result.status === "blocked") process.exitCode = 1;
    } catch (error) {
      const code = error instanceof MigrateDesignSystemError ? error.code : "MIGRATE_SHELL_CONTRACTS_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateDesignSystemError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

const migrateImplementations = migrate.command("implementations").description("Infer runnable Astro implementations from accepted migration contracts and DOM/style evidence");

migrateImplementations
  .command("infer")
  .description("Generate Astro implementations plus semantic token extensions from accepted contracts and audit evidence")
  .argument("<analysis>", "migrate design output directory")
  .option("--root <path>", "base directory for analysis/audit/output paths", ".")
  .option("--output <path>", "implementation preview directory; defaults to <analysis>/implementation-preview")
  .option("--json", "print machine-readable JSON")
  .action(async (analysis: string, options: { root: string; output?: string; json?: boolean }) => {
    try {
      const result = await inferImplementations({ analysis, root: resolve(options.root), output: options.output });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: result.status !== "blocked", implementationInference: result }, null, 2));
      } else {
        console.log(`Implementation inference ${result.status}.`);
        console.log(`  site: ${result.site}`);
        console.log(`  output: ${result.output}`);
        console.log(`  report: ${result.report}`);
        console.log(`  implementations: ${result.summary.uiImplementations} UI, ${result.summary.sectionImplementations} sections, ${result.summary.shellImplementations} shell files`);
        console.log(`  semantic token extensions: ${result.summary.semanticTokenExtensions}`);
        console.log(`  style decisions: ${result.summary.evidenceBackedStyles} evidence-backed, ${result.summary.fallbackStyles} conservative fallbacks`);
        if (result.blockers.length) {
          console.log("  blockers:");
          result.blockers.forEach(item => console.log(`    - ${item}`));
        }
        if (result.warnings.length) {
          console.log("  warnings:");
          result.warnings.forEach(item => console.log(`    - ${item}`));
        }
        console.log("\nNext:");
        console.log(`  inspect ${result.report}`);
        console.log(`  npm run site -- migrate design-system materialize ${JSON.stringify(resolve(result.report, ".."))}`);
      }
      if (result.status === "blocked") process.exitCode = 1;
    } catch (error) {
      const code = error instanceof MigrateImplementationError ? error.code : "MIGRATE_IMPLEMENTATIONS_INFER_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateImplementationError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

const migrateDesignSystem = migrate.command("design-system").description("Stage reviewed migration contracts as a concrete Design System library");

migrateDesignSystem
  .command("materialize")
  .description("Assemble accepted foundation/contracts and, when available, inferred Astro implementations into a Design System staging directory")
  .argument("<analysis>", "migrate design output directory")
  .option("--root <path>", "base directory for analysis/output paths", ".")
  .option("--output <path>", "staging directory; defaults to <analysis>/design-system-staging")
  .option("--id <id>", "Design System id; defaults from the audited host")
  .option("--name <name>", "Design System name")
  .option("--version <version>", "Design System version", "0.1.0-migration")
  .option("--json", "print machine-readable JSON")
  .action(async (analysis: string, options: { root: string; output?: string; id?: string; name?: string; version: string; json?: boolean }) => {
    try {
      const result = await materializeDesignSystemStaging({
        analysis,
        root: resolve(options.root),
        output: options.output,
        id: options.id,
        name: options.name,
        version: options.version
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, designSystemMaterialization: result }, null, 2));
      } else {
        console.log(`Design System ${result.phase} ${result.status}.`);
        console.log(`  site: ${result.site}`);
        console.log(`  output: ${result.output}`);
        console.log(`  report: ${result.report}`);
        console.log(`  foundation: ${result.summary.primitiveTokens ?? "?"} primitive, ${result.summary.semanticTokens ?? "?"} semantic (${result.summary.provisionalTokens ?? 0} provisional)`);
        console.log(`  library: ${result.summary.uiContracts} UI, ${result.summary.sectionContracts} sections, ${result.summary.shellPacks} shell pack(s)`);
        console.log(`  implementation blockers: ${result.summary.implementationBlockers}; font blockers: ${result.summary.fontBlockers}`);
        if (result.blockers.length) {
          console.log("  blockers:");
          result.blockers.forEach(item => console.log(`    - ${item}`));
        }
        if (result.warnings.length) {
          console.log("  warnings:");
          result.warnings.forEach(item => console.log(`    - ${item}`));
        }
        console.log("\nNext:");
        console.log(`  inspect ${result.report}`);
        if (result.phase === "contract-staging") {
          console.log(`  npm run site -- migrate implementations infer ${JSON.stringify(resolve(result.report, ".."))}`);
          console.log("  then re-run design-system materialize to copy and lint the inferred Astro implementations");
        } else {
          console.log("  review the staged Astro implementations; local font binaries and unobserved interactive states remain fidelity follow-up");
        }
      }
      if (result.status === "blocked") process.exitCode = 1;
    } catch (error) {
      const code = error instanceof MigrateDesignSystemError ? error.code : "MIGRATE_DESIGN_SYSTEM_MATERIALIZE_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateDesignSystemError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

const migrateUi = migrate.command("ui").description("Review and propose leaf UI primitive contracts from direct audit evidence");

migrateUi
  .command("review")
  .description("Create an explicit accept/reject/pending review artifact from ui-families.json")
  .argument("<analysis>", "migrate design output directory or ui-families.json")
  .option("--root <path>", "base directory for analysis and output paths", ".")
  .option("--output <path>", "review JSON path; defaults beside ui-families.json")
  .option("--policy <policy>", "initial decisions: conservative, manual, or all", "conservative")
  .option("--force", "replace an existing review template")
  .option("--json", "print machine-readable JSON")
  .action(async (analysis: string, options: { root: string; output?: string; policy: string; force?: boolean; json?: boolean }) => {
    try {
      if (!( ["conservative", "manual", "all"] as string[]).includes(options.policy)) {
        throw new MigrateUiError("MIGRATE_UI_POLICY_INVALID", `Unknown review policy "${options.policy}".`, { allowed: ["conservative", "manual", "all"] });
      }
      const result = await createUiReview({
        analysis,
        root: resolve(options.root),
        output: options.output,
        policy: options.policy as UiReviewPolicy,
        force: options.force
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, uiReview: result }, null, 2));
      } else {
        console.log("Leaf UI review created.");
        console.log(`  site: ${result.site}`);
        console.log(`  policy: ${result.policy}`);
        console.log(`  output: ${result.output}`);
        console.log(`  families: ${result.summary.families.accept} accepted, ${result.summary.families.pending} pending, ${result.summary.families.reject} rejected`);
        console.log(`  variants: ${result.summary.variants.accept} accepted, ${result.summary.variants.pending} pending, ${result.summary.variants.reject} rejected`);
        console.log(`  auto-eligible: ${result.summary.autoEligible}; explicit-review boundaries: ${result.summary.reviewRequired}`);
        console.log("\nNext:");
        console.log(`  review ${result.output}`);
        console.log("  candidate surfaces and form-control role gaps stay pending under conservative policy; accepting them is an explicit architecture decision");
        console.log(`  npm run site -- migrate ui contracts ${JSON.stringify(result.output)}`);
      }
    } catch (error) {
      const code = error instanceof MigrateUiError ? error.code : "MIGRATE_UI_REVIEW_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateUiError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

migrateUi
  .command("contracts")
  .description("Generate reviewable SiteSpec ui.yaml proposals for accepted leaf UI families")
  .argument("<review>", "ui-review.json or its containing directory")
  .option("--root <path>", "base directory for review and output paths", ".")
  .option("--output <path>", "proposal directory; defaults to ui-contracts beside the review")
  .option("--json", "print machine-readable JSON")
  .action(async (review: string, options: { root: string; output?: string; json?: boolean }) => {
    try {
      const result = await materializeUiContracts({ review, root: resolve(options.root), output: options.output });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: result.status !== "blocked", uiContracts: result }, null, 2));
      } else {
        console.log(`UI contract proposal ${result.status}.`);
        console.log(`  site: ${result.site}`);
        console.log(`  output: ${result.output}`);
        console.log(`  report: ${result.report}`);
        console.log(`  ui contracts: ${result.summary.uiContracts}`);
        console.log(`  explicit-review accepted: ${result.summary.reviewRequiredAccepted}`);
        if (result.blockers.length) {
          console.log("  blockers:");
          for (const blocker of result.blockers) console.log(`    - ${blocker}`);
        }
        if (result.warnings.length) {
          console.log("  warnings:");
          for (const warning of result.warnings) console.log(`    - ${warning}`);
        }
        console.log("\nNext:");
        console.log(`  inspect ${result.report}`);
        console.log("  review generated ui.yaml proposals; Astro implementations and interactive-state styling are intentionally not generated yet");
      }
      if (result.status === "blocked") process.exitCode = 1;
    } catch (error) {
      const code = error instanceof MigrateUiError ? error.code : "MIGRATE_UI_CONTRACTS_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateUiError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

const migrateComponents = migrate.command("components").description("Review inferred shell/section component families without generating component source");

migrateComponents
  .command("review")
  .description("Create an explicit accept/reject/pending review artifact from component-families.json")
  .argument("<analysis>", "migrate design output directory or component-families.json")
  .option("--root <path>", "base directory for analysis and output paths", ".")
  .option("--output <path>", "review JSON path; defaults beside component-families.json")
  .option("--policy <policy>", "initial decisions: conservative, manual, or all", "conservative")
  .option("--force", "replace an existing review template")
  .option("--json", "print machine-readable JSON")
  .action(async (analysis: string, options: { root: string; output?: string; policy: string; force?: boolean; json?: boolean }) => {
    try {
      if (!(["conservative", "manual", "all"] as string[]).includes(options.policy)) {
        throw new MigrateComponentsError("MIGRATE_COMPONENTS_POLICY_INVALID", `Unknown review policy "${options.policy}".`, { allowed: ["conservative", "manual", "all"] });
      }
      const result = await createComponentReview({
        analysis,
        root: resolve(options.root),
        output: options.output,
        policy: options.policy as ComponentReviewPolicy,
        force: options.force
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, componentReview: result }, null, 2));
      } else {
        console.log("Component-family review created.");
        console.log(`  site: ${result.site}`);
        console.log(`  policy: ${result.policy}`);
        console.log(`  output: ${result.output}`);
        console.log(`  families: ${result.summary.families.accept} accepted, ${result.summary.families.pending} pending, ${result.summary.families.reject} rejected`);
        console.log(`  variants: ${result.summary.variants.accept} accepted, ${result.summary.variants.pending} pending, ${result.summary.variants.reject} rejected`);
        console.log(`  shell: ${result.summary.shell.accept} accepted, ${result.summary.shell.pending} pending`);
        console.log(`  sections: ${result.summary.section.accept} accepted, ${result.summary.section.pending} pending`);
        console.log("\nNext:");
        console.log(`  review ${result.output}`);
        console.log("  rename componentId/variants where needed; keep one-off local families pending until another page confirms reuse");
        console.log(`  npm run site -- migrate components contracts ${JSON.stringify(result.output)}`);
        if (result.summary.shell.accept > 0) console.log(`  npm run site -- migrate shell contracts ${JSON.stringify(result.output)}`);
        console.log(`  npm run site -- migrate ui review ${JSON.stringify(resolve(result.output, ".."))}`);
      }
    } catch (error) {
      const code = error instanceof MigrateComponentsError ? error.code : "MIGRATE_COMPONENTS_REVIEW_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateComponentsError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

migrateComponents
  .command("contracts")
  .description("Generate reviewable SiteSpec component.yaml proposals for accepted section families")
  .argument("<review>", "component-review.json or its containing directory")
  .option("--root <path>", "base directory for review and output paths", ".")
  .option("--output <path>", "proposal directory; defaults to component-contracts beside the review")
  .option("--json", "print machine-readable JSON")
  .action(async (review: string, options: { root: string; output?: string; json?: boolean }) => {
    try {
      const result = await materializeComponentContracts({ review, root: resolve(options.root), output: options.output });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: result.status !== "blocked", componentContracts: result }, null, 2));
      } else {
        console.log(`Component contract proposal ${result.status}.`);
        console.log(`  site: ${result.site}`);
        console.log(`  output: ${result.output}`);
        console.log(`  report: ${result.report}`);
        console.log(`  section contracts: ${result.summary.sectionContracts}`);
        console.log(`  shell deferred: ${result.summary.shellDeferred}`);
        if (result.blockers.length) {
          console.log("  blockers:");
          for (const blocker of result.blockers) console.log(`    - ${blocker}`);
        }
        if (result.warnings.length) {
          console.log("  warnings:");
          for (const warning of result.warnings) console.log(`    - ${warning}`);
        }
        console.log("\nNext:");
        console.log(`  inspect ${result.report}`);
        console.log("  review generated component.yaml proposals; implementations are intentionally not generated yet");
        if (result.summary.shellDeferred > 0) console.log(`  npm run site -- migrate shell contracts ${JSON.stringify(result.review)}`);
      }
      if (result.status === "blocked") process.exitCode = 1;
    } catch (error) {
      const code = error instanceof MigrateComponentsError ? error.code : "MIGRATE_COMPONENTS_CONTRACTS_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateComponentsError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });


const migrateFoundation = migrate.command("foundation").description("Review and materialize an inferred Design System foundation without mutating migration evidence");

migrateFoundation
  .command("review")
  .description("Create an explicit accept/reject/pending review artifact from foundation-proposal.json")
  .argument("<analysis>", "migrate design output directory or foundation-proposal.json")
  .option("--root <path>", "base directory for analysis and output paths", ".")
  .option("--output <path>", "review JSON path; defaults beside foundation-proposal.json")
  .option("--policy <policy>", "initial decisions: conservative, manual, or all", "conservative")
  .option("--force", "replace an existing review template")
  .option("--json", "print machine-readable JSON")
  .action(async (analysis: string, options: { root: string; output?: string; policy: string; force?: boolean; json?: boolean }) => {
    try {
      if (!(["conservative", "manual", "all"] as string[]).includes(options.policy)) {
        throw new MigrateFoundationError("MIGRATE_FOUNDATION_POLICY_INVALID", `Unknown review policy "${options.policy}".`, { allowed: ["conservative", "manual", "all"] });
      }
      const result = await createFoundationReview({
        analysis,
        root: resolve(options.root),
        output: options.output,
        policy: options.policy as FoundationReviewPolicy,
        force: options.force
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: true, foundationReview: result }, null, 2));
      } else {
        console.log("Foundation review created.");
        console.log(`  site: ${result.site}`);
        console.log(`  policy: ${result.policy}`);
        console.log(`  output: ${result.output}`);
        console.log(`  primitive: ${result.summary.primitive.accept} accepted, ${result.summary.primitive.pending} pending, ${result.summary.primitive.reject} rejected`);
        console.log(`  semantic: ${result.summary.semantic.accept} accepted, ${result.summary.semantic.pending} pending, ${result.summary.semantic.reject} rejected`);
        console.log(`  typography: ${result.summary.typography.accept} accepted, ${result.summary.typography.pending} pending, ${result.summary.typography.reject} rejected`);
        console.log(`  blocking layout decisions: ${result.summary.blocking.length ? result.summary.blocking.join(", ") : "none"}`);
        console.log(`  provisional layout decisions: ${result.summary.provisional.length ? result.summary.provisional.join(", ") : "none"}`);
        console.log("\nNext:");
        console.log(`  review ${result.output}`);
        console.log("  accept/reject supporting tokens; unresolved required layout values may remain explicitly provisional when backed by the current target Design System");
        console.log(`  npm run site -- migrate foundation materialize ${JSON.stringify(result.output)}`);
      }
    } catch (error) {
      const code = error instanceof MigrateFoundationError ? error.code : "MIGRATE_FOUNDATION_REVIEW_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateFoundationError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else console.error(`ERROR ${code}\n  ${message}`);
      process.exitCode = 2;
    }
  });

migrateFoundation
  .command("materialize")
  .description("Materialize accepted decisions plus explicit provisional compatibility fallbacks into token JSON; optionally apply it to a SiteSpec project")
  .argument("<review>", "foundation-review.json or its containing directory")
  .option("--root <path>", "base/target SiteSpec project root", ".")
  .option("--output <path>", "generated token preview; defaults to foundation-tokens.json beside the review")
  .option("--apply", "write the ready preview to the target Design System token source")
  .option("--replace", "allow --apply to replace an existing canonical token source")
  .option("--json", "print machine-readable JSON")
  .action(async (review: string, options: { root: string; output?: string; apply?: boolean; replace?: boolean; json?: boolean }) => {
    try {
      const result = await materializeFoundationReview({ review, root: resolve(options.root), output: options.output, apply: options.apply, replace: options.replace });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.5", success: result.status === "ready", foundation: result }, null, 2));
      } else {
        console.log(`Foundation token materialization ${result.status}${result.status === "ready" && result.quality === "provisional" ? " (provisional)" : ""}.`);
        console.log(`  preview: ${result.output}`);
        console.log(`  primitive: ${result.summary.primitive} (${result.summary.synthesizedPrimitive} synthesized)`);
        console.log(`  semantic: ${result.summary.semantic}`);
        console.log(`  typography roles: ${result.summary.typographyRoles}`);
        if (result.summary.provisionalTokens) console.log(`  provisional tokens: ${result.summary.provisionalTokens} (${result.summary.carriedSemanticTokens} carried semantic)`);
        if (result.applied) console.log(`  applied: ${result.applied}`);
        if (result.blockers.length) {
          console.log("  blockers:");
          for (const blocker of result.blockers) console.log(`    - ${blocker}`);
        }
        if (result.warnings.length) {
          console.log("  warnings:");
          for (const warning of result.warnings) console.log(`    - ${warning}`);
        }
        if (result.status === "blocked" && result.hints.length) {
          console.log("\nNext:");
          for (const hint of result.hints) console.log(`  - ${hint}`);
        }
        if (result.status === "ready" && !result.applied) {
          console.log("\nNext:");
          console.log("  inspect the preview, then rerun with --apply --replace when the target Design System is ready");
        }
      }
      if (result.status === "blocked") process.exitCode = 1;
    } catch (error) {
      const code = error instanceof MigrateFoundationError ? error.code : "MIGRATE_FOUNDATION_MATERIALIZE_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof MigrateFoundationError ? error.details : undefined;
      if (options.json) console.log(JSON.stringify({ version: "0.5", success: false, error: { code, message, details } }, null, 2));
      else {
        console.error(`ERROR ${code}\n  ${message}`);
        const blockers = details?.blockers;
        if (Array.isArray(blockers)) for (const blocker of blockers) console.error(`  blocker: ${String(blocker)}`);
        if (details?.preview) console.error(`  preview: ${String(details.preview)}`);
      }
      process.exitCode = 2;
    }
  });

program
  .command("validate")
  .description("Validate a Site Spec project")
  .option("--json", "print machine-readable JSON")
  .option("--root <path>", "project root", ".")
  .action(async (options: { json?: boolean; root: string }) => {
    const root = resolve(options.root);
    const project = await loadProject(root);
    const result = await validateLoadedProject(project);
    const rendererDiagnostics = await validateAstroComponentContracts({ root, registry: project.registry, uiRegistry: project.uiRegistry });
    const diagnostics = [...result.diagnostics, ...rendererDiagnostics];
    const valid = result.valid && !rendererDiagnostics.some(diagnostic => diagnostic.severity === "error");
    if (options.json) {
      const summary = {
        errors: diagnostics.filter(d => d.severity === "error").length,
        warnings: diagnostics.filter(d => d.severity === "warning").length,
        info: diagnostics.filter(d => d.severity === "info").length
      };
      console.log(JSON.stringify({ version: "0.2", valid, summary, diagnostics }, null, 2));
    } else if (diagnostics.length > 0) {
      printDiagnostics(diagnostics);
    } else {
      console.log("OK  Site Spec and Astro source contracts are valid.");
    }
    process.exitCode = valid ? 0 : 1;
  });

program
  .command("spec")
  .description("Inspect the site, content, Design System, design, composition, a page, component, UI primitive, or navigation collection")
  .argument("[query]", "page id/route, content, collection:<id>, entry:<collection>/<id>, component id, ui:<id>, section:<id>, navigation:<id>, shell, assets, design-system, design, or fonts")
  .option("--json", "print machine-readable JSON")
  .option("--root <path>", "project root", ".")
  .action(async (query: string | undefined, options: { json?: boolean; root: string }) => {
    const result = await inspectProject(resolve(options.root), query);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.type === "page") {
      const page = result.page as {
        id: string; route: string; archetype: string; state: string; dynamic?: boolean;
        generatedRoutes?: Array<{ route: string }>;
        sections: Array<{ id: string; use?: string; variant?: string; theme?: string; ref?: string }>;
      };
      console.log(`${page.id}  ${page.route}  ${page.archetype}  ${page.state}${page.dynamic ? "  dynamic" : ""}\n`);
      for (const section of page.sections) {
        console.log(section.ref
          ? `${section.id.padEnd(16)} ${section.ref}`
          : `${section.id.padEnd(16)} ${section.use}:${section.variant} theme=${section.theme}`);
      }
      if (page.generatedRoutes && page.generatedRoutes.length > 1) {
        console.log("\nGenerated routes");
        for (const item of page.generatedRoutes) console.log(`  ${item.route}`);
      }
      return;
    }
    if (result.type === "content-index") {
      const collections = result.collections as Array<{ id: string; counts: { total: number; published: number; draft: number } }>;
      console.log(`Content collections  ${collections.length}\n`);
      for (const collection of collections) {
        console.log(`${collection.id.padEnd(20)} ${String(collection.counts.total).padStart(4)} entries  ${collection.counts.published} published  ${collection.counts.draft} draft`);
      }
      return;
    }
    if (result.type === "content-collection") {
      const collection = result.collection as {
        id: string; source: string; counts: { total: number; published: number; draft: number };
        relations: Record<string, { collection: string; many?: boolean }>;
        entries: Array<{ id: string; status: string; href?: string; format: string }>;
      };
      console.log(`${collection.id}\nsource: ${collection.source}\nentries: ${collection.counts.total}\npublished: ${collection.counts.published}\ndraft: ${collection.counts.draft}`);
      const relations = Object.entries(collection.relations);
      if (relations.length > 0) {
        console.log("\nRelations");
        for (const [field, relation] of relations) console.log(`${field.padEnd(20)} -> ${relation.collection}${relation.many ? "[]" : ""}`);
      }
      if (collection.entries.length > 0) {
        console.log("\nEntries");
        for (const entry of collection.entries) console.log(`${entry.id.padEnd(24)} ${entry.status.padEnd(10)} ${entry.format.padEnd(8)} ${entry.href ?? ""}`);
      }
      return;
    }
    if (result.type === "content-entry") {
      const entry = result.entry as Record<string, unknown> & { collection: string; id: string; status: string; source: string; href?: string };
      console.log(`${entry.collection}/${entry.id}\nsource: ${entry.source}\nstatus: ${entry.status}${entry.href ? `\nroute: ${entry.href}` : ""}`);
      return;
    }
    if (result.type === "component") {
      const component = result.component as { id: string; role: string; variants: string[]; themes: string[] };
      console.log(`${component.id}\nrole: ${component.role}\nvariants: ${component.variants.join(", ")}\nthemes: ${component.themes.join(", ")}`);
      return;
    }
    if (result.type === "ui") {
      const primitive = result.ui as { id: string; role: string; variants: string[]; files: { contract: string; implementation: string } };
      console.log(`${primitive.id}\nrole: ${primitive.role}\nvariants: ${primitive.variants.join(", ")}\ncontract: ${primitive.files.contract}\nimplementation: ${primitive.files.implementation}`);
      return;
    }
    if (result.type === "section-preset") {
      const preset = result.sectionPreset as { reference: string; source: string; section: { use: string; variant?: string; theme?: string } };
      console.log(`${preset.reference}\nsource: ${preset.source}\nuse: ${preset.section.use}\nvariant: ${preset.section.variant ?? "default"}\ntheme: ${preset.section.theme ?? "default"}`);
      return;
    }
    if (result.type === "navigation") {
      const navigation = result.navigation as { id: string; reference: string; source: string; items: Array<{ id: string; label: string; href: string }> };
      console.log(`${navigation.reference}\nsource: ${navigation.source}\n`);
      for (const item of navigation.items) console.log(`${item.id.padEnd(16)} ${item.label.padEnd(24)} ${item.href}`);
      return;
    }
    if (result.type === "shell") {
      const shell = result.shell as { layout: string; exists: boolean; conventionalFiles: { header: { path: string; exists: boolean }; footer: { path: string; exists: boolean } }; receives: string[] };
      console.log(`Site Shell\nlayout: ${shell.layout} (${shell.exists ? "present" : "missing"})\nheader: ${shell.conventionalFiles.header.path} (${shell.conventionalFiles.header.exists ? "present" : "missing"})\nfooter: ${shell.conventionalFiles.footer.path} (${shell.conventionalFiles.footer.exists ? "present" : "missing"})\nreceives: ${shell.receives.join(", ")}`);
      return;
    }
    if (result.type === "assets") {
      const assets = result.assets as {
        publicDirectory: string;
        values?: { favicon?: string; appleTouchIcon?: string; defaultOgImage?: string };
      };
      console.log(`Site assets\npublic: ${assets.publicDirectory}`);
      console.log(`favicon: ${assets.values?.favicon ?? "missing"}`);
      console.log(`appleTouchIcon: ${assets.values?.appleTouchIcon ?? "not set"}`);
      console.log(`defaultOgImage: ${assets.values?.defaultOgImage ?? "not set"}`);
      return;
    }

    if (result.type === "design") {
      const design = result.design as {
        source: string;
        categories: Record<string, string[]>;
        primitive: Array<{ name: string; value: string | number }>;
        semantic: Array<{ name: string; cssVariable: string; alias?: string }>;
      };
      console.log(`Design system
source: ${design.source}`);
      console.log(`primitive: ${design.primitive.length}`);
      console.log(`semantic: ${design.semantic.length}
`);
      for (const [category, tokens] of Object.entries(design.categories)) {
        console.log(category);
        for (const token of tokens) {
          const item = design.semantic.find(candidate => candidate.name === token);
          console.log(`  ${token.padEnd(32)} ${item?.cssVariable ?? ""}${item?.alias ? ` -> ${item.alias}` : ""}`);
        }
      }
      return;
    }
    if (result.type === "design-system") {
      const ds = result.designSystem as { id?: string; name?: string; version?: string; themes?: { default?: string }; shells?: { default?: string } } | undefined;
      console.log(ds ? `${ds.name ?? ds.id} (${ds.id}) v${ds.version}\ndefault theme: ${ds.themes?.default ?? "default"}\ndefault shell: ${ds.shells?.default ?? "default"}` : "No Design System contract installed.");
      return;
    }

    const site = result.site as { name?: string; url?: string } | undefined;
    const pages = result.pages as Array<{ route: string; id: string; archetype: string }>;
    const components = result.components as Array<{ id: string; variants: string[] }>;
    const content = (result.content ?? []) as Array<{ id: string; counts: { total: number } }>;
    const ui = (result.ui ?? []) as Array<{ id: string; role: string }>;
    const presets = (result.sectionPresets ?? []) as Array<{ id: string }>;
    const navigation = result.navigation as Array<{ id: string; items: unknown[] }>;
    console.log(`${site?.name ?? "Invalid site"}${site?.url ? `\n${site.url}` : ""}\n`);
    console.log(`Pages       ${pages.length}`);
    console.log(`Components  ${components.length}`);
    console.log(`UI          ${ui.length}`);
    console.log(`Presets     ${presets.length}`);
    console.log(`Collections ${content.length}`);
    console.log(`Navigation  ${navigation.length}\n`);
    console.log("Pages");
    for (const page of pages) console.log(`${page.route.padEnd(18)} ${page.id.padEnd(16)} ${page.archetype}`);
    console.log("\nComponents");
    for (const component of components) console.log(`${component.id.padEnd(20)} ${component.variants.join(", ")}`);
    if (content.length > 0) {
      console.log("\nContent");
      for (const collection of content) console.log(`${collection.id.padEnd(20)} ${collection.counts.total} entry(s)`);
    }
    if (navigation.length > 0) {
      console.log("\nNavigation");
      for (const collection of navigation) console.log(`${collection.id.padEnd(20)} ${collection.items.length} item(s)`);
    }
  });

program
  .command("dev")
  .description("Run the source-oriented development server with live Site Spec validation")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", (value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`Invalid port: ${value}`);
    return parsed;
  }, 4321)
  .option("--json", "print newline-delimited machine-readable events")
  .option("--root <path>", "project root", ".")
  .action(async (options: { host: string; port: number; json?: boolean; root: string }) => {
    const printEvent = (event: DevEvent): void => {
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", ...event }));
        return;
      }
      if (event.event === "ready") {
        console.log(`Development server at ${event.url}`);
        console.log(`  root: ${resolve(options.root)}`);
        console.log(`  state: ${event.valid ? "valid" : "invalid"}`);
        console.log("  watching Site Spec, content, section presets, components, UI primitives, Site Shell, design tokens, and public assets");
        console.log("  press Ctrl+C to stop");
        if (!event.valid) printDiagnostics(event.diagnostics);
        return;
      }
      if (event.event === "updated") {
        console.log("OK  Site Spec updated.");
        return;
      }
      console.log(event.event === "invalid" ? "Site Spec is temporarily invalid; dev server is still running." : "Development refresh failed; dev server is still running.");
      printDiagnostics(event.diagnostics);
    };

    try {
      const dev = await startDev({
        root: resolve(options.root),
        host: options.host,
        port: options.port,
        rendererLogLevel: options.json ? "silent" : "warn",
        onEvent: printEvent
      });

      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await dev.close();
      };
      process.once("SIGINT", () => { void close(); });
      process.once("SIGTERM", () => { void close(); });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", event: "error", valid: false, diagnostics: [{ code: "DEV_START_FAILED", severity: "error", message }] }));
      } else {
        console.error(`ERROR DEV_START_FAILED\n  ${message}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command("preview")
  .description("Serve the existing production build from dist without rebuilding")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <port>", "port to bind", (value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`Invalid port: ${value}`);
    return parsed;
  }, 4321)
  .option("--json", "print machine-readable JSON")
  .option("--root <path>", "project root", ".")
  .action(async (options: { host: string; port: number; json?: boolean; root: string }) => {
    try {
      const preview = await startPreview({
        root: resolve(options.root),
        host: options.host,
        port: options.port
      });
      if (options.json) {
        console.log(JSON.stringify({
          version: "0.2",
          success: true,
          url: preview.url,
          host: preview.host,
          port: preview.port,
          outDir: preview.outDir
        }, null, 2));
      } else {
        console.log(`Previewing production build at ${preview.url}`);
        console.log(`  root: ${preview.root}`);
        console.log(`  dist: ${preview.outDir}`);
        console.log("  press Ctrl+C to stop");
      }

      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await preview.close();
      };
      process.once("SIGINT", () => { void close(); });
      process.once("SIGTERM", () => { void close(); });
    } catch (error) {
      const code = error instanceof PreviewError ? error.code : "PREVIEW_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", success: false, error: { code, message } }, null, 2));
      } else {
        console.error(`ERROR ${code}\n  ${message}`);
      }
      process.exitCode = 1;
    }
  });

const deploy = program.command("deploy").description("Configure a production deployment provider");

deploy
  .command("github-pages")
  .description("Build locally and configure GitHub Actions deployment to GitHub Pages")
  .option("--branch <branch>", "branch that deploys to GitHub Pages")
  .option("--remote <name>", "Git remote to inspect", "origin")
  .option("--json", "print machine-readable JSON")
  .option("--root <path>", "project root", ".")
  .action(async (options: { branch?: string; remote: string; json?: boolean; root: string }) => {
    try {
      const result = await deployGitHubPages({
        root: resolve(options.root),
        remote: options.remote,
        branch: options.branch
      });
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", ...result }, null, 2));
      } else {
        console.log(`GitHub Pages deployment configured for ${result.repository}`);
        console.log(`  branch: ${result.branch}`);
        console.log(`  site: ${result.siteUrl}`);
        console.log(`  workflow: ${result.workflowFile}${result.workflowChanged ? " (updated)" : " (unchanged)"}`);
        console.log(`  preflight: ${result.pages.length} page(s), ${result.artifactBytes} bytes`);
        if (result.customDomain) console.log("  domain: custom domain detected");
        console.log("\nNext:");
        for (const note of result.notes) console.log(`  - ${note}`);
      }
    } catch (error) {
      const code = error instanceof GitHubPagesDeployError ? error.code : "GITHUB_PAGES_DEPLOY_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof GitHubPagesDeployError ? error.details : undefined;
      if (options.json) {
        console.log(JSON.stringify({ version: "0.2", success: false, error: { code, message, details } }, null, 2));
      } else {
        console.error(`ERROR ${code}\n  ${message}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command("build")
  .description("Validate and build a static site with the Astro renderer")
  .option("--json", "print machine-readable JSON")
  .option("--root <path>", "project root", ".")
  .action(async (options: { json?: boolean; root: string }) => {
    const root = resolve(options.root);
    const result = await buildProject(root);
    if (options.json) {
      console.log(JSON.stringify({
        version: "0.2",
        success: result.success,
        outDir: result.outDir,
        pages: result.pages,
        diagnostics: result.diagnostics
      }, null, 2));
    } else {
      if (result.diagnostics.length > 0) printDiagnostics(result.diagnostics);
      if (result.success) {
        console.log(`Built ${result.pages.length} page(s) -> ${result.outDir}`);
      }
    }
    process.exitCode = result.success ? 0 : 1;
  });

program.parseAsync(process.argv).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 3;
});

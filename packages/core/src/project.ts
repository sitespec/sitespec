import { join, relative } from "node:path";
import { validatePageSchema, validateSiteSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { fileExists, listFiles, parseDataFile } from "./fs.js";
import { buildRegistry } from "./registry.js";
import { buildUiRegistry } from "./ui-registry.js";
import { loadSectionPresets } from "./section-presets.js";
import { loadContentCollections, validateContentRelations } from "./content.js";
import type { Diagnostic, LoadedPage, LoadedProject, SourcePage, SourceSite } from "./types.js";

export async function loadProject(root: string): Promise<LoadedProject> {
  const diagnostics: Diagnostic[] = [];
  const sitePath = join(root, "site.yaml");
  let site: SourceSite | undefined;

  if (!(await fileExists(sitePath))) {
    diagnostics.push({
      code: "SITE_FILE_MISSING", severity: "error", file: "site.yaml",
      message: "site.yaml was not found."
    });
  } else {
    const parsed = await parseDataFile<SourceSite>(root, sitePath);
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
    } else {
      const value = parsed.value;
      if (value === undefined || !validateSiteSchema(value)) {
        diagnostics.push(...schemaDiagnostics("SITE_SCHEMA_INVALID", "site.yaml", validateSiteSchema.errors));
      } else {
        site = value;
        if (value.site.url.endsWith("/")) diagnostics.push({
          code: "SITE_URL_TRAILING_SLASH", severity: "error", file: "site.yaml", path: "/site/url",
          message: "site.url must not end with a trailing slash."
        });
        if (value.seo?.titleTemplate) {
          const matches = value.seo.titleTemplate.match(/%s/g)?.length ?? 0;
          if (matches !== 1) diagnostics.push({
            code: "SITE_TITLE_TEMPLATE_INVALID", severity: "error", file: "site.yaml", path: "/seo/titleTemplate",
            message: "seo.titleTemplate must contain exactly one %s placeholder."
          });
        }
      }
    }
  }

  const built = await buildRegistry(root);
  diagnostics.push(...built.diagnostics);

  const builtUi = await buildUiRegistry(root);
  diagnostics.push(...builtUi.diagnostics);

  const loadedPresets = await loadSectionPresets(root);
  diagnostics.push(...loadedPresets.diagnostics);

  const loadedContent = await loadContentCollections(root);
  diagnostics.push(...loadedContent.diagnostics);
  diagnostics.push(...validateContentRelations(loadedContent.collections));

  const pages: LoadedPage[] = [];
  for (const file of await listFiles(join(root, "pages"), [".yaml", ".yml"])) {
    const parsed = await parseDataFile<SourcePage>(root, file);
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }

    const relFile = relative(root, file).replaceAll("\\", "/");
    const value = parsed.value;
    if (value === undefined || !validatePageSchema(value)) {
      diagnostics.push(...schemaDiagnostics("PAGE_SCHEMA_INVALID", relFile, validatePageSchema.errors));
      continue;
    }
    pages.push({ file: relFile, value });
  }

  return {
    root,
    site,
    siteFile: "site.yaml",
    pages,
    components: built.components,
    registry: built.registry,
    ui: builtUi.ui,
    uiRegistry: builtUi.registry,
    sectionPresets: loadedPresets.presets,
    contentCollections: loadedContent.collections,
    contentRegistry: loadedContent.registry,
    diagnostics
  };
}

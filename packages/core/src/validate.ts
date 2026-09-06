import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ContentEntry, Diagnostic, LoadedProject, ResolvedNavigation, ResolvedPage, ResolvedSite,
  SourceNavigation, ValidationResult
} from "./types.js";
import { hasErrors, nearestStrings } from "./diagnostics.js";
import { loadProject } from "./project.js";
import { resolvePage } from "./resolver.js";
import { inspectDesign, validateDesign } from "./design.js";
import { fileExists } from "./fs.js";
import { isDynamicRoute, materializeRoute, resolvedPageId, routeParamNames } from "./routes.js";
import { contentEntryRecord, runContentQuery, validatePaginationRoute } from "./content-query.js";

interface AssetRule {
  label: string;
  value?: string;
  path: string;
  required?: boolean;
  extensions: string[];
}

function publicAssetPathIsSafe(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%") || value.includes("\0")) return false;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 && !parts.some(part => part === "." || part === "..");
}

async function validateAssetRule(project: LoadedProject, rule: AssetRule, diagnostics: Diagnostic[]): Promise<void> {
  if (!rule.value) {
    if (rule.required) diagnostics.push({
      code: "ASSET_REQUIRED",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: `${rule.label} is required in SiteSpec.`,
      expected: `public asset path (${rule.extensions.join(", ")})`,
      actual: undefined,
      suggestions: [{
        action: "add-asset",
        field: rule.path,
        message: `Add the asset under public/ and reference it from ${rule.path}.`
      }]
    });
    return;
  }

  if (!publicAssetPathIsSafe(rule.value)) {
    diagnostics.push({
      code: "ASSET_PATH_INVALID",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: `${rule.label} must be a safe root-relative path inside public/.`,
      expected: "/path/to/file.ext without query, fragment, backslashes, or dot segments",
      actual: rule.value
    });
    return;
  }

  const extension = extname(rule.value).toLowerCase();
  if (!rule.extensions.includes(extension)) {
    diagnostics.push({
      code: "ASSET_FORMAT_UNSUPPORTED",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: `${rule.label} uses unsupported format "${extension || "(none)"}".`,
      expected: rule.extensions,
      actual: extension || undefined,
      allowed: rule.extensions,
      suggestions: [{
        action: "use-supported-asset-format",
        field: rule.path,
        candidates: rule.extensions
      }]
    });
  }

  const publicRoot = resolve(project.root, "public");
  const file = join(publicRoot, rule.value.slice(1));
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      diagnostics.push({
        code: "ASSET_SYMLINK_FORBIDDEN",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} must be a regular file, not a symbolic link.`,
        actual: rule.value
      });
      return;
    }
    if (!info.isFile()) {
      diagnostics.push({
        code: "ASSET_NOT_FILE",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} does not point to a regular file.`,
        actual: rule.value
      });
      return;
    }

    const [realPublicRoot, realFile] = await Promise.all([realpath(publicRoot), realpath(file)]);
    const rel = relative(realPublicRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      diagnostics.push({
        code: "ASSET_OUTSIDE_PUBLIC",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} resolves outside public/.`,
        actual: rule.value
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      diagnostics.push({
        code: "ASSET_NOT_FOUND",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} was not found at public${rule.value}.`,
        expected: `existing file public${rule.value}`,
        actual: rule.value,
        suggestions: [{
          action: "create-asset",
          file: `public${rule.value}`,
          message: `Create public${rule.value} or update ${rule.path}.`
        }]
      });
      return;
    }
    diagnostics.push({
      code: "ASSET_READ_FAILED",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: error instanceof Error ? error.message : String(error),
      actual: rule.value
    });
  }
}

async function validateSiteAssets(project: LoadedProject, diagnostics: Diagnostic[]): Promise<void> {
  if (!project.site) return;
  const rules: AssetRule[] = [
    {
      label: "assets.favicon",
      value: project.site.assets.favicon,
      path: "/assets/favicon",
      required: true,
      extensions: [".ico", ".png", ".svg"]
    },
    {
      label: "assets.appleTouchIcon",
      value: project.site.assets.appleTouchIcon,
      path: "/assets/appleTouchIcon",
      extensions: [".png"]
    },
    {
      label: "assets.defaultOgImage",
      value: project.site.assets.defaultOgImage,
      path: "/assets/defaultOgImage",
      extensions: [".jpg", ".jpeg", ".png", ".webp"]
    },
    {
      label: "brand.logo",
      value: project.site.brand?.logo,
      path: "/brand/logo",
      extensions: [".svg", ".png", ".jpg", ".jpeg", ".webp"]
    },
    {
      label: "brand.logoDark",
      value: project.site.brand?.logoDark,
      path: "/brand/logoDark",
      extensions: [".svg", ".png", ".jpg", ".jpeg", ".webp"]
    }
  ];

  for (const rule of rules) await validateAssetRule(project, rule, diagnostics);
}

function collectHrefs(value: unknown, out: string[]): void {
  if (Array.isArray(value)) { value.forEach(v => collectHrefs(v, out)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.href === "string") out.push(record.href);
  Object.values(record).forEach(v => collectHrefs(v, out));
}

function internalRoute(href: string): string | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined;
  return href.split(/[?#]/, 1)[0] || "/";
}

function isSupportedExternalHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(href);
}

function validateGlobalIdentities(project: LoadedProject, diagnostics: Diagnostic[]): void {
  const ids = new Map<string, string>();
  const routes = new Map<string, string>();
  for (const page of project.pages) {
    const id = page.value.page.id;
    const route = page.value.page.route;
    if (ids.has(id)) diagnostics.push({
      code: "PAGE_ID_DUPLICATE", severity: "error", file: page.file, page: id,
      message: `Duplicate page id "${id}"; first declared in ${ids.get(id)}.`
    }); else ids.set(id, page.file);
    if (routes.has(route)) diagnostics.push({
      code: "PAGE_ROUTE_DUPLICATE", severity: "error", file: page.file, page: id,
      message: `Duplicate route template "${route}"; first declared in ${routes.get(route)}.`
    }); else routes.set(route, page.file);
  }
}

function containsPostV01CoreType(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPostV01CoreType);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && /^urn:site-spec:0\.[234]:/.test(record.$ref)) return true;
  return Object.values(record).some(containsPostV01CoreType);
}

function containsReferencePrefix(value: unknown, prefix: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsReferencePrefix(item, prefix));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && record.$ref.startsWith(prefix)) return true;
  return Object.values(record).some(item => containsReferencePrefix(item, prefix));
}

function validateSpecVersions(project: LoadedProject, diagnostics: Diagnostic[]): void {
  if (!project.site) return;
  const version = project.site.specVersion;
  for (const page of project.pages) {
    if (page.value.specVersion !== version) diagnostics.push({
      code: "SPEC_VERSION_MISMATCH", severity: "error", file: page.file,
      message: `Page uses Site Spec ${page.value.specVersion}, but site.yaml uses ${version}.`,
      expected: version, actual: page.value.specVersion
    });
  }
  for (const component of project.components) {
    if (component.value.specVersion !== version) diagnostics.push({
      code: "SPEC_VERSION_MISMATCH", severity: "error", file: component.file,
      message: `Component uses Site Spec ${component.value.specVersion}, but site.yaml uses ${version}.`,
      expected: version, actual: component.value.specVersion
    });
  }
  for (const primitive of project.ui) {
    if (primitive.value.specVersion !== version && version !== "0.1") diagnostics.push({
      code: "SPEC_VERSION_MISMATCH", severity: "error", file: primitive.file,
      message: `UI primitive uses Site Spec ${primitive.value.specVersion}, but site.yaml uses ${version}.`,
      expected: version, actual: primitive.value.specVersion
    });
  }
  for (const preset of project.sectionPresets) {
    if (preset.value.specVersion !== version && version !== "0.1") diagnostics.push({
      code: "SPEC_VERSION_MISMATCH", severity: "error", file: preset.file,
      message: `Section preset uses Site Spec ${preset.value.specVersion}, but site.yaml uses ${version}.`,
      expected: version, actual: preset.value.specVersion
    });
  }
  for (const collection of project.contentCollections) {
    if (version === "0.1" || version === "0.2") diagnostics.push({
      code: "V03_FEATURE_REQUIRES_SPEC_VERSION", severity: "error", file: collection.file,
      message: `Typed content collections require specVersion "0.3" or newer.`,
      expected: ["0.3", "0.4"], actual: version,
      suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.3" }]
    });
  }
  if (version === "0.1" || version === "0.2") {
    for (const page of project.pages) if (page.value.content) diagnostics.push({
      code: "V03_FEATURE_REQUIRES_SPEC_VERSION", severity: "error", file: page.file, page: page.value.page.id,
      path: "/content", message: `Content-driven pages and queries require specVersion "0.3" or newer.`,
      expected: ["0.3", "0.4"], actual: version,
      suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.3" }]
    });
  }
  if (version === "0.1") {
    for (const page of project.pages) {
      if (page.value.sections.some(section => "$ref" in section)) diagnostics.push({
        code: "V02_FEATURE_REQUIRES_SPEC_VERSION", severity: "error", file: page.file, page: page.value.page.id,
        path: "/sections", message: 'Reusable section:<id> presets require specVersion "0.2".',
        expected: "0.2", actual: version, suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.2" }]
      });
      if (page.value.sections.some(section => "use" in section && containsReferencePrefix(section.props, "param:"))) diagnostics.push({
        code: "V02_FEATURE_REQUIRES_SPEC_VERSION", severity: "error", file: page.file, page: page.value.page.id,
        path: "/sections", message: 'Route parameter references (param:<name>) require specVersion "0.2".',
        expected: "0.2", actual: version, suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.2" }]
      });
    }
    for (const component of project.components) {
      if (containsPostV01CoreType(component.value.props)) diagnostics.push({
        code: "V02_FEATURE_REQUIRES_SPEC_VERSION", severity: "error", file: component.file, component: component.value.component.id,
        path: "/props", message: 'SiteSpec 0.2+ core prop types require specVersion "0.2" or newer.',
        expected: ["0.2", "0.3", "0.4"], actual: version, suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.2" }]
      });
    }
  }

  if (version === "0.1" && (project.ui.length > 0 || project.sectionPresets.length > 0)) diagnostics.push({
    code: "V02_FEATURE_REQUIRES_SPEC_VERSION",
    severity: "error",
    file: "site.yaml",
    path: "/specVersion",
    message: "ui/ primitives and reusable section presets require specVersion \"0.2\".",
    expected: "0.2",
    actual: version,
    suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.2" }]
  });
}

async function validateDesignSystemProject(project: LoadedProject, diagnostics: Diagnostic[]): Promise<void> {
  if (!project.site) return;
  const contract = project.designSystem?.value;
  if (project.site.specVersion === "0.4" && !contract) {
    diagnostics.push({
      code: "DESIGN_SYSTEM_CONTRACT_MISSING",
      severity: "error",
      file: "design-system.yaml",
      message: "SiteSpec 0.4 projects require design-system.yaml.",
      expected: "formal Design System contract",
      suggestions: [{ action: "install-design-system", command: "npm run site -- design-system install <pack> --replace" }]
    });
    return;
  }
  if (project.site.specVersion !== "0.4" && (contract || project.site.designSystem)) {
    diagnostics.push({
      code: "V04_FEATURE_REQUIRES_SPEC_VERSION",
      severity: "error",
      file: contract ? "design-system.yaml" : "site.yaml",
      message: "Design System contracts and site-level Design System selection require specVersion \"0.4\".",
      expected: "0.4",
      actual: project.site.specVersion,
      suggestions: [{ action: "upgrade-spec-version", field: "specVersion", value: "0.4" }]
    });
    return;
  }
  if (!contract) return;

  const selectedTheme = project.site.designSystem?.theme ?? contract.themes.default;
  if (!(selectedTheme in contract.themes.items)) diagnostics.push({
    code: "DESIGN_SYSTEM_THEME_UNKNOWN",
    severity: "error",
    file: "site.yaml",
    path: "/designSystem/theme",
    message: `Selected Design System theme "${selectedTheme}" is not available.`,
    actual: selectedTheme,
    allowed: Object.keys(contract.themes.items).sort()
  });

  const selectedShell = project.site.designSystem?.shell ?? contract.shells.default;
  if (!(selectedShell in contract.shells.items)) diagnostics.push({
    code: "DESIGN_SYSTEM_SHELL_UNKNOWN",
    severity: "error",
    file: "site.yaml",
    path: "/designSystem/shell",
    message: `Selected shell pack "${selectedShell}" is not available.`,
    actual: selectedShell,
    allowed: Object.keys(contract.shells.items).sort()
  });

  for (const id of contract.libraries.ui) if (!project.uiRegistry.has(id)) diagnostics.push({
    code: "DESIGN_SYSTEM_UI_EXPORT_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: "/libraries/ui",
    message: `Design System exports unknown UI primitive "${id}".`,
    actual: id,
    allowed: [...project.uiRegistry.keys()].sort()
  });
  for (const id of contract.libraries.sections) if (!project.registry.has(id)) diagnostics.push({
    code: "DESIGN_SYSTEM_SECTION_EXPORT_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: "/libraries/sections",
    message: `Design System exports unknown section component "${id}".`,
    actual: id,
    allowed: [...project.registry.keys()].sort()
  });
  const presets = new Map(project.sectionPresets.map(preset => [preset.id, preset]));
  for (const id of contract.libraries.presets) if (!presets.has(id)) diagnostics.push({
    code: "DESIGN_SYSTEM_PRESET_EXPORT_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: "/libraries/presets",
    message: `Design System exports unknown section preset "${id}".`,
    actual: id,
    allowed: [...presets.keys()].sort()
  });

  if (!(await fileExists(join(project.root, contract.fonts.source)))) diagnostics.push({
    code: "DESIGN_SYSTEM_FILE_MISSING",
    severity: "error",
    file: "design-system.yaml",
    path: "/fonts/source",
    message: `Design System references missing file ${JSON.stringify(contract.fonts.source)}.`,
    expected: contract.fonts.source
  });

  const exportedSections = new Set(contract.libraries.sections);
  for (const id of contract.libraries.presets) {
    const preset = presets.get(id);
    if (!preset || exportedSections.has(preset.value.section.use)) continue;
    diagnostics.push({
      code: "DESIGN_SYSTEM_PRESET_SECTION_NOT_EXPORTED",
      severity: "error",
      file: "design-system.yaml",
      path: "/libraries/presets",
      message: `Exported section preset "${id}" targets section "${preset.value.section.use}", which is not exported by this Design System.`,
      actual: preset.value.section.use,
      allowed: [...exportedSections].sort()
    });
  }

  for (const [shellId, shell] of Object.entries(contract.shells.items)) {
    for (const path of new Set([shell.entry, ...shell.files])) if (!(await fileExists(join(project.root, path)))) diagnostics.push({
      code: "DESIGN_SYSTEM_FILE_MISSING",
      severity: "error",
      file: "design-system.yaml",
      path: `/shells/items/${shellId}`,
      message: `Shell pack "${shellId}" references missing file ${JSON.stringify(path)}.`,
      expected: path
    });

    if (await fileExists(join(project.root, shell.entry))) {
      try {
        const source = await readFile(join(project.root, shell.entry), "utf8");
        if (!/<slot(?:\s|\/>|>)/i.test(source)) diagnostics.push({
          code: "DESIGN_SYSTEM_SHELL_SLOT_MISSING",
          severity: "error",
          file: shell.entry,
          path: `/shells/items/${shellId}/entry`,
          message: `Shell pack "${shellId}" must render <slot />.`,
          expected: "<slot />"
        });
      } catch (error) {
        diagnostics.push({
          code: "DESIGN_SYSTEM_SHELL_READ_FAILED",
          severity: "error",
          file: shell.entry,
          path: `/shells/items/${shellId}/entry`,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const design = (await inspectDesign(project.root)).design;
  const semantic = new Set(design.semantic.map(token => token.name));
  for (const [field, token] of Object.entries(contract.layout.tokens)) if (!semantic.has(token)) diagnostics.push({
    code: "DESIGN_SYSTEM_LAYOUT_TOKEN_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: `/layout/tokens/${field}`,
    message: `Layout convention references unknown semantic token "${token}".`,
    actual: token,
    allowed: [...semantic].sort()
  });
}

function validateSectionPresetDefinitions(project: LoadedProject, diagnostics: Diagnostic[]): void {
  for (const preset of project.sectionPresets) {
    const section = preset.value.section;
    const component = project.registry.get(section.use);
    if (!component) {
      const uiMatch = project.uiRegistry.has(section.use);
      const allowed = [...project.registry.keys()].sort();
      diagnostics.push({
        code: uiMatch ? "SECTION_PRESET_UI_PRIMITIVE_FORBIDDEN" : "SECTION_PRESET_COMPONENT_UNKNOWN",
        severity: "error",
        file: preset.file,
        path: "/section/use",
        component: section.use,
        message: uiMatch
          ? `Section preset "section:${preset.id}" cannot target UI primitive "${section.use}"; target a registered section.`
          : `Section preset "section:${preset.id}" targets unknown component "${section.use}".`,
        expected: "registered section component",
        actual: section.use,
        allowed,
        suggestions: uiMatch
          ? [{ action: "use-ui-inside-component", command: `npm run site -- spec ui:${section.use} --json` }]
          : nearestStrings(section.use, allowed).length > 0
            ? [{ action: "reuse-component", candidates: nearestStrings(section.use, allowed) }]
            : [{ action: "create-component", command: `npm run site -- add component ${section.use}` }]
      });
      continue;
    }
    const variant = section.variant ?? "default";
    if (!component.variants.includes(variant)) diagnostics.push({
      code: "SECTION_PRESET_VARIANT_UNKNOWN", severity: "error", file: preset.file, path: "/section/variant", component: component.id,
      message: `Section preset "section:${preset.id}" uses unknown variant "${variant}" for "${component.id}".`,
      actual: variant, allowed: component.variants, suggestions: [{ action: "use-value", field: "variant", value: nearestStrings(variant, component.variants, 1)[0] ?? "default" }]
    });
    const theme = section.theme ?? "default";
    if (!component.themes.includes(theme)) diagnostics.push({
      code: "SECTION_PRESET_THEME_UNKNOWN", severity: "error", file: preset.file, path: "/section/theme", component: component.id,
      message: `Section preset "section:${preset.id}" uses unknown theme "${theme}" for "${component.id}".`,
      actual: theme, allowed: component.themes, suggestions: [{ action: "use-value", field: "theme", value: nearestStrings(theme, component.themes, 1)[0] ?? "default" }]
    });
  }
}

function validateContentPageDefinitions(project: LoadedProject, diagnostics: Diagnostic[]): void {
  for (const page of project.pages) {
    const content = page.value.content;
    if (!content) continue;
    if (content.entry && !project.contentRegistry.has(content.entry)) diagnostics.push({
      code: "CONTENT_PAGE_COLLECTION_NOT_FOUND", severity: "error", file: page.file, page: page.value.page.id,
      path: "/content/entry", message: `Content collection "${content.entry}" was not found.`,
      expected: [...project.contentRegistry.keys()].sort(), actual: content.entry
    });
    for (const [queryId, query] of Object.entries(content.queries ?? {})) {
      if (!project.contentRegistry.has(query.collection)) diagnostics.push({
        code: "CONTENT_QUERY_COLLECTION_NOT_FOUND", severity: "error", file: page.file, page: page.value.page.id,
        path: `/content/queries/${queryId}/collection`,
        message: `Content query "${queryId}" targets unknown collection "${query.collection}".`,
        expected: [...project.contentRegistry.keys()].sort(), actual: query.collection
      });
      for (const filter of query.filter ?? []) {
        for (const value of Object.values(filter)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const ref = (value as { $ref?: unknown }).$ref;
          if (typeof ref === "string" && ref.startsWith("entry:") && !content.entry) diagnostics.push({
            code: "CONTENT_QUERY_ENTRY_CONTEXT_REQUIRED", severity: "error", file: page.file, page: page.value.page.id,
            path: `/content/queries/${queryId}/filter`,
            message: `Query filter reference "${ref}" requires page.content.entry.`,
            expected: "content.entry", actual: ref
          });
        }
      }
      for (const diagnostic of validatePaginationRoute(queryId, query, routeParamNames(page.value.page.route))) {
        diagnostics.push({ ...diagnostic, file: page.file, page: page.value.page.id });
      }
    }
  }
}

interface PageInstance {
  route: string;
  baseRoute: string;
  params: Record<string, string>;
  id: string;
  contentEntry?: ContentEntry;
  queryPages?: Record<string, number>;
}

function contentEntryParams(entry: ContentEntry, names: string[]): { params: Record<string, string>; invalid: string[] } {
  const record = contentEntryRecord(entry);
  const params: Record<string, string> = {};
  const invalid: string[] = [];
  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) invalid.push(name);
    else params[name] = value;
  }
  return { params, invalid };
}

function prepareContentEntryHrefs(project: LoadedProject, diagnostics: Diagnostic[]): void {
  const primary = new Map<string, LoadedProject["pages"][number]>();
  for (const page of project.pages) {
    const collectionId = page.value.content?.entry;
    if (!collectionId) continue;
    const existing = primary.get(collectionId);
    if (existing) {
      diagnostics.push({
        code: "CONTENT_ENTRY_PAGE_DUPLICATE", severity: "error", file: page.file, page: page.value.page.id,
        path: "/content/entry",
        message: `Collection "${collectionId}" is already materialized by page "${existing.value.page.id}". v0.3 allows one canonical entry page per collection.`,
        expected: "one entry page per collection", actual: [existing.value.page.id, page.value.page.id]
      });
      continue;
    }
    primary.set(collectionId, page);
  }

  for (const [collectionId, page] of primary) {
    const collection = project.contentRegistry.get(collectionId);
    if (!collection) continue;
    const names = routeParamNames(page.value.page.route);
    for (const entry of collection.entries) {
      const resolved = contentEntryParams(entry, names);
      if (resolved.invalid.length === 0 && names.length > 0) entry.href = materializeRoute(page.value.page.route, resolved.params);
    }
  }
}

function expandPaginationInstances(
  project: LoadedProject,
  page: LoadedProject["pages"][number],
  bases: PageInstance[],
  diagnostics: Diagnostic[]
): PageInstance[] {
  const paginated = Object.entries(page.value.content?.queries ?? {}).filter(([, query]) => !!query.paginate);
  if (paginated.length === 0) return bases;
  if (paginated.length > 1) {
    diagnostics.push({
      code: "CONTENT_PAGINATION_MULTIPLE_QUERIES", severity: "error", file: page.file, page: page.value.page.id,
      path: "/content/queries",
      message: "A page may materialize routes from only one paginated content query.",
      actual: paginated.map(([id]) => id)
    });
    return bases;
  }

  const [queryId, query] = paginated[0]!;
  const out: PageInstance[] = [];
  for (const base of bases) {
    const run = runContentQuery({
      registry: project.contentRegistry,
      queryId,
      query,
      contextEntry: base.contentEntry,
      currentPage: 1,
      firstHref: base.route,
      params: base.params
    });
    out.push({ ...base, queryPages: { [queryId]: 1 } });
    if (!query.paginate) continue;
    for (let currentPage = 2; currentPage <= run.totalPages; currentPage++) {
      const params = { ...base.params, page: String(currentPage) };
      out.push({
        route: materializeRoute(query.paginate.route, params),
        baseRoute: base.route,
        params,
        id: `${base.id}--page-${currentPage}`,
        contentEntry: base.contentEntry,
        queryPages: { [queryId]: currentPage }
      });
    }
  }
  return out;
}

function pageInstances(project: LoadedProject, page: LoadedProject["pages"][number], diagnostics: Diagnostic[]): PageInstance[] {
  const template = page.value.page.route;
  const names = routeParamNames(template);
  const paths = page.value.page.paths;
  const collectionId = page.value.content?.entry;
  let bases: PageInstance[] = [];

  if (collectionId) {
    if (paths) diagnostics.push({
      code: "CONTENT_ENTRY_PATHS_FORBIDDEN", severity: "error", file: page.file, page: page.value.page.id,
      path: "/page/paths", message: "page.paths cannot be combined with content.entry; collection entries materialize the route."
    });
    if (names.length === 0) {
      diagnostics.push({
        code: "CONTENT_ENTRY_DYNAMIC_ROUTE_REQUIRED", severity: "error", file: page.file, page: page.value.page.id,
        path: "/page/route", message: "A content.entry page requires at least one [param] route segment."
      });
      return [];
    }
    const collection = project.contentRegistry.get(collectionId);
    if (!collection) return [];
    const seenRoutes = new Set<string>();
    for (const entry of collection.entries) {
      const resolved = contentEntryParams(entry, names);
      if (resolved.invalid.length > 0) {
        diagnostics.push({
          code: "CONTENT_ROUTE_FIELD_INVALID", severity: "error", file: entry.source, page: page.value.page.id,
          message: `Entry cannot materialize route "${template}" because route field(s) are missing or invalid: ${resolved.invalid.join(", ")}.`,
          expected: names, actual: resolved.invalid,
          details: { collection: collectionId, entry: entry.id }
        });
        continue;
      }
      const route = materializeRoute(template, resolved.params);
      if (seenRoutes.has(route)) {
        diagnostics.push({
          code: "CONTENT_ROUTE_DUPLICATE", severity: "error", file: entry.source, page: page.value.page.id,
          message: `Content entries materialize duplicate route "${route}".`, actual: route
        });
        continue;
      }
      seenRoutes.add(route);
      entry.href = route;
      bases.push({
        route,
        baseRoute: route,
        params: resolved.params,
        id: resolvedPageId(page.value.page.id, names, resolved.params),
        contentEntry: entry
      });
    }
    return expandPaginationInstances(project, page, bases, diagnostics);
  }

  if (names.length === 0) {
    if (paths) diagnostics.push({
      code: "STATIC_ROUTE_PATHS_FORBIDDEN", severity: "error", file: page.file, page: page.value.page.id,
      path: "/page/paths", message: "page.paths is only valid for dynamic route templates containing [param] segments."
    });
    bases = [{ route: template, baseRoute: template, params: {}, id: page.value.page.id }];
    return expandPaginationInstances(project, page, bases, diagnostics);
  }

  if (page.value.specVersion === "0.1" || project.site?.specVersion === "0.1") {
    diagnostics.push({
      code: "DYNAMIC_ROUTE_REQUIRES_V02", severity: "error", file: page.file, page: page.value.page.id,
      path: "/page/route", message: "Dynamic route templates require specVersion \"0.2\" or newer.",
      expected: ["0.2", "0.3", "0.4"], actual: page.value.specVersion
    });
    return [];
  }
  if (!paths?.length) {
    diagnostics.push({
      code: "DYNAMIC_ROUTE_PATHS_REQUIRED", severity: "error", file: page.file, page: page.value.page.id,
      path: "/page/paths", message: `Dynamic route "${template}" requires page.paths or content.entry.`,
      expected: names
    });
    return [];
  }

  const seenRoutes = new Set<string>();
  for (let index = 0; index < paths.length; index++) {
    const params = paths[index]!;
    const keys = Object.keys(params).sort();
    const missing = names.filter(name => !(name in params));
    const extra = keys.filter(name => !names.includes(name));
    if (missing.length || extra.length) {
      diagnostics.push({
        code: "DYNAMIC_ROUTE_PARAMS_INVALID", severity: "error", file: page.file, page: page.value.page.id,
        path: `/page/paths/${index}`,
        message: `Dynamic route path parameters must match [${names.join("], [")}].`,
        expected: names,
        actual: keys,
        details: { missing, extra }
      });
      continue;
    }
    const route = materializeRoute(template, params);
    if (seenRoutes.has(route)) {
      diagnostics.push({
        code: "DYNAMIC_ROUTE_PATH_DUPLICATE", severity: "error", file: page.file, page: page.value.page.id,
        path: `/page/paths/${index}`, message: `Dynamic route materializes duplicate path "${route}".`, actual: route
      });
      continue;
    }
    seenRoutes.add(route);
    bases.push({ route, baseRoute: route, params, id: resolvedPageId(page.value.page.id, names, params) });
  }
  return expandPaginationInstances(project, page, bases, diagnostics);
}

function validateInternalLinks(pages: ResolvedPage[], diagnostics: Diagnostic[]): void {
  const states = new Map(pages.map(p => [p.route, p.state]));
  const routes = [...states.keys()].sort();
  for (const page of pages) {
    for (const section of page.sections) {
      const hrefs: string[] = [];
      collectHrefs(section.props, hrefs);
      for (const href of hrefs) {
        const route = internalRoute(href);
        if (!route) continue;
        const state = states.get(route);
        if (!state) {
          const candidates = nearestStrings(route, routes);
          diagnostics.push({
            code: "LINK_INTERNAL_NOT_FOUND", severity: "error", page: page.id, section: section.id,
            component: section.component, message: `Internal link "${href}" does not match a page route.`,
            expected: "existing page route",
            actual: route,
            allowed: routes,
            suggestions: candidates.length > 0 ? [{
              action: "use-route",
              candidates,
              message: "Use an existing route when it matches the intended destination."
            }] : undefined
          });
        }
        else if (page.state === "published" && state === "draft") diagnostics.push({
          code: "LINK_TARGET_DRAFT", severity: "error", page: page.id, section: section.id,
          component: section.component, message: `Published page links to draft route "${route}".`,
          expected: "published route",
          actual: "draft",
          suggestions: [{
            action: "publish-target-or-change-link",
            field: route,
            message: "Publish the target page or link to a published route."
          }]
        });
      }
    }
  }
}

function resolveNavigation(
  navigation: SourceNavigation,
  pages: ResolvedPage[],
  diagnostics: Diagnostic[]
): ResolvedNavigation {
  const states = new Map(pages.map(page => [page.route, page.state]));
  const routes = [...states.keys()].sort();
  const resolved: ResolvedNavigation = {};

  for (const collectionId of Object.keys(navigation).sort()) {
    const items = navigation[collectionId] ?? [];
    const seen = new Set<string>();
    resolved[collectionId] = [];

    items.forEach((item, index) => {
      const path = `/navigation/${collectionId}/${index}`;
      if (seen.has(item.id)) {
        diagnostics.push({
          code: "NAVIGATION_ITEM_ID_DUPLICATE",
          severity: "error",
          file: "site.yaml",
          path: `${path}/id`,
          message: `Navigation collection "${collectionId}" contains duplicate item id "${item.id}".`,
          expected: "unique item id within navigation collection",
          actual: item.id
        });
      }
      seen.add(item.id);

      const route = internalRoute(item.href);
      const external = route === undefined;
      if (route) {
        const state = states.get(route);
        if (!state) {
          const candidates = nearestStrings(route, routes);
          diagnostics.push({
            code: "NAVIGATION_LINK_INTERNAL_NOT_FOUND",
            severity: "error",
            file: "site.yaml",
            path: `${path}/href`,
            message: `Navigation item "${collectionId}.${item.id}" links to unknown route "${route}".`,
            expected: "existing page route",
            actual: route,
            allowed: routes,
            suggestions: candidates.length > 0 ? [{
              action: "use-route",
              field: `${collectionId}.${item.id}`,
              candidates,
              message: "Use an existing site route."
            }] : undefined
          });
        } else if (state === "draft") {
          diagnostics.push({
            code: "NAVIGATION_LINK_TARGET_DRAFT",
            severity: "error",
            file: "site.yaml",
            path: `${path}/href`,
            message: `Navigation item "${collectionId}.${item.id}" links to draft route "${route}".`,
            expected: "published route",
            actual: "draft",
            suggestions: [{
              action: "publish-target-or-change-link",
              field: route,
              message: "Publish the target page or point the navigation item at a published route."
            }]
          });
        }
      } else if (!isSupportedExternalHref(item.href)) {
        diagnostics.push({
          code: "NAVIGATION_HREF_INVALID",
          severity: "error",
          file: "site.yaml",
          path: `${path}/href`,
          message: `Navigation item "${collectionId}.${item.id}" has unsupported href "${item.href}".`,
          expected: "site route beginning with /, or http(s), mailto:, or tel: URL",
          actual: item.href,
          suggestions: [{
            action: "use-route-or-absolute-url",
            field: `${collectionId}.${item.id}`,
            message: "Use a stable site route or an explicit external URL."
          }]
        });
      }

      resolved[collectionId]!.push({
        id: item.id,
        label: item.label,
        href: item.href,
        target: item.target ?? "self",
        external
      });
    });
  }

  return resolved;
}

export async function validateLoadedProject(project: LoadedProject): Promise<ValidationResult> {
  const diagnostics = [...project.diagnostics];
  validateGlobalIdentities(project, diagnostics);
  validateSpecVersions(project, diagnostics);
  await validateDesignSystemProject(project, diagnostics);
  validateSectionPresetDefinitions(project, diagnostics);
  validateContentPageDefinitions(project, diagnostics);
  prepareContentEntryHrefs(project, diagnostics);
  await validateSiteAssets(project, diagnostics);
  diagnostics.push(...await validateDesign(project.root));

  const resolvedPages: ResolvedPage[] = [];
  const concreteRoutes = new Map<string, string>();
  if (project.site) {
    for (const page of project.pages) {
      for (const instance of pageInstances(project, page, diagnostics)) {
        const owner = concreteRoutes.get(instance.route);
        if (owner) {
          diagnostics.push({
            code: "PAGE_ROUTE_DUPLICATE", severity: "error", file: page.file, page: page.value.page.id,
            message: `Concrete route "${instance.route}" conflicts with ${owner}.`, actual: instance.route
          });
          continue;
        }
        concreteRoutes.set(instance.route, page.file);
        const resolved = await resolvePage(project, page, instance);
        diagnostics.push(...resolved.diagnostics);
        if (resolved.page) resolvedPages.push(resolved.page);
      }
    }
    validateInternalLinks(resolvedPages, diagnostics);
  }

  const navigation = project.site
    ? resolveNavigation(project.site.navigation ?? {}, resolvedPages, diagnostics)
    : {};

  const site: ResolvedSite | undefined = project.site ? {
    specVersion: project.site.specVersion,
    site: { ...project.site.site },
    designSystem: project.designSystem ? {
      id: project.designSystem.value.designSystem.id,
      name: project.designSystem.value.designSystem.name,
      version: project.designSystem.value.designSystem.version,
      theme: project.site.designSystem?.theme ?? project.designSystem.value.themes.default,
      shell: project.site.designSystem?.shell ?? project.designSystem.value.shells.default,
      shellEntry: project.designSystem.value.shells.items[project.site.designSystem?.shell ?? project.designSystem.value.shells.default]?.entry ?? "shell/default.astro"
    } : undefined,
    brand: { ...(project.site.brand ?? {}) },
    assets: { ...project.site.assets },
    navigation,
    pages: resolvedPages.sort((a, b) => a.route.localeCompare(b.route)),
    generated: { sitemap: true, robots: true }
  } : undefined;

  return { valid: !hasErrors(diagnostics), site, diagnostics };
}

export async function validateProject(root: string): Promise<ValidationResult> {
  return validateLoadedProject(await loadProject(root));
}

export async function resolveSite(root: string): Promise<ResolvedSite> {
  const result = await validateProject(root);
  if (!result.valid || !result.site) {
    const summary = result.diagnostics.filter(d => d.severity === "error").map(d => `${d.code}: ${d.message}`).join("\n");
    throw new Error(summary || "Site validation failed.");
  }
  return result.site;
}

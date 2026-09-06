import type { ErrorObject } from "ajv";
import { createHash } from "node:crypto";
import { findOrigin, nearestStrings } from "./diagnostics.js";
import { resolveRefs } from "./refs.js";
import { resolvedContentEntry, runContentQuery } from "./content-query.js";
import type {
  ContentEntry, Diagnostic, LoadedPage, LoadedProject, Origin, RegisteredComponent, ResolvedContentQuery, RouteParams,
  SourceSection, SourceSectionEntry, ResolvedPage, ResolvedSection, ResolvedSeo
} from "./types.js";

function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

function normalizeCanonical(siteUrl: string, route: string): string {
  const base = normalizeSiteUrl(siteUrl);
  return route === "/" ? base : `${base}${route}`;
}


function interpolateParams(value: string | undefined, params: RouteParams): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\{([a-z][a-z0-9-]*)\}/g, (match, name: string) => params[name] ?? match);
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!part) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else return undefined;
  }
  return current;
}

function interpolateContext(
  value: string | undefined,
  params: RouteParams,
  entry?: Record<string, unknown>
): string | undefined {
  const withParams = interpolateParams(value, params);
  if (withParams === undefined) return undefined;
  return withParams.replace(/\{entry\.([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (match, path: string) => {
    const resolved = entry ? valueAtPath(entry, path) : undefined;
    return typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean"
      ? String(resolved)
      : match;
  });
}

function unresolvedParamNames(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/\{([a-z][a-z0-9-]*)\}/g)].map(match => match[1]!).filter((name, index, all) => all.indexOf(name) === index);
}

function unresolvedEntryNames(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/\{entry\.([A-Za-z_][A-Za-z0-9_.-]*)\}/g)]
    .map(match => match[1]!)
    .filter((name, index, all) => all.indexOf(name) === index);
}

function validCanonical(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function propProperties(component: RegisteredComponent): Record<string, unknown> {
  const props = component.manifest.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) return {};
  const properties = (props as Record<string, unknown>).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : {};
}

function valueAtPointer(value: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return value;
  let current = value;
  for (const rawPart of pointer.split("/").slice(1)) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function propDiagnostics(
  errors: ErrorObject[] | null | undefined,
  page: LoadedPage,
  sectionId: string,
  component: RegisteredComponent,
  provenance: Map<string, Origin>,
  props: Record<string, unknown>,
  fallbackOrigin?: Origin
): Diagnostic[] {
  return (errors ?? []).map(error => {
    const additional = error.keyword === "additionalProperties"
      ? String((error.params as { additionalProperty?: string }).additionalProperty ?? "")
      : undefined;
    const pointer = additional
      ? `${error.instancePath}/${additional.replaceAll("~", "~0").replaceAll("/", "~1")}`
      : error.instancePath || "/";
    const origin = findOrigin(provenance, pointer) ?? fallbackOrigin;
    const properties = propProperties(component);
    const allowedProps = Object.keys(properties).sort();
    let code = "COMPONENT_PROP_INVALID";
    let message = `Invalid props for component "${component.id}": ${error.message ?? "validation failed"}.`;
    let expected: unknown = error.keyword;
    let actual: unknown = valueAtPointer(props, error.instancePath || "/");
    let allowed: unknown[] | undefined;
    let suggestions: Diagnostic["suggestions"];
    if (error.keyword === "additionalProperties") {
      code = "COMPONENT_PROP_UNKNOWN";
      message = `Component "${component.id}" does not accept prop "${additional}".`;
      expected = "declared component prop";
      actual = additional;
      allowed = allowedProps;
      suggestions = [{ action: "remove-prop", field: additional, message: `Remove unsupported prop "${additional}".` }];
      const candidates = additional ? nearestStrings(additional, allowedProps) : [];
      if (candidates.length > 0) suggestions.push({
        action: "rename-prop",
        field: additional,
        candidates,
        message: `Use a declared prop instead of "${additional}".`
      });
    } else if (error.keyword === "required") {
      code = "COMPONENT_PROP_REQUIRED";
      const missing = String((error.params as { missingProperty?: string }).missingProperty ?? "unknown");
      message = `Component "${component.id}" requires prop "${missing}".`;
      expected = properties[missing] ?? "required prop";
      actual = undefined;
      suggestions = [{ action: "add-prop", field: missing, message: `Add required prop "${missing}" using the component contract.` }];
    } else if (error.keyword === "enum") {
      allowed = ((error.params as { allowedValues?: unknown[] }).allowedValues ?? []);
      expected = { enum: allowed };
      suggestions = allowed.length > 0 ? [{
        action: "use-value",
        field: error.instancePath,
        value: allowed[0],
        message: "Use one of the allowed values."
      }] : undefined;
    } else if (error.keyword === "type") {
      expected = (error.params as { type?: string }).type ?? "valid type";
    }
    return {
      code,
      severity: "error",
      file: page.file,
      page: page.value.page.id,
      section: sectionId,
      component: component.id,
      path: `/sections/${sectionId}/props${pointer === "/" ? "" : pointer}`,
      sourceFile: origin?.file,
      sourcePath: origin?.path,
      message,
      expected,
      actual,
      allowed,
      suggestions,
      details: { keyword: error.keyword, params: error.params }
    };
  });
}

function socialImagePath(
  route: string,
  title: string,
  description: string,
  format: "png" | "jpeg" | "webp",
  width: number,
  height: number
): string {
  const base = route === "/"
    ? "home"
    : route.slice(1).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "page";
  const hash = createHash("sha256")
    .update(JSON.stringify({ route, title, description, format, width, height }))
    .digest("hex")
    .slice(0, 10);
  const extension = format === "jpeg" ? "jpg" : format;
  return `/_social/${base}-${hash}.${extension}`;
}

function resolveSeoUrl(siteUrl: string, value?: string): string | undefined {
  if (!value) return undefined;
  const base = normalizeSiteUrl(siteUrl);
  if (/^https?:\/\//.test(value)) return value === `${base}/` ? base : value;
  if (value === "/") return base;
  if (value.startsWith("/")) return `${base}${value}`;
  return value;
}

function resolveSeo(
  project: LoadedProject,
  page: LoadedPage,
  diagnostics: Diagnostic[],
  route: string,
  params: RouteParams,
  contentEntry?: Record<string, unknown>,
  resolvedState: "draft" | "published" = page.value.page.state ?? "published"
): ResolvedSeo {
  const site = project.site!;
  const source = page.value.seo ?? {};
  const pageLocale = page.value.page.locale ?? site.site.locale;
  const rawTitle = interpolateContext(source.title, params, contentEntry);
  if (!rawTitle && resolvedState !== "draft") diagnostics.push({
    code: "SEO_TITLE_MISSING", severity: "error", file: page.file, page: page.value.page.id,
    path: "/seo/title", message: "Published pages require seo.title."
  });
  const title = rawTitle
    ? site.seo?.titleTemplate?.replace("%s", rawTitle) ?? rawTitle
    : "";
  const description = interpolateContext(source.description, params, contentEntry) ?? site.seo?.defaultDescription ?? "";
  if (!description && resolvedState !== "draft") diagnostics.push({
    code: "SEO_DESCRIPTION_MISSING", severity: "error", file: page.file, page: page.value.page.id,
    path: "/seo/description", message: "Published pages require a description or site.seo.defaultDescription."
  });

  const interpolatedFields: Array<[string, string | undefined]> = [
    ["title", rawTitle],
    ["description", description],
    ["canonical", interpolateContext(source.canonical, params, contentEntry)],
    ["image", interpolateContext(source.image, params, contentEntry)],
    ["openGraph.title", interpolateContext(source.openGraph?.title, params, contentEntry)],
    ["openGraph.description", interpolateContext(source.openGraph?.description, params, contentEntry)],
    ["openGraph.image", interpolateContext(source.openGraph?.image, params, contentEntry)],
    ["twitter.title", interpolateContext(source.twitter?.title, params, contentEntry)],
    ["twitter.description", interpolateContext(source.twitter?.description, params, contentEntry)],
    ["twitter.image", interpolateContext(source.twitter?.image, params, contentEntry)]
  ];
  for (const [language, value] of Object.entries(source.hreflang ?? {})) {
    interpolatedFields.push([`hreflang.${language}`, interpolateContext(value, params, contentEntry)]);
  }
  for (const [field, value] of interpolatedFields) {
    const unresolved = unresolvedParamNames(value);
    if (unresolved.length > 0) diagnostics.push({
      code: "ROUTE_PARAM_PLACEHOLDER_NOT_FOUND", severity: "error", file: page.file, page: page.value.page.id,
      path: `/seo/${field.replaceAll(".", "/")}`, message: `SEO ${field} references route parameter(s) that are not available: ${unresolved.join(", ")}.`,
      expected: Object.keys(params).sort(), actual: unresolved
    });
    const unresolvedEntry = unresolvedEntryNames(value);
    if (unresolvedEntry.length > 0) diagnostics.push({
      code: "CONTENT_ENTRY_PLACEHOLDER_NOT_FOUND", severity: "error", file: page.file, page: page.value.page.id,
      path: `/seo/${field.replaceAll(".", "/")}`, message: `SEO ${field} references entry field(s) that are not available: ${unresolvedEntry.join(", ")}.`,
      expected: contentEntry ? Object.keys(contentEntry).sort() : "page.content.entry", actual: unresolvedEntry
    });
  }

  const canonicalSource = interpolateContext(source.canonical, params, contentEntry);
  const canonical = canonicalSource ? resolveSeoUrl(site.site.url, canonicalSource)! : normalizeCanonical(site.site.url, route);
  if (!validCanonical(canonical)) diagnostics.push({
    code: "SEO_CANONICAL_INVALID", severity: "error", file: page.file, page: page.value.page.id,
    path: "/seo/canonical", message: `Resolved canonical URL ${JSON.stringify(canonical)} must be an absolute http(s) URL or a site-root path.`,
    expected: "absolute http(s) URL or /path", actual: canonical
  });

  const socialConfig = site.seo?.socialImages;
  const socialFormat = socialConfig?.format ?? "png";
  const socialWidth = socialConfig?.width ?? 1200;
  const socialHeight = socialConfig?.height ?? 630;
  const explicitOgImage = interpolateContext(source.openGraph?.image, params, contentEntry)
    ?? interpolateContext(source.image, params, contentEntry);
  const generateSocial = site.specVersion === "0.5"
    && (source.socialImage?.generate ?? socialConfig?.generate ?? true)
    && !explicitOgImage;
  const generatedSocial = generateSocial
    ? {
        generated: true as const,
        path: socialImagePath(route, title, description, socialFormat, socialWidth, socialHeight),
        width: socialWidth,
        height: socialHeight,
        format: socialFormat
      }
    : undefined;
  const image = resolveSeoUrl(
    site.site.url,
    explicitOgImage
      ?? generatedSocial?.path
      ?? site.assets.defaultOgImage
  );
  const ogTitle = interpolateContext(source.openGraph?.title, params, contentEntry) ?? title;
  const ogDescription = interpolateContext(source.openGraph?.description, params, contentEntry) ?? description;
  const siteName = source.openGraph?.siteName ?? site.seo?.siteName ?? site.site.name;
  const ogType = source.openGraph?.type ?? (page.value.page.archetype === "article" ? "article" : "website");
  const ogLocale = source.openGraph?.locale ?? pageLocale;
  const twitterImage = resolveSeoUrl(
    site.site.url,
    interpolateContext(source.twitter?.image, params, contentEntry)
      ?? explicitOgImage
      ?? generatedSocial?.path
      ?? site.assets.defaultOgImage
  );

  const hreflang: Record<string, string> = {};
  for (const [language, value] of Object.entries(source.hreflang ?? {})) {
    const resolved = resolveSeoUrl(site.site.url, interpolateContext(value, params, contentEntry));
    if (!resolved || !validCanonical(resolved)) {
      diagnostics.push({
        code: "SEO_HREFLANG_URL_INVALID",
        severity: "error",
        file: page.file,
        page: page.value.page.id,
        path: `/seo/hreflang/${language}`,
        message: `Resolved hreflang URL for ${language} must be an absolute http(s) URL or a site-root path.`,
        actual: resolved ?? value
      });
      continue;
    }
    hreflang[language] = resolved;
  }
  if (Object.keys(hreflang).length > 0 && !hreflang[pageLocale]) {
    hreflang[pageLocale] = canonical;
  }

  return {
    title,
    description,
    canonical,
    image,
    noindex: source.noindex ?? (site.seo?.robots?.index === false),
    hreflang,
    openGraph: {
      type: ogType,
      title: ogTitle,
      description: ogDescription,
      url: canonical,
      image,
      imageWidth: generatedSocial?.width,
      imageHeight: generatedSocial?.height,
      siteName,
      locale: ogLocale
    },
    twitter: {
      card: source.twitter?.card ?? (twitterImage ? "summary_large_image" : "summary"),
      title: interpolateContext(source.twitter?.title, params, contentEntry) ?? ogTitle,
      description: interpolateContext(source.twitter?.description, params, contentEntry) ?? ogDescription,
      image: twitterImage
    },
    socialImage: generatedSocial
  };
}

function resolveSectionSource(
  project: LoadedProject,
  page: LoadedPage,
  entry: SourceSectionEntry,
  index: number,
  diagnostics: Diagnostic[]
): { source?: SourceSection; preset?: string; origin?: Origin } {
  if (!("$ref" in entry)) return { source: entry };
  const ref = entry.$ref;
  const logical = ref.slice("section:".length);
  const preset = project.sectionPresets.find(item => item.id === logical);
  if (!preset) {
    const refs = project.sectionPresets.map(item => `section:${item.id}`).sort();
    diagnostics.push({
      code: "SECTION_PRESET_NOT_FOUND",
      severity: "error",
      file: page.file,
      page: page.value.page.id,
      section: entry.id,
      path: `/sections/${index}/$ref`,
      message: `Section preset "${ref}" was not found.`,
      expected: "existing section preset",
      actual: ref,
      allowed: refs,
      suggestions: nearestStrings(ref, refs).length > 0
        ? [{ action: "use-reference", candidates: nearestStrings(ref, refs) }]
        : [{ action: "create-section-preset", file: `sections/${logical}.yaml` }]
    });
    return {};
  }
  return {
    source: { id: entry.id, ...preset.value.section },
    preset: ref,
    origin: { file: preset.file, path: "/section/props" }
  };
}

export async function resolvePage(
  project: LoadedProject,
  page: LoadedPage,
  options: {
    route?: string;
    baseRoute?: string;
    params?: RouteParams;
    id?: string;
    contentEntry?: ContentEntry;
    queryPages?: Record<string, number>;
  } = {}
): Promise<{ page?: ResolvedPage; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  if (!project.site) return { diagnostics };
  const params = options.params ?? {};
  const route = options.route ?? page.value.page.route;
  const baseRoute = options.baseRoute ?? route;
  const resolvedId = options.id ?? page.value.page.id;
  const resolvedEntry = options.contentEntry
    ? resolvedContentEntry(project.contentRegistry, options.contentEntry)
    : undefined;
  const queries: Record<string, ResolvedContentQuery> = {};
  for (const [queryId, query] of Object.entries(page.value.content?.queries ?? {})) {
    const run = runContentQuery({
      registry: project.contentRegistry,
      queryId,
      query,
      contextEntry: options.contentEntry,
      currentPage: options.queryPages?.[queryId] ?? 1,
      firstHref: baseRoute,
      params
    });
    diagnostics.push(...run.diagnostics.map(diagnostic => ({
      ...diagnostic,
      file: diagnostic.file ?? page.file,
      page: diagnostic.page ?? page.value.page.id,
      path: diagnostic.path ?? `/content/queries/${queryId}`
    })));
    if (run.result) queries[queryId] = run.result;
  }
  const seenSectionIds = new Set<string>();
  const sections: ResolvedSection[] = [];
  const counts = new Map<string, number>();

  for (let index = 0; index < page.value.sections.length; index++) {
    const entry = page.value.sections[index]!;
    const materialized = resolveSectionSource(project, page, entry, index, diagnostics);
    const source = materialized.source;
    if (!source) continue;
    if (seenSectionIds.has(source.id)) {
      diagnostics.push({
        code: "SECTION_ID_DUPLICATE", severity: "error", file: page.file, page: page.value.page.id,
        section: source.id, message: `Duplicate section id "${source.id}".`
      });
      continue;
    }
    seenSectionIds.add(source.id);

    const component = project.registry.get(source.use);
    if (!component) {
      const registered = [...project.registry.keys()].sort();
      const candidates = nearestStrings(source.use, registered);
      const uiMatch = project.uiRegistry.has(source.use);
      diagnostics.push({
        code: uiMatch ? "SECTION_UI_PRIMITIVE_FORBIDDEN" : "SECTION_COMPONENT_UNKNOWN",
        severity: "error", file: page.file, page: page.value.page.id,
        section: source.id, component: source.use, path: `/sections/${index}/use`,
        message: uiMatch
          ? `UI primitive "${source.use}" cannot be used directly by Page Spec; compose it inside a registered section.`
          : `Unknown component "${source.use}".`,
        expected: "registered section component",
        actual: source.use,
        allowed: registered,
        suggestions: uiMatch ? [{
          action: "use-ui-inside-component",
          command: `npm run site -- spec ui:${source.use} --json`,
          message: "UI primitives are internal design-system building blocks, not page sections."
        }] : [
          ...(candidates.length > 0 ? [{
            action: "reuse-component",
            candidates,
            message: "Prefer an existing registered section when it can satisfy the intent."
          }] : []),
          {
            action: "create-component",
            command: `npm run site -- add component ${source.use}`,
            message: "Create a new section only if no existing component can satisfy the requirement."
          }
        ]
      });
      continue;
    }

    const variant = source.variant ?? "default";
    const theme = source.theme ?? "default";
    if (!component.variants.includes(variant)) diagnostics.push({
      code: "COMPONENT_VARIANT_UNKNOWN", severity: "error", file: page.file, page: page.value.page.id,
      section: source.id, component: component.id, path: `/sections/${index}/variant`,
      message: `Component "${component.id}" has no variant "${variant}".`,
      hint: `Use one of: ${component.variants.join(", ")}.`,
      expected: "declared component variant",
      actual: variant,
      allowed: component.variants,
      suggestions: [{ action: "use-value", field: "variant", value: nearestStrings(variant, component.variants, 1)[0] ?? "default" }]
    });
    if (!component.themes.includes(theme)) diagnostics.push({
      code: "COMPONENT_THEME_UNKNOWN", severity: "error", file: page.file, page: page.value.page.id,
      section: source.id, component: component.id, path: `/sections/${index}/theme`,
      message: `Component "${component.id}" has no theme "${theme}".`,
      hint: `Use one of: ${component.themes.join(", ")}.`,
      expected: "declared component theme",
      actual: theme,
      allowed: component.themes,
      suggestions: [{ action: "use-value", field: "theme", value: nearestStrings(theme, component.themes, 1)[0] ?? "default" }]
    });

    const allowed = component.manifest.rules?.allowedArchetypes;
    if (allowed && !allowed.includes(page.value.page.archetype)) diagnostics.push({
      code: "COMPOSITION_ARCHETYPE_FORBIDDEN", severity: "error", file: page.file, page: page.value.page.id,
      section: source.id, component: component.id,
      message: `Component "${component.id}" is not allowed on archetype "${page.value.page.archetype}".`,
      expected: "allowed page archetype",
      actual: page.value.page.archetype,
      allowed,
      suggestions: [{ action: "reuse-component", message: "Choose a registered section that allows this page archetype." }]
    });

    const placement = component.manifest.rules?.placement ?? "any";
    if (placement === "first" && index !== 0) diagnostics.push({
      code: "COMPOSITION_PLACEMENT_INVALID", severity: "error", file: page.file, page: page.value.page.id,
      section: source.id, component: component.id, message: `Component "${component.id}" must be the first section.`,
      expected: "first", actual: index,
      suggestions: [{ action: "move-section", field: source.id, value: "first" }]
    });
    if (placement === "last" && index !== page.value.sections.length - 1) diagnostics.push({
      code: "COMPOSITION_PLACEMENT_INVALID", severity: "error", file: page.file, page: page.value.page.id,
      section: source.id, component: component.id, message: `Component "${component.id}" must be the last section.`,
      expected: "last", actual: index,
      suggestions: [{ action: "move-section", field: source.id, value: "last" }]
    });

    counts.set(component.id, (counts.get(component.id) ?? 0) + 1);
    const max = component.manifest.rules?.maxPerPage;
    if (max && counts.get(component.id)! > max) diagnostics.push({
      code: "COMPOSITION_MAX_PER_PAGE", severity: "error", file: page.file, page: page.value.page.id,
      section: source.id, component: component.id, message: `Component "${component.id}" may appear at most ${max} time(s) per page.`,
      expected: { maxPerPage: max }, actual: counts.get(component.id),
      suggestions: [{ action: "remove-section", field: source.id, message: `Remove or replace the extra "${component.id}" section.` }]
    });

    const provenance = new Map<string, Origin>();
    const props = await resolveRefs(source.props ?? {}, "", {
      root: project.root, diagnostics, provenance, page: page.value.page.id,
      section: source.id, pageFile: page.file, siteFile: project.siteFile,
      navigation: project.site.navigation ?? {}, params, entry: resolvedEntry, queries
    }) as Record<string, unknown>;

    if (!component.validateProps(props)) {
      diagnostics.push(...propDiagnostics(
        component.validateProps.errors,
        page,
        source.id,
        component,
        provenance,
        props,
        materialized.origin
      ));
    }

    sections.push({
      id: source.id,
      component: component.id,
      role: component.role,
      variant,
      theme,
      props,
      preset: materialized.preset
    });
  }

  const state = (page.value.page.state === "draft" || options.contentEntry?.status === "draft") ? "draft" : "published";
  if (state === "published" && page.value.page.archetype !== "blank") {
    const headingCount = sections.filter(s => project.registry.get(s.component)?.manifest.semantics?.pageHeading).length;
    if (headingCount === 0) diagnostics.push({
      code: "SEMANTIC_PAGE_HEADING_MISSING", severity: "error", file: page.file, page: page.value.page.id,
      message: "Published non-blank pages require exactly one section with semantics.pageHeading=true."
    });
    if (headingCount > 1) diagnostics.push({
      code: "SEMANTIC_PAGE_HEADING_MULTIPLE", severity: "error", file: page.file, page: page.value.page.id,
      message: `Page has ${headingCount} sections declaring the page heading; exactly one is allowed.`
    });
  }

  const seo = resolveSeo(project, page, diagnostics, route, params, resolvedEntry, state);
  const structuredSources = page.value.structuredData
    ? (Array.isArray(page.value.structuredData) ? page.value.structuredData : [page.value.structuredData])
    : [];
  const structuredData: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (let index = 0; index < structuredSources.length; index++) {
    const sourceStructured = structuredSources[index]!;
    const resolvedStructured = await resolveRefs(sourceStructured.data ?? {}, `/structuredData/${index}/data`, {
      root: project.root,
      diagnostics,
      provenance: new Map<string, Origin>(),
      page: page.value.page.id,
      section: "$structuredData",
      pageFile: page.file,
      siteFile: project.siteFile,
      navigation: project.site.navigation ?? {},
      params,
      entry: resolvedEntry,
      queries
    }) as Record<string, unknown>;
    structuredData.push({ type: sourceStructured.type, data: resolvedStructured ?? {} });
  }
  return {
    page: {
      id: resolvedId,
      templateId: page.value.page.id,
      route,
      routeTemplate: page.value.page.route,
      params,
      archetype: page.value.page.archetype,
      state,
      locale: page.value.page.locale ?? project.site.site.locale,
      seo,
      sections,
      content: page.value.content ? { entry: resolvedEntry, queries } : undefined,
      structuredData
    },
    diagnostics
  };
}

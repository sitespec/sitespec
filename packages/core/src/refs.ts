import { join, relative } from "node:path";
import type { Diagnostic, Origin, ResolvedContentQuery, RouteParams, SourceNavigation } from "./types.js";
import { fileExists, listFiles, parseDataFile } from "./fs.js";
import { escapePointer, nearestStrings } from "./diagnostics.js";

interface RefContext {
  root: string;
  diagnostics: Diagnostic[];
  provenance: Map<string, Origin>;
  page: string;
  section: string;
  pageFile: string;
  siteFile: string;
  navigation: SourceNavigation;
  params?: RouteParams;
  entry?: Record<string, unknown>;
  queries?: Record<string, ResolvedContentQuery>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function containsRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRef);
  if (!isPlainObject(value)) return false;
  if ("$ref" in value) return true;
  return Object.values(value).some(containsRef);
}

function recordProvenance(value: unknown, pointer: string, file: string, sourcePath: string, map: Map<string, Origin>): void {
  map.set(pointer || "/", { file, path: sourcePath || "/" });
  if (Array.isArray(value)) {
    value.forEach((child, i) => recordProvenance(child, `${pointer}/${i}`, file, `${sourcePath}/${i}`, map));
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      recordProvenance(child, `${pointer}/${escapePointer(key)}`, file, `${sourcePath}/${escapePointer(key)}`, map);
    }
  }
}

async function loadContentRef(ref: string, pointer: string, ctx: RefContext): Promise<unknown> {
  const logical = ref.slice("content:".length);
  if (!/^[a-zA-Z0-9/_-]+$/.test(logical) || logical.includes("..")) {
    ctx.diagnostics.push({
      code: "REFERENCE_INVALID", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer, message: `Invalid content reference "${ref}".`
    });
    return undefined;
  }
  const yaml = join(ctx.root, "content", `${logical}.yaml`);
  const json = join(ctx.root, "content", `${logical}.json`);
  const existsYaml = await fileExists(yaml);
  const existsJson = await fileExists(json);
  if (existsYaml && existsJson) {
    ctx.diagnostics.push({
      code: "REFERENCE_AMBIGUOUS", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer,
      message: `Reference "${ref}" matches both YAML and JSON content files.`
    });
    return undefined;
  }
  const file = existsYaml ? yaml : existsJson ? json : undefined;
  if (!file) {
    const contentDir = join(ctx.root, "content");
    const refs = (await listFiles(contentDir, [".yaml", ".yml", ".json"]))
      .map(candidate => relative(contentDir, candidate).replace(/\\/g, "/").replace(/\.(?:ya?ml|json)$/i, ""))
      .map(candidate => `content:${candidate}`)
      .sort();
    const candidates = nearestStrings(ref, refs);
    ctx.diagnostics.push({
      code: "REFERENCE_NOT_FOUND", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer,
      message: `Content reference "${ref}" was not found.`,
      expected: "existing content reference",
      actual: ref,
      allowed: refs,
      suggestions: candidates.length > 0 ? [{
        action: "use-reference",
        candidates,
        message: "Use an existing content reference when it matches the intended data."
      }] : [{
        action: "create-content",
        field: logical,
        message: `Create content/${logical}.yaml if this is new content.`
      }]
    });
    return undefined;
  }
  const parsed = await parseDataFile<unknown>(ctx.root, file);
  if (parsed.diagnostic) { ctx.diagnostics.push(parsed.diagnostic); return undefined; }
  if (containsRef(parsed.value)) {
    ctx.diagnostics.push({
      code: "REFERENCE_CHAINED_UNSUPPORTED", severity: "error", file: relative(ctx.root, file),
      page: ctx.page, section: ctx.section,
      message: "Content files cannot contain $ref in SiteSpec."
    });
    return undefined;
  }
  const rel = relative(ctx.root, file).replaceAll("\\", "/");
  recordProvenance(parsed.value, pointer, rel, "", ctx.provenance);
  return parsed.value;
}

function loadNavigationRef(ref: string, pointer: string, ctx: RefContext): unknown {
  const id = ref.slice("navigation:".length);
  const refs = Object.keys(ctx.navigation).sort().map(value => `navigation:${value}`);
  const collection = ctx.navigation[id];
  if (!collection) {
    const candidates = nearestStrings(ref, refs);
    ctx.diagnostics.push({
      code: "NAVIGATION_REFERENCE_NOT_FOUND",
      severity: "error",
      file: ctx.pageFile,
      page: ctx.page,
      section: ctx.section,
      path: pointer,
      message: `Navigation collection "${id}" was not found.`,
      expected: "existing navigation collection",
      actual: ref,
      allowed: refs,
      suggestions: candidates.length > 0 ? [{
        action: "use-reference",
        candidates,
        message: "Use an existing named navigation collection."
      }] : [{
        action: "define-navigation",
        field: id,
        message: `Define navigation.${id} in site.yaml.`
      }]
    });
    return undefined;
  }
  recordProvenance(collection, pointer, ctx.siteFile, `/navigation/${escapePointer(id)}`, ctx.provenance);
  return collection;
}

function loadParamRef(ref: string, pointer: string, ctx: RefContext): unknown {
  const id = ref.slice("param:".length);
  const params = ctx.params ?? {};
  const names = Object.keys(params).sort();
  if (!(id in params)) {
    ctx.diagnostics.push({
      code: "ROUTE_PARAM_REFERENCE_NOT_FOUND",
      severity: "error",
      file: ctx.pageFile,
      page: ctx.page,
      section: ctx.section,
      path: pointer,
      message: `Route parameter "${id}" is not available on this page.`,
      expected: "declared route parameter",
      actual: id,
      allowed: names,
      suggestions: names.length > 0 ? [{ action: "use-route-param", candidates: names.map(name => `param:${name}`) }] : undefined
    });
    return undefined;
  }
  return params[id];
}

function valueAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split(".")) {
    if (!part) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isPlainObject(current)) {
      current = current[part];
    } else return undefined;
  }
  return current;
}

function loadEntryRef(ref: string, pointer: string, ctx: RefContext): unknown {
  const path = ref.slice("entry:".length);
  if (!ctx.entry) {
    ctx.diagnostics.push({
      code: "CONTENT_ENTRY_REFERENCE_UNAVAILABLE", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer,
      message: `Entry reference "${ref}" is only available on a page with content.entry.`,
      expected: "page.content.entry", actual: ref
    });
    return undefined;
  }
  const value = valueAtPath(ctx.entry, path);
  if (value === undefined) {
    ctx.diagnostics.push({
      code: "CONTENT_ENTRY_REFERENCE_NOT_FOUND", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer,
      message: `Entry field "${path}" was not found.`, actual: ref,
      allowed: Object.keys(ctx.entry).sort()
    });
  }
  return value;
}

function loadQueryRef(ref: string, pointer: string, ctx: RefContext): unknown {
  const logical = ref.slice("query:".length);
  const [id, ...rest] = logical.split(".");
  const query = id ? ctx.queries?.[id] : undefined;
  if (!id || !query) {
    const allowed = Object.keys(ctx.queries ?? {}).sort();
    ctx.diagnostics.push({
      code: "CONTENT_QUERY_REFERENCE_NOT_FOUND", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer,
      message: `Content query "${id ?? logical}" is not available on this page.`,
      expected: "declared page.content.queries entry", actual: id ?? logical, allowed
    });
    return undefined;
  }
  const path = rest.join(".");
  const value = valueAtPath(query, path);
  if (path && value === undefined) {
    ctx.diagnostics.push({
      code: "CONTENT_QUERY_REFERENCE_FIELD_NOT_FOUND", severity: "error", file: ctx.pageFile,
      page: ctx.page, section: ctx.section, path: pointer,
      message: `Query reference "${ref}" does not resolve to a value.`, actual: ref,
      allowed: ["items", "pagination"]
    });
  }
  return value;
}

export async function resolveRefs(value: unknown, pointer: string, ctx: RefContext): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((child, i) => resolveRefs(child, `${pointer}/${i}`, ctx)));
  }
  if (!isPlainObject(value)) return value;

  if ("$ref" in value) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== "string") {
      ctx.diagnostics.push({
        code: "REFERENCE_INVALID", severity: "error", file: ctx.pageFile,
        page: ctx.page, section: ctx.section, path: pointer,
        message: "A reference object must contain exactly one string field: $ref."
      });
      return undefined;
    }
    if (value.$ref.startsWith("content:")) return loadContentRef(value.$ref, pointer, ctx);
    if (value.$ref.startsWith("navigation:")) return loadNavigationRef(value.$ref, pointer, ctx);
    if (value.$ref.startsWith("param:")) return loadParamRef(value.$ref, pointer, ctx);
    if (value.$ref.startsWith("entry:")) return loadEntryRef(value.$ref, pointer, ctx);
    if (value.$ref.startsWith("query:")) return loadQueryRef(value.$ref, pointer, ctx);

    ctx.diagnostics.push({
      code: "REFERENCE_NAMESPACE_UNSUPPORTED",
      severity: "error",
      file: ctx.pageFile,
      page: ctx.page,
      section: ctx.section,
      path: pointer,
      message: `Unsupported reference "${value.$ref}". Supported prop references are content:, navigation:, param:, entry:, and query:.`,
      expected: "content:<path>, navigation:<collection>, param:<name>, entry:<field>, or query:<id>.<field>",
      actual: value.$ref
    });
    return undefined;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = await resolveRefs(child, `${pointer}/${escapePointer(key)}`, ctx);
  }
  return out;
}

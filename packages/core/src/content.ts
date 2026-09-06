import { readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { compilePropsSchema, validateCollectionSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { fileExists, listDirs, listFiles, parseDataFile } from "./fs.js";
import { parseMarkdown } from "./markdown.js";
import type {
  CollectionManifest,
  ContentEntry,
  Diagnostic,
  LoadedContentCollection
} from "./types.js";

const ENTRY_ID = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function entryId(collectionDir: string, file: string): string {
  return relative(collectionDir, file)
    .replaceAll("\\", "/")
    .replace(/\.(?:md|ya?ml|json)$/i, "");
}

function entryFile(file: string): boolean {
  const name = basename(file).toLowerCase();
  return name !== "collection.yaml" && name !== "collection.yml" && name !== "collection.json";
}

function systemValue(data: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
}

function userData(data: Record<string, unknown>): Record<string, unknown> {
  const { slug: _slug, date: _date, status: _status, ...rest } = data;
  return rest;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

async function parseEntry(root: string, collectionId: string, collectionDir: string, file: string): Promise<{ entry?: ContentEntry; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const relFile = relative(root, file).replaceAll("\\", "/");
  const id = entryId(collectionDir, file);
  if (!ENTRY_ID.test(id)) {
    diagnostics.push({
      code: "CONTENT_ENTRY_ID_INVALID", severity: "error", file: relFile,
      message: `Content entry id "${id}" must use lowercase letters, digits, hyphens, and optional / path segments.`,
      expected: "lowercase id path", actual: id
    });
    return { diagnostics };
  }

  let raw: Record<string, unknown>;
  let body: ContentEntry["body"];
  if (extname(file).toLowerCase() === ".md") {
    try {
      const source = await readFile(file, "utf8");
      const parsed = parseMarkdown(source);
      raw = parsed.data;
      body = { format: "markdown", source: parsed.body, html: parsed.html };
    } catch (error) {
      diagnostics.push({
        code: "CONTENT_MARKDOWN_INVALID", severity: "error", file: relFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return { diagnostics };
    }
  } else {
    const parsed = await parseDataFile<unknown>(root, file);
    if (parsed.diagnostic) return { diagnostics: [parsed.diagnostic] };
    if (!isPlainObject(parsed.value)) {
      diagnostics.push({
        code: "CONTENT_ENTRY_OBJECT_REQUIRED", severity: "error", file: relFile,
        message: "YAML and JSON content entries must contain an object at the document root.",
        expected: "object", actual: Array.isArray(parsed.value) ? "array" : typeof parsed.value
      });
      return { diagnostics };
    }
    raw = parsed.value;
  }

  const fallbackSlug = id.split("/").at(-1)!;
  const slugValue = systemValue(raw, "slug") ?? fallbackSlug;
  if (typeof slugValue !== "string" || !SLUG.test(slugValue)) {
    diagnostics.push({
      code: "CONTENT_SLUG_INVALID", severity: "error", file: relFile, path: "/slug",
      message: `Content slug must be a lowercase kebab-case route segment.`,
      expected: "lowercase-kebab-case", actual: slugValue
    });
  }

  const statusValue = systemValue(raw, "status") ?? "published";
  if (statusValue !== "draft" && statusValue !== "published") {
    diagnostics.push({
      code: "CONTENT_STATUS_INVALID", severity: "error", file: relFile, path: "/status",
      message: `Content status must be "draft" or "published".`,
      expected: ["draft", "published"], actual: statusValue
    });
  }

  const dateValue = systemValue(raw, "date");
  if (dateValue !== undefined && (typeof dateValue !== "string" || !validDate(dateValue))) {
    diagnostics.push({
      code: "CONTENT_DATE_INVALID", severity: "error", file: relFile, path: "/date",
      message: "Content date must be an ISO date or datetime string.",
      expected: "YYYY-MM-DD or ISO datetime", actual: dateValue
    });
  }

  if (diagnostics.some(item => item.severity === "error")) return { diagnostics };
  return {
    entry: {
      collection: collectionId,
      id,
      slug: slugValue as string,
      date: dateValue as string | undefined,
      status: statusValue as "draft" | "published",
      data: userData(raw),
      body,
      source: relFile
    },
    diagnostics
  };
}

export async function loadContentCollections(root: string): Promise<{
  collections: LoadedContentCollection[];
  registry: Map<string, LoadedContentCollection>;
  diagnostics: Diagnostic[];
}> {
  const diagnostics: Diagnostic[] = [];
  const collections: LoadedContentCollection[] = [];
  const registry = new Map<string, LoadedContentCollection>();
  const contentRoot = join(root, "content");

  for (const dir of await listDirs(contentRoot)) {
    const candidates = [join(dir, "collection.yaml"), join(dir, "collection.yml"), join(dir, "collection.json")];
    const existing: string[] = [];
    for (const candidate of candidates) if (await fileExists(candidate)) existing.push(candidate);
    if (existing.length === 0) continue;
    if (existing.length > 1) {
      diagnostics.push({
        code: "CONTENT_COLLECTION_MANIFEST_AMBIGUOUS", severity: "error",
        file: relative(root, dir).replaceAll("\\", "/"),
        message: "A content collection may have only one collection.yaml, collection.yml, or collection.json manifest.",
        actual: existing.map(file => relative(root, file).replaceAll("\\", "/"))
      });
      continue;
    }

    const manifestFile = existing[0]!;
    const relManifest = relative(root, manifestFile).replaceAll("\\", "/");
    const parsed = await parseDataFile<CollectionManifest>(root, manifestFile);
    if (parsed.diagnostic) { diagnostics.push(parsed.diagnostic); continue; }
    const manifest = parsed.value;
    if (!manifest || !validateCollectionSchema(manifest)) {
      diagnostics.push(...schemaDiagnostics("CONTENT_COLLECTION_SCHEMA_INVALID", relManifest, validateCollectionSchema.errors));
      continue;
    }

    const dirName = basename(dir);
    if (manifest.collection.id !== dirName) {
      diagnostics.push({
        code: "CONTENT_COLLECTION_ID_DIRECTORY_MISMATCH", severity: "error", file: relManifest,
        message: `Collection id "${manifest.collection.id}" must match directory "${dirName}".`,
        expected: dirName, actual: manifest.collection.id
      });
      continue;
    }
    if (registry.has(manifest.collection.id)) {
      diagnostics.push({
        code: "CONTENT_COLLECTION_ID_DUPLICATE", severity: "error", file: relManifest,
        message: `Duplicate content collection id "${manifest.collection.id}".`
      });
      continue;
    }

    let validateEntry;
    try {
      validateEntry = compilePropsSchema(manifest.entry.schema);
    } catch (error) {
      diagnostics.push({
        code: "CONTENT_ENTRY_SCHEMA_DEFINITION_INVALID", severity: "error", file: relManifest, path: "/entry/schema",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const entries: ContentEntry[] = [];
    const seenIds = new Set<string>();
    const seenSlugs = new Map<string, string>();
    for (const file of (await listFiles(dir, [".md", ".yaml", ".yml", ".json"])).filter(entryFile)) {
      const parsedEntry = await parseEntry(root, manifest.collection.id, dir, file);
      diagnostics.push(...parsedEntry.diagnostics);
      if (!parsedEntry.entry) continue;
      const entry = parsedEntry.entry;
      if (seenIds.has(entry.id)) {
        diagnostics.push({ code: "CONTENT_ENTRY_ID_DUPLICATE", severity: "error", file: entry.source, message: `Duplicate content entry id "${entry.id}".` });
        continue;
      }
      seenIds.add(entry.id);
      const slugOwner = seenSlugs.get(entry.slug);
      if (slugOwner) diagnostics.push({
        code: "CONTENT_SLUG_DUPLICATE", severity: "error", file: entry.source, path: "/slug",
        message: `Content slug "${entry.slug}" is already used by ${slugOwner}.`, actual: entry.slug
      }); else seenSlugs.set(entry.slug, entry.source);

      if (!validateEntry(entry.data)) {
        diagnostics.push(...schemaDiagnostics("CONTENT_ENTRY_SCHEMA_INVALID", entry.source, validateEntry.errors));
      }
      entries.push(entry);
    }

    const loaded: LoadedContentCollection = { file: relManifest, dir: relative(root, dir).replaceAll("\\", "/"), value: manifest, entries, validateEntry };
    collections.push(loaded);
    registry.set(manifest.collection.id, loaded);
  }

  return { collections, registry, diagnostics };
}

export function validateContentRelations(collections: LoadedContentCollection[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const registry = new Map(collections.map(collection => [collection.value.collection.id, collection]));
  for (const collection of collections) {
    for (const [field, relation] of Object.entries(collection.value.relations ?? {})) {
      const target = registry.get(relation.collection);
      if (!target) {
        diagnostics.push({
          code: "CONTENT_RELATION_COLLECTION_NOT_FOUND", severity: "error", file: collection.file,
          path: `/relations/${field}/collection`,
          message: `Relation "${field}" targets unknown collection "${relation.collection}".`,
          expected: [...registry.keys()].sort(), actual: relation.collection
        });
        continue;
      }
      const targetIds = new Set(target.entries.map(entry => entry.id));
      for (const entry of collection.entries) {
        const value = entry.data[field];
        if (value === undefined || value === null) continue;
        const ids = relation.many ? (Array.isArray(value) ? value : undefined) : (!Array.isArray(value) ? [value] : undefined);
        if (!ids || ids.some(id => typeof id !== "string")) {
          diagnostics.push({
            code: "CONTENT_RELATION_TYPE_INVALID", severity: "error", file: entry.source, path: `/${field}`,
            message: relation.many
              ? `Relation "${field}" must be an array of entry ids.`
              : `Relation "${field}" must be a single entry id.`,
            expected: relation.many ? "string[]" : "string", actual: value
          });
          continue;
        }
        for (const id of ids as string[]) {
          if (!targetIds.has(id)) diagnostics.push({
            code: "CONTENT_RELATION_NOT_FOUND", severity: "error", file: entry.source, path: `/${field}`,
            message: `Relation "${field}" references missing ${relation.collection}/${id}.`,
            expected: `existing entry in ${relation.collection}`, actual: id,
            allowed: [...targetIds].sort()
          });
        }
      }
    }
  }
  return diagnostics;
}

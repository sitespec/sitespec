import { materializeRoute, routeParamNames } from "./routes.js";
import type {
  ContentEntry,
  Diagnostic,
  LoadedContentCollection,
  ResolvedContentQuery,
  SourceContentFilter,
  SourceContentFilterValue,
  SourceContentQuery,
  RouteParams
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function valueAtPath(value: unknown, path: string): unknown {
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

export function contentEntryRecord(entry: ContentEntry): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ...entry.data,
    id: entry.id,
    slug: entry.slug,
    status: entry.status
  };
  if (entry.date !== undefined) record.date = entry.date;
  if (entry.body !== undefined) record.body = entry.body;
  if (entry.href !== undefined) record.href = entry.href;
  return record;
}

function shallowEntry(entry: ContentEntry): Record<string, unknown> {
  return contentEntryRecord(entry);
}

export function resolvedContentEntry(
  registry: Map<string, LoadedContentCollection>,
  entry: ContentEntry
): Record<string, unknown> {
  const result = shallowEntry(entry);
  const collection = registry.get(entry.collection);
  for (const [field, relation] of Object.entries(collection?.value.relations ?? {})) {
    const target = registry.get(relation.collection);
    if (!target) continue;
    const byId = new Map(target.entries.map(item => [item.id, item]));
    const raw = entry.data[field];
    if (relation.many) {
      if (Array.isArray(raw)) result[field] = raw
        .map(id => typeof id === "string" ? byId.get(id) : undefined)
        .filter((item): item is ContentEntry => !!item)
        .map(shallowEntry);
    } else if (typeof raw === "string") {
      const related = byId.get(raw);
      if (related) result[field] = shallowEntry(related);
    }
  }
  return result;
}

function resolveFilterValue(value: SourceContentFilterValue, contextEntry?: ContentEntry): unknown {
  if (!isPlainObject(value) || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith("entry:") || !contextEntry) return undefined;
  return valueAtPath(contentEntryRecord(contextEntry), value.$ref.slice("entry:".length));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b) || isPlainObject(a) || isPlainObject(b)) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return Object.is(a, b);
}

function compareOrdered(left: unknown, right: unknown): number | undefined {
  if (typeof left === "number" && typeof right === "number") return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left === "string" && typeof right === "string") return left === right ? 0 : left < right ? -1 : 1;
  return undefined;
}

function matchesFilter(entry: ContentEntry, filter: SourceContentFilter, contextEntry?: ContentEntry): boolean {
  const record = contentEntryRecord(entry);
  const left = valueAtPath(record, filter.field);
  const operators = ["eq", "ne", "in", "contains", "gt", "gte", "lt", "lte"] as const;
  const operator = operators.find(candidate => Object.prototype.hasOwnProperty.call(filter, candidate));
  if (!operator) return false;
  const right = resolveFilterValue(filter[operator]!, contextEntry);

  switch (operator) {
    case "eq": return sameValue(left, right);
    case "ne": return !sameValue(left, right);
    case "contains":
      if (Array.isArray(left)) return left.some(item => sameValue(item, right));
      if (typeof left === "string" && typeof right === "string") return left.includes(right);
      return false;
    case "in":
      if (!Array.isArray(right)) return false;
      if (Array.isArray(left)) return left.some(item => right.some(candidate => sameValue(item, candidate)));
      return right.some(candidate => sameValue(left, candidate));
    case "gt": { const result = compareOrdered(left, right); return result !== undefined && result > 0; }
    case "gte": { const result = compareOrdered(left, right); return result !== undefined && result >= 0; }
    case "lt": { const result = compareOrdered(left, right); return result !== undefined && result < 0; }
    case "lte": { const result = compareOrdered(left, right); return result !== undefined && result <= 0; }
  }
}

function compareSortValue(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b));
}

export interface ContentQueryRunOptions {
  registry: Map<string, LoadedContentCollection>;
  queryId: string;
  query: SourceContentQuery;
  contextEntry?: ContentEntry;
  currentPage?: number;
  firstHref: string;
  params: RouteParams;
}

export function runContentQuery(options: ContentQueryRunOptions): { result?: ResolvedContentQuery; diagnostics: Diagnostic[]; totalPages: number } {
  const diagnostics: Diagnostic[] = [];
  const collection = options.registry.get(options.query.collection);
  if (!collection) {
    diagnostics.push({
      code: "CONTENT_QUERY_COLLECTION_NOT_FOUND", severity: "error",
      message: `Content query "${options.queryId}" targets unknown collection "${options.query.collection}".`,
      expected: [...options.registry.keys()].sort(), actual: options.query.collection
    });
    return { diagnostics, totalPages: 1 };
  }

  let entries = collection.entries.filter(entry => entry.status === "published");
  for (const filter of options.query.filter ?? []) entries = entries.filter(entry => matchesFilter(entry, filter, options.contextEntry));

  const sorts = options.query.sort ?? [];
  entries = [...entries].sort((a, b) => {
    const left = contentEntryRecord(a);
    const right = contentEntryRecord(b);
    for (const sort of sorts) {
      const comparison = compareSortValue(valueAtPath(left, sort.field), valueAtPath(right, sort.field));
      if (comparison !== 0) return sort.order === "desc" ? -comparison : comparison;
    }
    return a.id.localeCompare(b.id);
  });

  let pageEntries = entries;
  let pagination: ResolvedContentQuery["pagination"];
  let totalPages = 1;
  if (options.query.paginate) {
    totalPages = Math.max(1, Math.ceil(entries.length / options.query.paginate.size));
    const currentPage = options.currentPage ?? 1;
    if (currentPage < 1 || currentPage > totalPages) {
      diagnostics.push({
        code: "CONTENT_QUERY_PAGE_OUT_OF_RANGE", severity: "error",
        message: `Content query "${options.queryId}" requested page ${currentPage}, but has ${totalPages} page(s).`,
        expected: { minimum: 1, maximum: totalPages }, actual: currentPage
      });
    }
    const start = Math.max(0, currentPage - 1) * options.query.paginate.size;
    pageEntries = entries.slice(start, start + options.query.paginate.size);
    const pageHref = (page: number): string => {
      if (page === 1) return options.firstHref;
      return materializeRoute(options.query.paginate!.route, { ...options.params, page: String(page) });
    };
    pagination = {
      currentPage,
      totalPages,
      ...(currentPage > 1 ? { previousHref: pageHref(currentPage - 1) } : {}),
      ...(currentPage < totalPages ? { nextHref: pageHref(currentPage + 1) } : {}),
      pages: Array.from({ length: totalPages }, (_, index) => {
        const page = index + 1;
        return { page, href: pageHref(page), current: page === currentPage };
      })
    };
  }

  return {
    result: {
      items: pageEntries.map(entry => resolvedContentEntry(options.registry, entry)),
      ...(pagination ? { pagination } : {})
    },
    diagnostics,
    totalPages
  };
}

export function validatePaginationRoute(queryId: string, query: SourceContentQuery, baseParams: string[]): Diagnostic[] {
  if (!query.paginate) return [];
  const names = routeParamNames(query.paginate.route);
  const missingPage = !names.includes("page");
  const extra = names.filter(name => name !== "page" && !baseParams.includes(name));
  const diagnostics: Diagnostic[] = [];
  if (missingPage || extra.length > 0) diagnostics.push({
    code: "CONTENT_PAGINATION_ROUTE_INVALID", severity: "error",
    path: `/content/queries/${queryId}/paginate/route`,
    message: `Pagination route must contain [page] and may otherwise use only page route parameters.`,
    expected: [...baseParams, "page"], actual: names,
    details: { missingPage, extra }
  });
  return diagnostics;
}

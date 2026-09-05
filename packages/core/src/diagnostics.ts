import type { ErrorObject } from "ajv";
import type { Diagnostic, Origin } from "./types.js";

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some(d => d.severity === "error");
}

export function schemaDiagnostics(
  code: string,
  file: string,
  errors: ErrorObject[] | null | undefined,
  context: Partial<Diagnostic> = {}
): Diagnostic[] {
  return (errors ?? []).map(error => {
    const additional = error.keyword === "additionalProperties"
      ? String((error.params as { additionalProperty?: string }).additionalProperty ?? "")
      : undefined;
    const missing = error.keyword === "required"
      ? String((error.params as { missingProperty?: string }).missingProperty ?? "")
      : undefined;
    const path = additional
      ? `${error.instancePath}/${escapePointer(additional)}`
      : missing
        ? `${error.instancePath}/${escapePointer(missing)}` || "/"
        : error.instancePath || "/";
    return {
      code,
      severity: "error",
      file,
      path,
      message: additional
        ? `Unknown field "${additional}".`
        : missing
          ? `Required field "${missing}" is missing.`
          : `${path} ${error.message ?? "is invalid"}`,
      ...(missing ? {
        expected: "required field",
        actual: undefined,
        suggestions: [{ action: "add-field", field: path }]
      } : {}),
      ...context
    };
  });
}

export function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function findOrigin(provenance: Map<string, Origin>, pointer: string): Origin | undefined {
  let current = pointer || "/";
  while (true) {
    const found = provenance.get(current);
    if (found) return found;
    if (current === "/" || current === "") return undefined;
    const index = current.lastIndexOf("/");
    current = index <= 0 ? "/" : current.slice(0, index);
  }
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j < current.length; j++) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}

export function nearestStrings(value: string, candidates: string[], limit = 3): string[] {
  return [...candidates]
    .map(candidate => ({ candidate, distance: editDistance(value, candidate) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map(item => item.candidate);
}

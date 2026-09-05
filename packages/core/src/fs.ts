import { readFile, readdir, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { parseDocument } from "yaml";
import type { Diagnostic } from "./types.js";

export async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function dirExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  if (!(await dirExists(dir))) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await listFiles(path, extensions));
    else if (extensions.includes(extname(entry.name))) out.push(path);
  }
  return out.sort();
}

export async function listDirs(dir: string): Promise<string[]> {
  if (!(await dirExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => `${dir}/${e.name}`).sort();
}

export async function parseDataFile<T>(root: string, file: string): Promise<{ value?: T; diagnostic?: Diagnostic }> {
  try {
    const text = await readFile(file, "utf8");
    const ext = extname(file);
    let value: unknown;
    if (ext === ".json") {
      value = JSON.parse(text);
    } else {
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join("; "));
      value = doc.toJS();
    }
    return { value: value as T };
  } catch (error) {
    return {
      diagnostic: {
        code: "SPEC_PARSE_ERROR",
        severity: "error",
        file: relative(root, file),
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const BUILD_STATE_VERSION = "0.2" as const;

const SOURCE_ENTRIES = [
  "site.yaml",
  "pages",
  "content",
  "sections",
  "components",
  "ui",
  "shell",
  "design",
  "public"
] as const;

export interface SourceFingerprint {
  hash: string;
  files: string[];
}

export interface BuildState {
  version: typeof BUILD_STATE_VERSION;
  sourceHash: string;
  sourceFiles: number;
  pages: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function walk(root: string, path: string, out: string[]): Promise<void> {
  const info = await stat(path);
  if (info.isFile()) {
    out.push(relative(root, path).replaceAll("\\", "/"));
    return;
  }
  if (!info.isDirectory()) return;

  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    await walk(root, join(path, entry.name), out);
  }
}

export async function computeSourceFingerprint(rootInput: string): Promise<SourceFingerprint> {
  const root = resolve(rootInput);
  const files: string[] = [];

  for (const entry of SOURCE_ENTRIES) {
    const path = join(root, entry);
    if (await exists(path)) await walk(root, path, files);
  }

  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(join(root, file));
    hash.update(file, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }

  return { hash: hash.digest("hex"), files };
}

export async function writeBuildState(rootInput: string, pages: string[]): Promise<BuildState> {
  const root = resolve(rootInput);
  const fingerprint = await computeSourceFingerprint(root);
  const state: BuildState = {
    version: BUILD_STATE_VERSION,
    sourceHash: fingerprint.hash,
    sourceFiles: fingerprint.files.length,
    pages: [...pages].sort((a, b) => a.localeCompare(b))
  };
  const file = join(root, ".site", "build.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

export async function readBuildState(rootInput: string): Promise<BuildState | undefined> {
  const root = resolve(rootInput);
  try {
    const parsed = JSON.parse(await readFile(join(root, ".site", "build.json"), "utf8")) as Partial<BuildState>;
    if (
      parsed.version !== BUILD_STATE_VERSION ||
      typeof parsed.sourceHash !== "string" ||
      typeof parsed.sourceFiles !== "number" ||
      !Array.isArray(parsed.pages) ||
      !parsed.pages.every(page => typeof page === "string")
    ) {
      return undefined;
    }
    return parsed as BuildState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function isBuildFresh(rootInput: string): Promise<{ fresh: boolean; state?: BuildState; current?: SourceFingerprint }> {
  const state = await readBuildState(rootInput);
  if (!state) return { fresh: false };
  const current = await computeSourceFingerprint(rootInput);
  return { fresh: current.hash === state.sourceHash, state, current };
}

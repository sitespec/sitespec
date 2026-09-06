import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readProjectSpecVersion } from "./project-spec-version.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ROLES = new Set(["layout", "action", "content", "navigation", "feedback", "media", "typography"]);

export interface AddUiOptions {
  root: string;
  id: string;
  role?: string;
}

export interface AddUiResult {
  root: string;
  id: string;
  role: string;
  files: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function write(root: string, path: string, content: string, files: string[]): Promise<void> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  files.push(path);
}

function uiManifest(id: string, role: string, specVersion: "0.2" | "0.3" | "0.4" | "0.5"): string {
  return `specVersion: "${specVersion}"\n\nui:\n  id: ${id}\n  role: ${role}\n\ndescription: ${JSON.stringify(`${id} UI primitive.`)}\n\nvariants:\n  - default\n\nprops:\n  type: object\n  additionalProperties: false\n  properties: {}\n\nruntime:\n  javascript: false\n`;
}

function uiAstro(id: string): string {
  return `---\ninterface Props { variant?: string }\nconst { variant = "default" } = Astro.props;\n---\n<div data-ui="${id}" data-variant={variant}>\n  <slot />\n</div>\n\n<style>\n  div { color: var(--color-text-default); }\n</style>\n`;
}

export async function addUi(options: AddUiOptions): Promise<AddUiResult> {
  const root = resolve(options.root);
  const id = options.id.trim();
  const role = options.role?.trim() || "content";
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid UI id "${id}". Use lowercase letters, digits, and hyphens; start with a letter.`);
  if (!ROLES.has(role)) throw new Error(`Invalid UI role "${role}". Use one of: ${[...ROLES].join(", ")}.`);
  if (!(await fileExists(join(root, "site.yaml")))) throw new Error(`site.yaml was not found in ${root}.`);
  const specVersion = await readProjectSpecVersion(root);
  if (specVersion === "0.1") {
    throw new Error(`UI primitives require specVersion: "0.2" or newer. Upgrade site.yaml before running sitespec add ui.`);
  }

  const dir = join(root, "ui", id);
  try {
    const entries = await readdir(dir);
    if (entries.length >= 0) throw new Error(`UI primitive "${id}" already exists at ui/${id}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const files: string[] = [];
  await write(root, `ui/${id}/ui.yaml`, uiManifest(id, role, specVersion), files);
  await write(root, `ui/${id}/index.astro`, uiAstro(id), files);
  return { root, id, role, files };
}

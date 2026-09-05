import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CreateDefaultSiteOptions {
  directory: string;
  name?: string;
  cliVersion: string;
}

export interface CreateDefaultSiteResult {
  root: string;
  id: string;
  name: string;
  files: string[];
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!slug) return "site";
  return /^[a-z]/.test(slug) ? slug : `site-${slug}`;
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Site";
}

function templateRoot(): string {
  return fileURLToPath(new URL("../template/", import.meta.url));
}

function renderTemplate(value: string, replacements: Record<string, string>): string {
  let rendered = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(replacement);
  }
  return rendered;
}

async function copyTemplateDirectory(
  source: string,
  target: string,
  prefix: string,
  replacements: Record<string, string>,
  files: string[]
): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const outputName = entry.name === "_gitignore" ? ".gitignore" : entry.name;
    const relativePath = prefix ? `${prefix}/${outputName}` : outputName;
    const targetPath = join(target, outputName);

    if (entry.isDirectory()) {
      await copyTemplateDirectory(sourcePath, targetPath, relativePath, replacements, files);
      continue;
    }
    if (!entry.isFile()) continue;

    const contents = await readFile(sourcePath);
    await mkdir(dirname(targetPath), { recursive: true });
    const extension = extname(entry.name).toLowerCase();
    const textFile = extension === "" || [".md", ".yaml", ".yml", ".json", ".astro", ".ts", ".js", ".css", ".svg", ".txt"].includes(extension);
    if (textFile) {
      await writeFile(targetPath, renderTemplate(contents.toString("utf8"), replacements), "utf8");
    } else {
      await writeFile(targetPath, contents);
    }
    files.push(relativePath);
  }
}

export async function createDefaultSite(options: CreateDefaultSiteOptions): Promise<CreateDefaultSiteResult> {
  const root = resolve(options.directory);
  await mkdir(root, { recursive: true });
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new Error(`Cannot initialize Site Spec in non-empty directory: ${root}`);
  }

  const id = slugify(basename(root));
  const name = options.name?.trim() || titleize(id);
  const cliVersion = options.cliVersion;
  const files: string[] = [];

  await copyTemplateDirectory(templateRoot(), root, "", {
    "__SITE_ID__": id,
    "__SITE_NAME__": name,
    "__CLI_VERSION__": cliVersion
  }, files);

  files.sort((a, b) => a.localeCompare(b));
  return { root, id, name, files };
}

import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inspectDesignSystem, loadDesignSystemContract } from "@sitespec/core";
import { readProjectSpecVersion } from "./project-spec-version.js";

export interface PackDesignSystemOptions {
  root: string;
  directory: string;
}

export interface InstallDesignSystemOptions {
  root: string;
  source: string;
  replace?: boolean;
  force?: boolean;
}

export interface DesignSystemCopyResult {
  id: string;
  version: string;
  root: string;
  files: string[];
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function listFilesRecursive(root: string, relativeRoot: string): Promise<string[]> {
  const absolute = join(root, relativeRoot);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${relativeRoot}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) files.push(...await listFilesRecursive(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

async function presetFile(root: string, id: string): Promise<string | undefined> {
  for (const extension of [".yaml", ".yml"]) {
    const file = `sections/${id}${extension}`;
    if (await exists(join(root, file))) return file;
  }
  return undefined;
}

async function designSystemFiles(root: string): Promise<string[]> {
  const loaded = await loadDesignSystemContract(root);
  const manifest = loaded.designSystem?.value;
  if (!manifest) throw new Error("design-system.yaml was not found or is invalid.");
  const files = new Set<string>([
    "design-system.yaml",
    manifest.tokens.source,
    manifest.fonts.source
  ]);

  for (const theme of Object.values(manifest.themes.items)) if (theme.source) files.add(theme.source);
  for (const id of manifest.libraries.ui) for (const file of await listFilesRecursive(root, `ui/${id}`)) files.add(file);
  for (const id of manifest.libraries.sections) for (const file of await listFilesRecursive(root, `components/${id}`)) files.add(file);
  for (const id of manifest.libraries.presets) {
    const file = await presetFile(root, id);
    if (file) files.add(file);
  }
  for (const shell of Object.values(manifest.shells.items)) {
    files.add(shell.entry);
    shell.files.forEach(file => files.add(file));
  }
  for (const file of await listFilesRecursive(root, manifest.fonts.assetsRoot)) files.add(file);
  return [...files].sort();
}

async function copyFiles(sourceRoot: string, targetRoot: string, files: string[]): Promise<void> {
  for (const file of files) {
    const source = join(sourceRoot, file);
    const target = join(targetRoot, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function assertEmptyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) throw new Error(`Design System pack target must be empty: ${directory}`);
}

function packError(diagnostics: Array<{ code: string; message: string }>): Error {
  const summary = diagnostics.slice(0, 5).map(item => `${item.code}: ${item.message}`).join("; ");
  return new Error(`Design System pack is invalid${summary ? `: ${summary}` : "."}`);
}

export async function packDesignSystem(options: PackDesignSystemOptions): Promise<DesignSystemCopyResult> {
  const root = resolve(options.root);
  const directory = resolve(options.directory);
  const inspection = await inspectDesignSystem(root);
  if (!inspection.valid) throw packError(inspection.diagnostics);
  const loaded = await loadDesignSystemContract(root);
  const manifest = loaded.designSystem!.value;
  const files = await designSystemFiles(root);
  await assertEmptyDirectory(directory);
  try {
    await copyFiles(root, directory, files);
    const packedInspection = await inspectDesignSystem(directory);
    if (!packedInspection.valid) throw packError(packedInspection.diagnostics);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { id: manifest.designSystem.id, version: manifest.designSystem.version, root: directory, files };
}

async function removeManagedDesignSystem(root: string): Promise<void> {
  const loaded = await loadDesignSystemContract(root);
  const manifest = loaded.designSystem?.value;
  if (!manifest) throw new Error("--replace requires an existing valid design-system.yaml. Use --force only when intentionally overwriting an unmanaged v0.4 design system.");

  for (const id of manifest.libraries.ui) await rm(join(root, "ui", id), { recursive: true, force: true });
  for (const id of manifest.libraries.sections) await rm(join(root, "components", id), { recursive: true, force: true });
  for (const id of manifest.libraries.presets) {
    for (const extension of [".yaml", ".yml"]) await rm(join(root, `sections/${id}${extension}`), { force: true });
  }
  for (const shell of Object.values(manifest.shells.items)) {
    for (const file of new Set([shell.entry, ...shell.files])) await rm(join(root, file), { force: true });
  }
  for (const theme of Object.values(manifest.themes.items)) if (theme.source) await rm(join(root, theme.source), { force: true });
  await rm(join(root, manifest.fonts.assetsRoot), { recursive: true, force: true });
  await rm(join(root, manifest.tokens.source), { force: true });
  await rm(join(root, manifest.fonts.source), { force: true });
  await rm(join(root, "design-system.yaml"), { force: true });
  // design/extensions.json is intentionally site-owned and survives a pack replacement.
}

interface ManagedDesignSystemPaths {
  exact: Set<string>;
  roots: string[];
}

async function managedDesignSystemPaths(root: string): Promise<ManagedDesignSystemPaths> {
  const loaded = await loadDesignSystemContract(root);
  const manifest = loaded.designSystem?.value;
  if (!manifest) throw new Error("--replace requires an existing valid design-system.yaml. Use --force only when intentionally overwriting an unmanaged v0.4 design system.");

  const exact = new Set<string>([
    "design-system.yaml",
    manifest.tokens.source,
    manifest.fonts.source
  ]);
  for (const id of manifest.libraries.presets) {
    exact.add(`sections/${id}.yaml`);
    exact.add(`sections/${id}.yml`);
  }
  for (const shell of Object.values(manifest.shells.items)) {
    exact.add(shell.entry);
    shell.files.forEach(file => exact.add(file));
  }
  for (const theme of Object.values(manifest.themes.items)) if (theme.source) exact.add(theme.source);

  return {
    exact,
    roots: [
      ...manifest.libraries.ui.map(id => `ui/${id}`),
      ...manifest.libraries.sections.map(id => `components/${id}`),
      manifest.fonts.assetsRoot
    ]
  };
}

function isManagedPath(file: string, managed?: ManagedDesignSystemPaths): boolean {
  if (!managed) return false;
  if (managed.exact.has(file)) return true;
  return managed.roots.some(root => file === root || file.startsWith(`${root}/`));
}

async function assertNoCollisions(root: string, files: string[], managed?: ManagedDesignSystemPaths): Promise<void> {
  const collisions: string[] = [];
  for (const file of files) {
    if (isManagedPath(file, managed)) continue;
    if (await exists(join(root, file))) collisions.push(file);
  }
  if (collisions.length > 0) throw new Error(
    `Design System install would overwrite site-owned files: ${collisions.slice(0, 12).join(", ")}${collisions.length > 12 ? ", ..." : ""}. Use --replace for files owned by the current pack or --force for an intentional overwrite.`
  );
}

export async function installDesignSystem(options: InstallDesignSystemOptions): Promise<DesignSystemCopyResult> {
  const root = resolve(options.root);
  const source = resolve(options.source);
  if (!(await exists(join(root, "site.yaml")))) throw new Error(`site.yaml was not found in ${root}.`);
  const specVersion = await readProjectSpecVersion(root);
  if (specVersion !== "0.4") throw new Error(`Design System packs require a SiteSpec 0.4 project; ${root} uses ${specVersion}. Upgrade the project contract first.`);

  const inspection = await inspectDesignSystem(source);
  if (!inspection.valid) throw packError(inspection.diagnostics);
  const loaded = await loadDesignSystemContract(source);
  const manifest = loaded.designSystem!.value;
  const files = await designSystemFiles(source);

  const managed = options.replace ? await managedDesignSystemPaths(root) : undefined;
  if (!options.force) await assertNoCollisions(root, files, managed);
  if (options.replace) await removeManagedDesignSystem(root);
  await copyFiles(source, root, files);

  return { id: manifest.designSystem.id, version: manifest.designSystem.version, root, files };
}

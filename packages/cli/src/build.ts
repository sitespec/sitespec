import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadProject, validateLoadedProject, type Diagnostic } from "@sitespec/core";
import { buildAstroSite } from "@sitespec/astro";
import { writeBuildState } from "./build-state.js";

export interface BuildProjectResult {
  success: boolean;
  outDir: string;
  pages: string[];
  diagnostics: Diagnostic[];
}

export async function buildProject(rootInput: string): Promise<BuildProjectResult> {
  const root = await realpath(resolve(rootInput));
  const project = await loadProject(root);
  const validation = await validateLoadedProject(project);
  const outDir = join(root, "dist");
  if (!validation.valid || !validation.site) {
    return { success: false, outDir, pages: [], diagnostics: validation.diagnostics };
  }

  const siteDir = join(root, ".site");
  await mkdir(siteDir, { recursive: true });
  await writeFile(join(siteDir, "resolved.json"), `${JSON.stringify(validation.site, null, 2)}\n`, "utf8");

  const rendered = await buildAstroSite({ root, site: validation.site, registry: project.registry, outDir });
  if (rendered.success) await writeBuildState(root, rendered.pages);
  return {
    success: rendered.success,
    outDir: relative(root, rendered.outDir) || ".",
    pages: rendered.pages,
    diagnostics: [...validation.diagnostics, ...rendered.diagnostics]
  };
}

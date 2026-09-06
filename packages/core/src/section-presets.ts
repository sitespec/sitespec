import { join, relative } from "node:path";
import { validateSectionPresetSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { listFiles, parseDataFile } from "./fs.js";
import type { Diagnostic, LoadedSectionPreset, SectionPresetManifest } from "./types.js";

export async function loadSectionPresets(root: string): Promise<{
  presets: LoadedSectionPreset[];
  diagnostics: Diagnostic[];
}> {
  const diagnostics: Diagnostic[] = [];
  const presets: LoadedSectionPreset[] = [];
  const sectionsDir = join(root, "sections");
  const seen = new Map<string, string>();

  for (const file of await listFiles(sectionsDir, [".yaml", ".yml"])) {
    const relFile = relative(root, file).replaceAll("\\", "/");
    const logical = relative(sectionsDir, file)
      .replaceAll("\\", "/")
      .replace(/\.(?:ya?ml)$/i, "");
    if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(logical)) {
      diagnostics.push({
        code: "SECTION_PRESET_ID_INVALID",
        severity: "error",
        file: relFile,
        message: `Section preset path "${logical}" must use lowercase ids separated by /.`,
        expected: "lowercase-kebab-case[/lowercase-kebab-case]"
      });
      continue;
    }
    const parsed = await parseDataFile<SectionPresetManifest>(root, file);
    if (parsed.diagnostic) { diagnostics.push(parsed.diagnostic); continue; }
    const value = parsed.value!;
    if (!validateSectionPresetSchema(value)) {
      diagnostics.push(...schemaDiagnostics("SECTION_PRESET_SCHEMA_INVALID", relFile, validateSectionPresetSchema.errors));
      continue;
    }
    const existing = seen.get(logical);
    if (existing) {
      diagnostics.push({
        code: "SECTION_PRESET_DUPLICATE",
        severity: "error",
        file: relFile,
        message: `Section preset "${logical}" is already declared in ${existing}.`
      });
      continue;
    }
    seen.set(logical, relFile);
    presets.push({ file: relFile, id: logical, value });
  }

  return { presets, diagnostics };
}

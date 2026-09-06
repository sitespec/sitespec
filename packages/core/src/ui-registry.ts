import { basename, join, relative } from "node:path";
import { compilePropsSchema, validateUiSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { fileExists, listDirs, parseDataFile } from "./fs.js";
import type { Diagnostic, LoadedUiPrimitive, RegisteredUiPrimitive, UiManifest } from "./types.js";

export async function buildUiRegistry(root: string): Promise<{
  ui: LoadedUiPrimitive[];
  registry: Map<string, RegisteredUiPrimitive>;
  diagnostics: Diagnostic[];
}> {
  const ui: LoadedUiPrimitive[] = [];
  const registry = new Map<string, RegisteredUiPrimitive>();
  const diagnostics: Diagnostic[] = [];

  for (const dir of await listDirs(join(root, "ui"))) {
    const manifestFile = join(dir, "ui.yaml");
    if (!(await fileExists(manifestFile))) continue;
    const parsed = await parseDataFile<UiManifest>(root, manifestFile);
    if (parsed.diagnostic) { diagnostics.push(parsed.diagnostic); continue; }
    const manifest = parsed.value!;
    const relFile = relative(root, manifestFile).replaceAll("\\", "/");
    if (!validateUiSchema(manifest)) {
      diagnostics.push(...schemaDiagnostics("UI_SCHEMA_INVALID", relFile, validateUiSchema.errors));
      continue;
    }

    const dirName = basename(dir);
    ui.push({ file: relFile, dirName, value: manifest });
    if (manifest.ui.id !== dirName) {
      diagnostics.push({
        code: "UI_ID_DIRECTORY_MISMATCH",
        severity: "error",
        file: relFile,
        message: `UI primitive id "${manifest.ui.id}" must match directory "${dirName}".`,
        actual: manifest.ui.id,
        expected: dirName
      });
      continue;
    }
    if (registry.has(manifest.ui.id)) {
      diagnostics.push({
        code: "UI_ID_DUPLICATE",
        severity: "error",
        file: relFile,
        message: `Duplicate UI primitive id "${manifest.ui.id}".`
      });
      continue;
    }

    const variants = manifest.variants ?? ["default"];
    if (!variants.includes("default")) diagnostics.push({
      code: "UI_DEFAULT_VARIANT_MISSING",
      severity: "error",
      file: relFile,
      message: "UI primitive variants must contain \"default\"."
    });

    const implementation = `ui/${manifest.ui.id}/index.astro`;
    if (!(await fileExists(join(root, implementation)))) diagnostics.push({
      code: "UI_IMPLEMENTATION_MISSING",
      severity: "error",
      file: implementation,
      message: `Astro implementation for UI primitive "${manifest.ui.id}" was not found.`,
      suggestions: [{ action: "implement-ui", file: implementation }]
    });

    try {
      const validateProps = compilePropsSchema(manifest.props);
      registry.set(manifest.ui.id, {
        id: manifest.ui.id,
        role: manifest.ui.role,
        variants,
        manifest,
        validateProps,
        file: relFile,
        implementation
      });
    } catch (error) {
      diagnostics.push({
        code: "UI_PROPS_SCHEMA_INVALID",
        severity: "error",
        file: relFile,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { ui, registry, diagnostics };
}

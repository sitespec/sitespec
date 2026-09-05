import { basename, join, relative } from "node:path";
import { compilePropsSchema, validateComponentSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { fileExists, listDirs, parseDataFile } from "./fs.js";
import type { ComponentManifest, Diagnostic, LoadedComponent, RegisteredComponent } from "./types.js";

export async function buildRegistry(root: string): Promise<{
  components: LoadedComponent[];
  registry: Map<string, RegisteredComponent>;
  diagnostics: Diagnostic[];
}> {
  const components: LoadedComponent[] = [];
  const registry = new Map<string, RegisteredComponent>();
  const diagnostics: Diagnostic[] = [];
  const componentsDir = join(root, "components");

  for (const dir of await listDirs(componentsDir)) {
    const manifestFile = join(dir, "component.yaml");
    if (!(await fileExists(manifestFile))) continue;
    const parsed = await parseDataFile<ComponentManifest>(root, manifestFile);
    if (parsed.diagnostic) { diagnostics.push(parsed.diagnostic); continue; }
    const manifest = parsed.value!;
    const relFile = relative(root, manifestFile);

    if (!validateComponentSchema(manifest)) {
      diagnostics.push(...schemaDiagnostics("COMPONENT_SCHEMA_INVALID", relFile, validateComponentSchema.errors));
      continue;
    }

    const dirName = basename(dir);
    components.push({ file: relFile, dirName, value: manifest });

    if (manifest.component.id !== dirName) {
      diagnostics.push({
        code: "COMPONENT_ID_DIRECTORY_MISMATCH",
        severity: "error",
        file: relFile,
        component: manifest.component.id,
        message: `Component id "${manifest.component.id}" must match directory "${dirName}".`
      });
      continue;
    }

    if (registry.has(manifest.component.id)) {
      diagnostics.push({
        code: "COMPONENT_ID_DUPLICATE",
        severity: "error",
        file: relFile,
        component: manifest.component.id,
        message: `Duplicate component id "${manifest.component.id}".`
      });
      continue;
    }

    const variants = manifest.variants ?? ["default"];
    const themes = manifest.themes ?? ["default"];
    if (!variants.includes("default")) diagnostics.push({
      code: "COMPONENT_DEFAULT_VARIANT_MISSING", severity: "error", file: relFile,
      component: manifest.component.id, message: "variants must contain \"default\"."
    });
    if (!themes.includes("default")) diagnostics.push({
      code: "COMPONENT_DEFAULT_THEME_MISSING", severity: "error", file: relFile,
      component: manifest.component.id, message: "themes must contain \"default\"."
    });

    try {
      const validateProps = compilePropsSchema(manifest.props);
      registry.set(manifest.component.id, {
        id: manifest.component.id,
        role: manifest.component.role,
        variants,
        themes,
        manifest,
        validateProps,
        file: relFile
      });
    } catch (error) {
      diagnostics.push({
        code: "COMPONENT_PROPS_SCHEMA_INVALID",
        severity: "error",
        file: relFile,
        component: manifest.component.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { components, registry, diagnostics };
}

import { join } from "node:path";
import { validateDesignSystemSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { fileExists, parseDataFile } from "./fs.js";
import type { Diagnostic, DesignSystemManifest, LoadedDesignSystem } from "./types.js";

export async function loadDesignSystemContract(root: string): Promise<{
  designSystem?: LoadedDesignSystem;
  diagnostics: Diagnostic[];
}> {
  const file = join(root, "design-system.yaml");
  if (!(await fileExists(file))) return { diagnostics: [] };

  const parsed = await parseDataFile<DesignSystemManifest>(root, file);
  if (parsed.diagnostic) return { diagnostics: [parsed.diagnostic] };
  const value = parsed.value;
  if (value === undefined || !validateDesignSystemSchema(value)) {
    return {
      diagnostics: schemaDiagnostics(
        "DESIGN_SYSTEM_SCHEMA_INVALID",
        "design-system.yaml",
        validateDesignSystemSchema.errors
      )
    };
  }

  const diagnostics: Diagnostic[] = [];
  if (!(value.themes.default in value.themes.items)) {
    diagnostics.push({
      code: "DESIGN_SYSTEM_DEFAULT_THEME_UNKNOWN",
      severity: "error",
      file: "design-system.yaml",
      path: "/themes/default",
      message: `Default design-system theme "${value.themes.default}" is not declared in themes.items.`,
      actual: value.themes.default,
      allowed: Object.keys(value.themes.items).sort()
    });
  }
  if (!(value.shells.default in value.shells.items)) {
    diagnostics.push({
      code: "DESIGN_SYSTEM_DEFAULT_SHELL_UNKNOWN",
      severity: "error",
      file: "design-system.yaml",
      path: "/shells/default",
      message: `Default shell pack "${value.shells.default}" is not declared in shells.items.`,
      actual: value.shells.default,
      allowed: Object.keys(value.shells.items).sort()
    });
  }

  return { designSystem: { file: "design-system.yaml", value }, diagnostics };
}

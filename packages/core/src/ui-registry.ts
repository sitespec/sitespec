import { basename, join, relative } from "node:path";
import { compilePropsSchema, validateUiSchema } from "./ajv.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { fileExists, listDirs, parseDataFile } from "./fs.js";
import type { Diagnostic, LoadedUiPrimitive, RegisteredUiPrimitive, UiManifest, UiState } from "./types.js";

const REQUIRED_INTERACTIVE_STATES: UiState[] = ["default", "hover", "active", "focus-visible"];

function propsExposeDisabled(manifest: UiManifest): boolean {
  const props = manifest.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;
  const properties = (props as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  return Object.prototype.hasOwnProperty.call(properties, "disabled");
}

function expectedStates(manifest: UiManifest): UiState[] {
  const base = manifest.ui.role === "action" || manifest.ui.role === "navigation"
    ? [...REQUIRED_INTERACTIVE_STATES]
    : manifest.ui.role === "form"
      ? ["default", "hover", "focus-visible"] as UiState[]
      : ["default" as UiState];
  if (propsExposeDisabled(manifest)) base.push("disabled");
  return base;
}

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

    const states = manifest.states ?? ["default"];
    if (!states.includes("default")) diagnostics.push({
      code: "UI_DEFAULT_STATE_MISSING",
      severity: "error",
      file: relFile,
      message: "UI primitive states must contain \"default\"."
    });

    const expected = expectedStates(manifest);
    const missingStates = expected.filter(state => !states.includes(state));
    if (missingStates.length > 0) diagnostics.push({
      code: "UI_INTERACTIVE_STATES_INCOMPLETE",
      severity: "warning",
      file: relFile,
      message: `UI primitive "${manifest.ui.id}" does not declare all expected interaction states.`,
      expected,
      actual: states,
      details: { missingStates },
      suggestions: [{
        action: "define-ui-states",
        file: relFile,
        field: "states",
        value: expected,
        message: "Declare only interaction states that are intentionally implemented; migration must not invent unobserved states."
      }]
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
        states,
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

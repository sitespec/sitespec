import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectDesign, validateDesign } from "./design.js";
import { fileExists } from "./fs.js";
import { buildRegistry } from "./registry.js";
import { buildUiRegistry } from "./ui-registry.js";
import { loadSectionPresets } from "./section-presets.js";
import { loadDesignSystemContract } from "./design-system-contract.js";
import type { Diagnostic, DesignSystemManifest } from "./types.js";

export interface DesignSystemInspectionResult {
  valid: boolean;
  type: "design-system";
  source: "design-system.yaml";
  designSystem?: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter(diagnostic => {
    const key = JSON.stringify([
      diagnostic.code,
      diagnostic.file,
      diagnostic.path,
      diagnostic.page,
      diagnostic.section,
      diagnostic.component,
      diagnostic.message
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function requiredFile(root: string, path: string, owner: string, diagnostics: Diagnostic[]): Promise<void> {
  if (await fileExists(join(root, path))) return;
  diagnostics.push({
    code: "DESIGN_SYSTEM_FILE_MISSING",
    severity: "error",
    file: "design-system.yaml",
    path: owner,
    message: `Design System references missing file ${JSON.stringify(path)}.`,
    expected: path,
    suggestions: [{ action: "restore-design-system-file", file: path }]
  });
}

async function validateShells(root: string, manifest: DesignSystemManifest, diagnostics: Diagnostic[]): Promise<void> {
  for (const [id, shell] of Object.entries(manifest.shells.items)) {
    await requiredFile(root, shell.entry, `/shells/items/${id}/entry`, diagnostics);
    for (const [index, file] of shell.files.entries()) {
      await requiredFile(root, file, `/shells/items/${id}/files/${index}`, diagnostics);
    }
    if (!(await fileExists(join(root, shell.entry)))) continue;
    try {
      const source = await readFile(join(root, shell.entry), "utf8");
      if (!/<slot(?:\s|\/>|>)/i.test(source)) diagnostics.push({
        code: "DESIGN_SYSTEM_SHELL_SLOT_MISSING",
        severity: "error",
        file: shell.entry,
        message: `Shell pack "${id}" must render <slot />.`,
        expected: "<slot />"
      });
    } catch (error) {
      diagnostics.push({
        code: "DESIGN_SYSTEM_SHELL_READ_FAILED",
        severity: "error",
        file: shell.entry,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export async function inspectDesignSystem(root: string): Promise<DesignSystemInspectionResult> {
  const loaded = await loadDesignSystemContract(root);
  const diagnostics: Diagnostic[] = [...loaded.diagnostics];
  const manifest = loaded.designSystem?.value;
  if (!manifest) {
    diagnostics.push({
      code: "DESIGN_SYSTEM_CONTRACT_MISSING",
      severity: "error",
      file: "design-system.yaml",
      message: "design-system.yaml was not found. SiteSpec 0.4+ Design System packs require this contract."
    });
    return { valid: false, type: "design-system", source: "design-system.yaml", diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const [components, ui, presets, designResult, designDiagnostics] = await Promise.all([
    buildRegistry(root),
    buildUiRegistry(root),
    loadSectionPresets(root),
    inspectDesign(root),
    validateDesign(root)
  ]);
  diagnostics.push(...components.diagnostics, ...ui.diagnostics, ...presets.diagnostics, ...designResult.diagnostics, ...designDiagnostics);

  await requiredFile(root, manifest.tokens.source, "/tokens/source", diagnostics);
  await requiredFile(root, manifest.fonts.source, "/fonts/source", diagnostics);
  await validateShells(root, manifest, diagnostics);
  for (const [id, theme] of Object.entries(manifest.themes.items)) {
    if (theme.source) await requiredFile(root, theme.source, `/themes/items/${id}/source`, diagnostics);
  }

  for (const id of manifest.libraries.ui) if (!ui.registry.has(id)) diagnostics.push({
    code: "DESIGN_SYSTEM_UI_EXPORT_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: "/libraries/ui",
    message: `Design System exports unknown UI primitive "${id}".`,
    actual: id,
    allowed: [...ui.registry.keys()].sort()
  });
  for (const id of manifest.libraries.sections) if (!components.registry.has(id)) diagnostics.push({
    code: "DESIGN_SYSTEM_SECTION_EXPORT_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: "/libraries/sections",
    message: `Design System exports unknown section component "${id}".`,
    actual: id,
    allowed: [...components.registry.keys()].sort()
  });
  const presetById = new Map(presets.presets.map(preset => [preset.id, preset]));
  for (const id of manifest.libraries.presets) {
    const preset = presetById.get(id);
    if (!preset) {
      diagnostics.push({
        code: "DESIGN_SYSTEM_PRESET_EXPORT_UNKNOWN",
        severity: "error",
        file: "design-system.yaml",
        path: "/libraries/presets",
        message: `Design System exports unknown section preset "${id}".`,
        actual: id,
        allowed: [...presetById.keys()].sort()
      });
      continue;
    }
    if (!manifest.libraries.sections.includes(preset.value.section.use)) diagnostics.push({
      code: "DESIGN_SYSTEM_PRESET_SECTION_NOT_EXPORTED",
      severity: "error",
      file: preset.file,
      message: `Preset "${id}" uses section "${preset.value.section.use}" which is not exported by libraries.sections.`,
      actual: preset.value.section.use,
      allowed: manifest.libraries.sections
    });
  }

  const semanticNames = new Set(designResult.design.semantic.map(token => token.name));
  for (const [field, token] of Object.entries(manifest.layout.tokens)) if (!semanticNames.has(token)) diagnostics.push({
    code: "DESIGN_SYSTEM_LAYOUT_TOKEN_UNKNOWN",
    severity: "error",
    file: "design-system.yaml",
    path: `/layout/tokens/${field}`,
    message: `Layout convention references unknown semantic token "${token}".`,
    actual: token,
    allowed: [...semanticNames].sort()
  });

  const cleanDiagnostics = dedupeDiagnostics(diagnostics);
  const inspection = {
    ...manifest.designSystem,
    contractVersion: manifest.specVersion,
    portable: {
      format: "copy",
      runtimeDependency: false,
      install: "sitespec design-system install <pack>",
      pack: "sitespec design-system pack <directory>"
    },
    tokens: {
      source: manifest.tokens.source,
      extension: manifest.tokens.extension,
      rules: manifest.tokens.rules,
      primitive: designResult.design.primitive.length,
      semantic: designResult.design.semantic.length
    },
    fonts: {
      source: manifest.fonts.source,
      assetsRoot: manifest.fonts.assetsRoot,
      families: designResult.design.fonts.families.map(family => family.id)
    },
    themes: {
      default: manifest.themes.default,
      items: designResult.design.themes.items.map(theme => ({
        id: theme.id,
        label: theme.label,
        source: theme.source,
        selector: theme.selector,
        overrides: theme.overrides.length
      }))
    },
    layout: manifest.layout,
    libraries: {
      ui: manifest.libraries.ui.map(id => ({ id, source: `ui/${id}/` })),
      sections: manifest.libraries.sections.map(id => ({ id, source: `components/${id}/` })),
      presets: manifest.libraries.presets.map(id => ({ id, source: `sections/${id}.yaml` }))
    },
    shells: {
      default: manifest.shells.default,
      items: Object.entries(manifest.shells.items).map(([id, shell]) => ({ id, entry: shell.entry, files: shell.files }))
    }
  };

  return {
    valid: !cleanDiagnostics.some(diagnostic => diagnostic.severity === "error"),
    type: "design-system",
    source: "design-system.yaml",
    designSystem: inspection,
    diagnostics: cleanDiagnostics
  };
}

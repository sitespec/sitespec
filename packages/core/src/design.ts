import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Diagnostic } from "./types.js";
import { validateFontsSchema } from "./ajv.js";
import { fileExists, parseDataFile } from "./fs.js";

export type DesignTokenLayer = "primitive" | "semantic";

export interface DesignTokenRecord {
  layer: DesignTokenLayer;
  path: string;
  name: string;
  type: string;
  value: string | number;
  alias?: string;
  cssVariable: string;
}

export type DesignFontFormat = "woff2" | "woff";
export type DesignFontStyle = "normal" | "italic" | "oblique";
export type DesignFontDisplay = "auto" | "block" | "swap" | "fallback" | "optional";

export interface DesignFontSource {
  src: string;
  format: DesignFontFormat;
  weight: number | string;
  style: DesignFontStyle;
  display: DesignFontDisplay;
}

export interface DesignFontFamily {
  id: string;
  family: string;
  sources: DesignFontSource[];
}

interface SourceDesignFonts {
  specVersion: "0.1";
  fonts: Record<string, {
    family: string;
    sources: Array<{
      src: string;
      format: DesignFontFormat;
      weight: number | string;
      style?: DesignFontStyle;
      display?: DesignFontDisplay;
        }>;
  }>;
}

export interface DesignFontsInspection {
  source: "design/fonts.yaml";
  publicDirectory: "public/fonts/";
  remoteFonts: false;
  formats: ["woff2", "woff"];
  defaults: { style: "normal"; display: "swap" };
  families: DesignFontFamily[];
}

export interface DesignInspection {
  source: string;
  model: {
    layers: ["primitive", "semantic"];
    primitive: string;
    semantic: string;
    componentUsage: string;
  };
  rules: {
    semanticTokensOnly: true;
    rawColors: false;
    rawSpacing: false;
    rawTypography: false;
    rawRadius: false;
    rawShadows: false;
    inlineStyles: false;
    localCustomProperties: false;
    externalStylesheets: false;
  };
  categories: Record<string, string[]>;
  primitive: DesignTokenRecord[];
  semantic: DesignTokenRecord[];
  fonts: DesignFontsInspection;
}

interface LoadedDesign {
  inspection: DesignInspection;
  diagnostics: Diagnostic[];
  semanticVariables: Set<string>;
  primitiveVariables: Set<string>;
}


async function listAstroFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listAstroFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".astro")) out.push(file);
  }
  return out.sort();
}

const SUPPORTED_TOKEN_TYPES = new Set([
  "color",
  "dimension",
  "fontFamily",
  "number",
  "shadow",
  "string"
]);

const DESIGN_VAR_PREFIXES = [
  "--color-",
  "--space-",
  "--radius-",
  "--font-",
  "--shadow-",
  "--size-"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cssName(parts: string[]): string {
  return parts
    .join("-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function cssVariableForPath(path: string[]): string {
  const parts = path[0] === "semantic" ? path.slice(1) : path;
  return `--${cssName(parts)}`;
}

function aliasPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.match(/^\{([a-zA-Z0-9._-]+)\}$/)?.[1];
}

function emptyFontsInspection(): DesignFontsInspection {
  return {
    source: "design/fonts.yaml",
    publicDirectory: "public/fonts/",
    remoteFonts: false,
    formats: ["woff2", "woff"],
    defaults: { style: "normal", display: "swap" },
    families: []
  };
}

function publicFontPathIsSafe(value: string): boolean {
  if (!value.startsWith("/fonts/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%") || value.includes("\0")) return false;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 && !parts.some(part => part === "." || part === "..");
}

function fontWeightRangeIsValid(value: number | string): boolean {
  if (typeof value === "number") return value >= 1 && value <= 1000;
  const parts = value.split(" ").map(Number);
  const start = parts[0];
  const end = parts[1];
  return parts.length === 2 && start !== undefined && end !== undefined
    && Number.isInteger(start) && Number.isInteger(end)
    && start >= 1 && end <= 1000 && start <= end;
}

async function validateFontAsset(root: string, familyId: string, sourceIndex: number, source: DesignFontSource, diagnostics: Diagnostic[]): Promise<void> {
  const path = `/fonts/${familyId}/sources/${sourceIndex}/src`;
  if (!publicFontPathIsSafe(source.src)) {
    diagnostics.push({
      code: "FONT_ASSET_PATH_INVALID",
      severity: "error",
      file: "design/fonts.yaml",
      path,
      message: `Font source for "${familyId}" must be a safe root-relative path inside public/.`,
      expected: "/fonts/name.woff2 under public/fonts/",
      actual: source.src
    });
    return;
  }

  const extension = extname(source.src).toLowerCase();
  const expectedExtension = source.format === "woff2" ? ".woff2" : ".woff";
  if (extension !== expectedExtension) {
    diagnostics.push({
      code: "FONT_FORMAT_MISMATCH",
      severity: "error",
      file: "design/fonts.yaml",
      path,
      message: `Font source format "${source.format}" must use a ${expectedExtension} file.`,
      expected: expectedExtension,
      actual: extension || undefined,
      allowed: [".woff2", ".woff"]
    });
  }

  const publicRoot = resolve(root, "public");
  const file = join(publicRoot, source.src.slice(1));
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      diagnostics.push({
        code: "FONT_ASSET_SYMLINK_FORBIDDEN",
        severity: "error",
        file: "design/fonts.yaml",
        path,
        message: `Font source "${source.src}" must be a regular file, not a symbolic link.`,
        actual: source.src
      });
      return;
    }
    if (!info.isFile()) {
      diagnostics.push({
        code: "FONT_ASSET_NOT_FILE",
        severity: "error",
        file: "design/fonts.yaml",
        path,
        message: `Font source "${source.src}" does not point to a regular file.`,
        actual: source.src
      });
      return;
    }
    const [realPublicRoot, realFile] = await Promise.all([realpath(publicRoot), realpath(file)]);
    const rel = relative(realPublicRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      diagnostics.push({
        code: "FONT_ASSET_OUTSIDE_PUBLIC",
        severity: "error",
        file: "design/fonts.yaml",
        path,
        message: `Font source "${source.src}" resolves outside public/.`,
        actual: source.src
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      diagnostics.push({
        code: "FONT_ASSET_NOT_FOUND",
        severity: "error",
        file: "design/fonts.yaml",
        path,
        message: `Font source was not found at public${source.src}.`,
        expected: `existing file public${source.src}`,
        actual: source.src,
        suggestions: [{
          action: "add-font-file",
          file: `public${source.src}`,
          message: `Add a local .${source.format} font file at public${source.src} or update design/fonts.yaml.`
        }]
      });
      return;
    }
    diagnostics.push({
      code: "FONT_ASSET_READ_FAILED",
      severity: "error",
      file: "design/fonts.yaml",
      path,
      message: error instanceof Error ? error.message : String(error),
      actual: source.src
    });
  }
}

export async function loadDesignFonts(root: string): Promise<{ fonts: DesignFontFamily[]; inspection: DesignFontsInspection; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const inspection = emptyFontsInspection();
  const file = join(root, "design", "fonts.yaml");
  if (!(await fileExists(file))) return { fonts: [], inspection, diagnostics };

  const parsed = await parseDataFile<SourceDesignFonts>(root, file);
  if (parsed.diagnostic || parsed.value === undefined) {
    diagnostics.push({
      ...(parsed.diagnostic ?? {
        code: "FONT_SPEC_PARSE_ERROR",
        severity: "error" as const,
        message: "design/fonts.yaml could not be parsed."
      }),
      code: "FONT_SPEC_PARSE_ERROR",
      file: "design/fonts.yaml"
    });
    return { fonts: [], inspection, diagnostics };
  }

  if (!validateFontsSchema(parsed.value)) {
    for (const error of validateFontsSchema.errors ?? []) {
      const formatError = error.keyword === "enum" && error.instancePath.endsWith("/format");
      diagnostics.push({
        code: formatError ? "FONT_FORMAT_UNSUPPORTED" : "FONT_SCHEMA_INVALID",
        severity: "error",
        file: "design/fonts.yaml",
        path: error.instancePath || "/",
        message: formatError
          ? `Unsupported font format ${JSON.stringify(error.data)}. Site Spec v0.1 supports woff2 and woff.`
          : `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        actual: (error as { data?: unknown }).data,
        allowed: formatError ? ["woff2", "woff"] : undefined,
        suggestions: formatError ? [{
          action: "use-supported-font-format",
          candidates: ["woff2", "woff"],
          command: "npm run site -- spec fonts --json"
        }] : undefined
      });
    }
    return { fonts: [], inspection, diagnostics };
  }

  const families: DesignFontFamily[] = Object.entries(parsed.value.fonts).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({
    id,
    family: value.family,
    sources: value.sources.map(source => ({
      ...source,
      style: source.style ?? "normal",
      display: source.display ?? "swap"
    }))
  }));

  const familyNames = new Map<string, string>();
  const sourcePaths = new Map<string, string>();
  for (const family of families) {
    const normalizedFamily = family.family.trim().toLowerCase();
    const existingFamily = familyNames.get(normalizedFamily);
    if (existingFamily) {
      diagnostics.push({
        code: "FONT_FAMILY_DUPLICATE",
        severity: "error",
        file: "design/fonts.yaml",
        path: `/fonts/${family.id}/family`,
        message: `Font family "${family.family}" is already declared by "${existingFamily}".`,
        actual: family.family
      });
    } else {
      familyNames.set(normalizedFamily, family.id);
    }

    const faces = new Set<string>();
    for (const [index, source] of family.sources.entries()) {
      if (!fontWeightRangeIsValid(source.weight)) {
        diagnostics.push({
          code: "FONT_WEIGHT_RANGE_INVALID",
          severity: "error",
          file: "design/fonts.yaml",
          path: `/fonts/${family.id}/sources/${index}/weight`,
          message: `Font weight range for "${family.id}" must be ascending and stay between 1 and 1000.`,
          actual: source.weight
        });
      }
      const faceKey = `${source.weight}|${source.style}`;
      if (faces.has(faceKey)) {
        diagnostics.push({
          code: "FONT_FACE_DUPLICATE",
          severity: "error",
          file: "design/fonts.yaml",
          path: `/fonts/${family.id}/sources/${index}`,
          message: `Font family "${family.id}" declares the same weight/style face more than once.`,
          actual: { weight: source.weight, style: source.style }
        });
      }
      faces.add(faceKey);

      const priorSource = sourcePaths.get(source.src);
      if (priorSource) {
        diagnostics.push({
          code: "FONT_SOURCE_DUPLICATE",
          severity: "error",
          file: "design/fonts.yaml",
          path: `/fonts/${family.id}/sources/${index}/src`,
          message: `Font source "${source.src}" is already used by ${priorSource}.`,
          actual: source.src
        });
      } else {
        sourcePaths.set(source.src, `${family.id}:${source.weight}:${source.style}`);
      }
      await validateFontAsset(root, family.id, index, source, diagnostics);
    }
  }

  inspection.families = families;
  return { fonts: families, inspection, diagnostics };
}

function emptyInspection(): DesignInspection {
  return {
    source: "design/tokens.json",
    model: {
      layers: ["primitive", "semantic"],
      primitive: "Raw design decisions. Primitive tokens contain literal values and are not used directly by components or shell.",
      semantic: "Stable UI vocabulary. Semantic tokens alias primitive tokens and are the only design tokens components and shell may consume.",
      componentUsage: "Use semantic CSS variables such as var(--color-text-default), never var(--primitive-...) or raw reusable design values."
    },
    rules: {
      semanticTokensOnly: true,
      rawColors: false,
      rawSpacing: false,
      rawTypography: false,
      rawRadius: false,
      rawShadows: false,
      inlineStyles: false,
      localCustomProperties: false,
      externalStylesheets: false
    },
    categories: {},
    primitive: [],
    semantic: [],
    fonts: emptyFontsInspection()
  };
}

function flattenTokenLayer(
  layer: DesignTokenLayer,
  value: unknown,
  path: string[],
  out: DesignTokenRecord[],
  diagnostics: Diagnostic[]
): void {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "DESIGN_TOKEN_GROUP_INVALID",
      severity: "error",
      file: "design/tokens.json",
      path: `/${path.join("/")}`,
      message: `Design token group "${path.join(".")}" must be an object.`
    });
    return;
  }

  if ("$value" in value) {
    const tokenPath = path.join(".");
    const tokenType = value.$type;
    const tokenValue = value.$value;
    if (typeof tokenType !== "string" || !SUPPORTED_TOKEN_TYPES.has(tokenType)) {
      diagnostics.push({
        code: "DESIGN_TOKEN_TYPE_INVALID",
        severity: "error",
        file: "design/tokens.json",
        path: `/${path.join("/")}/$type`,
        message: `Token "${tokenPath}" must declare a supported $type.`,
        actual: tokenType,
        allowed: [...SUPPORTED_TOKEN_TYPES].sort()
      });
      return;
    }
    if (typeof tokenValue !== "string" && typeof tokenValue !== "number") {
      diagnostics.push({
        code: "DESIGN_TOKEN_VALUE_INVALID",
        severity: "error",
        file: "design/tokens.json",
        path: `/${path.join("/")}/$value`,
        message: `Token "${tokenPath}" must use a string or number value in Site Spec v0.1.`,
        actual: tokenValue
      });
      return;
    }

    const alias = aliasPath(tokenValue);
    if (layer === "primitive" && alias) {
      diagnostics.push({
        code: "DESIGN_PRIMITIVE_ALIAS_FORBIDDEN",
        severity: "error",
        file: "design/tokens.json",
        path: `/${path.join("/")}/$value`,
        message: `Primitive token "${tokenPath}" must contain a literal value, not an alias.`,
        actual: tokenValue
      });
    }
    if (layer === "semantic" && (!alias || !alias.startsWith("primitive."))) {
      diagnostics.push({
        code: "DESIGN_SEMANTIC_LITERAL_FORBIDDEN",
        severity: "error",
        file: "design/tokens.json",
        path: `/${path.join("/")}/$value`,
        message: `Semantic token "${tokenPath}" must alias a primitive token in v0.1.`,
        expected: "{primitive.<category>.<token>}",
        actual: tokenValue,
        suggestions: [{
          action: "alias-primitive-token",
          command: "npm run site -- spec design --json",
          message: "Inspect primitive tokens and map this semantic token to the closest design decision."
        }]
      });
    }

    out.push({
      layer,
      path: tokenPath,
      name: path.slice(1).join("."),
      type: tokenType,
      value: tokenValue,
      alias,
      cssVariable: cssVariableForPath(path)
    });
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$")) continue;
    flattenTokenLayer(layer, child, [...path, key], out, diagnostics);
  }
}

function semanticCategories(tokens: DesignTokenRecord[]): Record<string, string[]> {
  const categories: Record<string, string[]> = {};
  for (const token of tokens) {
    const [category = "other"] = token.name.split(".");
    (categories[category] ??= []).push(token.name);
  }
  for (const values of Object.values(categories)) values.sort();
  return Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)));
}

export async function loadDesign(root: string): Promise<LoadedDesign> {
  const fontDesign = await loadDesignFonts(root);
  const diagnostics: Diagnostic[] = [...fontDesign.diagnostics];
  const inspection = emptyInspection();
  inspection.fonts = fontDesign.inspection;
  const file = join(root, "design", "tokens.json");
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    diagnostics.push({
      code: code === "ENOENT" ? "DESIGN_TOKENS_MISSING" : "DESIGN_TOKENS_PARSE_FAILED",
      severity: "error",
      file: "design/tokens.json",
      message: code === "ENOENT"
        ? "design/tokens.json is required in Site Spec v0.1."
        : error instanceof Error ? error.message : String(error),
      suggestions: code === "ENOENT" ? [{
        action: "restore-design-tokens",
        file: "design/tokens.json",
        message: "Restore the project design token file or run sitespec init in a new project to inspect the v0.1 structure."
      }] : undefined
    });
    return { inspection, diagnostics, semanticVariables: new Set(), primitiveVariables: new Set() };
  }

  if (!isRecord(parsed)) {
    diagnostics.push({
      code: "DESIGN_TOKENS_ROOT_INVALID",
      severity: "error",
      file: "design/tokens.json",
      message: "design/tokens.json must contain an object with primitive and semantic layers."
    });
    return { inspection, diagnostics, semanticVariables: new Set(), primitiveVariables: new Set() };
  }

  const allowedTopLevel = new Set(["primitive", "semantic"]);
  for (const key of Object.keys(parsed)) {
    if (!allowedTopLevel.has(key)) diagnostics.push({
      code: "DESIGN_TOKENS_LAYER_UNKNOWN",
      severity: "error",
      file: "design/tokens.json",
      path: `/${key}`,
      message: `Unknown top-level design token layer "${key}".`,
      allowed: ["primitive", "semantic"]
    });
  }

  if (!isRecord(parsed.primitive)) diagnostics.push({
    code: "DESIGN_PRIMITIVE_LAYER_MISSING",
    severity: "error",
    file: "design/tokens.json",
    path: "/primitive",
    message: "design/tokens.json must define a primitive token layer."
  });
  if (!isRecord(parsed.semantic)) diagnostics.push({
    code: "DESIGN_SEMANTIC_LAYER_MISSING",
    severity: "error",
    file: "design/tokens.json",
    path: "/semantic",
    message: "design/tokens.json must define a semantic token layer."
  });

  const primitive: DesignTokenRecord[] = [];
  const semantic: DesignTokenRecord[] = [];
  if (isRecord(parsed.primitive)) flattenTokenLayer("primitive", parsed.primitive, ["primitive"], primitive, diagnostics);
  if (isRecord(parsed.semantic)) flattenTokenLayer("semantic", parsed.semantic, ["semantic"], semantic, diagnostics);

  const tokenByPath = new Map([...primitive, ...semantic].map(token => [token.path, token]));
  for (const token of semantic) {
    if (token.alias && !tokenByPath.has(token.alias)) {
      diagnostics.push({
        code: "DESIGN_TOKEN_ALIAS_NOT_FOUND",
        severity: "error",
        file: "design/tokens.json",
        path: `/${token.path.split(".").join("/")}/$value`,
        message: `Semantic token "${token.path}" references unknown token "${token.alias}".`,
        expected: "existing primitive token",
        actual: token.alias,
        allowed: primitive.map(item => item.path).sort(),
        suggestions: [{
          action: "use-design-token",
          candidates: primitive.map(item => item.path).sort()
        }]
      });
      continue;
    }
    if (token.alias) {
      const target = tokenByPath.get(token.alias);
      if (target && target.type !== token.type) diagnostics.push({
        code: "DESIGN_TOKEN_ALIAS_TYPE_MISMATCH",
        severity: "error",
        file: "design/tokens.json",
        path: `/${token.path.split(".").join("/")}/$value`,
        message: `Semantic token "${token.path}" has type "${token.type}" but aliases ${token.alias} with type "${target.type}".`,
        expected: token.type,
        actual: target.type
      });
    }
  }

  const variableOwners = new Map<string, string>();
  for (const token of [...primitive, ...semantic]) {
    const owner = variableOwners.get(token.cssVariable);
    if (owner) diagnostics.push({
      code: "DESIGN_TOKEN_CSS_VARIABLE_DUPLICATE",
      severity: "error",
      file: "design/tokens.json",
      message: `Tokens "${owner}" and "${token.path}" both compile to ${token.cssVariable}.`,
      actual: token.cssVariable
    });
    else variableOwners.set(token.cssVariable, token.path);
  }

  const primitiveFontFamilies = primitive
    .filter(token => token.type === "fontFamily" && typeof token.value === "string")
    .map(token => String(token.value).toLowerCase());
  for (const family of fontDesign.fonts) {
    const used = primitiveFontFamilies.some(value => value.includes(family.family.toLowerCase()));
    if (!used) diagnostics.push({
      code: "FONT_FAMILY_NOT_IN_TOKENS",
      severity: "error",
      file: "design/fonts.yaml",
      path: `/fonts/${family.id}/family`,
      message: `Declared font family "${family.family}" is not referenced by any primitive fontFamily token.`,
      expected: `primitive fontFamily containing ${family.family}`,
      actual: family.family,
      suggestions: [{
        action: "wire-font-to-design-tokens",
        command: "npm run site -- spec fonts --json",
        file: "design/tokens.json",
        message: "Add the family to a primitive fontFamily stack, then keep body/heading mapped through semantic font-family tokens."
      }]
    });
  }

  primitive.sort((a, b) => a.name.localeCompare(b.name));
  semantic.sort((a, b) => a.name.localeCompare(b.name));
  inspection.primitive = primitive;
  inspection.semantic = semantic;
  inspection.categories = semanticCategories(semantic);

  return {
    inspection,
    diagnostics,
    semanticVariables: new Set(semantic.map(token => token.cssVariable)),
    primitiveVariables: new Set(primitive.map(token => token.cssVariable))
  };
}

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
const NAMED_COLOR = /\b(?:black|white|red|green|blue|gray|grey|purple|orange|yellow|pink|brown|cyan|magenta|rebeccapurple)\b/i;
const RAW_LENGTH = /(?:^|[\s,(])[-+]?(?:\d*\.)?\d+(?:px|rem|em|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)(?=[\s,)]|$)/i;
const RAW_PERCENTAGE = /(?:^|[\s,(])[-+]?(?:\d*\.)?\d+%(?=[\s,)]|$)/;
const SPACING_PROPERTY = /^(?:margin(?:-(?:top|right|bottom|left|block|inline)(?:-start|-end)?)?|padding(?:-(?:top|right|bottom|left|block|inline)(?:-start|-end)?)?|gap|row-gap|column-gap)$/;
const COLOR_PROPERTY = /^(?:color|background-color|border-color|outline-color|text-decoration-color|caret-color|fill|stroke)$/;

function isExactSemanticVar(value: string): boolean {
  return /^var\(\s*--[a-zA-Z0-9_-]+\s*\)$/.test(value.trim());
}

function styleBlocks(source: string): Array<{ css: string; offset: number }> {
  const out: Array<{ css: string; offset: number }> = [];
  const pattern = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    out.push({ css: match[1] ?? "", offset: match.index + match[0].indexOf(match[1] ?? "") });
  }
  return out;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function allowedZeroOrKeyword(value: string, keywords: string[]): boolean {
  const parts = value.trim().split(/\s+/);
  return parts.length > 0 && parts.every(part => part === "0" || keywords.includes(part.toLowerCase()) || /^var\(/i.test(part) || /^calc\(/i.test(part));
}

function designVariableLike(variable: string): boolean {
  return variable.startsWith("--primitive-") || DESIGN_VAR_PREFIXES.some(prefix => variable.startsWith(prefix));
}

function designDiagnostic(
  code: string,
  file: string,
  line: number,
  property: string,
  value: string,
  message: string
): Diagnostic {
  return {
    code,
    severity: "error",
    file,
    path: `style:${line}`,
    message,
    expected: "semantic design token",
    actual: `${property}: ${value}`,
    suggestions: [{
      action: "use-semantic-design-token",
      command: "npm run site -- spec design --json",
      message: "Inspect the semantic design vocabulary and use the closest var(--...) token."
    }]
  };
}

async function validateAstroDesignFile(
  root: string,
  file: string,
  semanticVariables: Set<string>,
  primitiveVariables: Set<string>,
  diagnostics: Diagnostic[]
): Promise<void> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    diagnostics.push({
      code: "DESIGN_SOURCE_READ_FAILED",
      severity: "error",
      file: relative(root, file),
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const relFile = relative(root, file);

  if (/<[^>]+\bstyle\s*=/i.test(source)) {
    diagnostics.push({
      code: "DESIGN_INLINE_STYLE_FORBIDDEN",
      severity: "error",
      file: relFile,
      message: "Inline style attributes are forbidden in components and Site Shell in v0.1.",
      expected: "scoped <style> using semantic design tokens",
      suggestions: [{
        action: "move-style-to-component-css",
        command: "npm run site -- spec design --json"
      }]
    });
  }

  if (/\bimport\s+["'][^"']+\.css["']|@import\s+(?:url\()?|<link\b[^>]*\brel=["']stylesheet["'][^>]*>/i.test(source)) {
    diagnostics.push({
      code: "DESIGN_EXTERNAL_STYLESHEET_FORBIDDEN",
      severity: "error",
      file: relFile,
      message: "Component and shell styles must remain in their Astro <style> blocks in v0.1 so design lint can validate them deterministically.",
      expected: "scoped <style> block"
    });
  }

  if (/@font-face\s*\{/i.test(source)) {
    diagnostics.push({
      code: "DESIGN_FONT_FACE_FORBIDDEN",
      severity: "error",
      file: relFile,
      message: "Declare local web fonts in design/fonts.yaml; @font-face is generated by the renderer in Site Spec v0.1.",
      expected: "design/fonts.yaml",
      suggestions: [{
        action: "declare-font-face",
        command: "npm run site -- spec fonts --json",
        file: "design/fonts.yaml"
      }]
    });
  }

  for (const block of styleBlocks(source)) {
    const css = block.css.replace(/\/\*[\s\S]*?\*\//g, "");
    const localVariables = new Set<string>();
    for (const match of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      const variable = match[1]!;
      localVariables.add(variable);
      diagnostics.push({
        code: "DESIGN_LOCAL_CUSTOM_PROPERTY_FORBIDDEN",
        severity: "error",
        file: relFile,
        path: `style:${lineAt(source, block.offset + match.index)}`,
        message: `Local CSS custom property ${variable} is forbidden in components and Site Shell in v0.1.`,
        actual: variable,
        suggestions: [{
          action: "promote-to-design-token",
          command: "npm run site -- spec design --json",
          message: "If this is a reusable visual decision, add it to design/tokens.json; otherwise use the CSS value directly for non-token-enforced layout properties."
        }]
      });
    }

    const declaration = /([a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(css))) {
      const property = match[1]!.toLowerCase();
      const value = match[2]!.trim();
      const line = lineAt(source, block.offset + match.index);

      for (const variableMatch of value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
        const variable = variableMatch[1]!;
        if (primitiveVariables.has(variable) || variable.startsWith("--primitive-")) {
          diagnostics.push({
            ...designDiagnostic(
              "DESIGN_PRIMITIVE_TOKEN_USAGE",
              relFile,
              line,
              property,
              value,
              `Use a semantic token instead of primitive token ${variable}.`
            ),
            actual: variable
          });
          continue;
        }
        if (designVariableLike(variable) && !semanticVariables.has(variable) && !localVariables.has(variable)) {
          diagnostics.push({
            ...designDiagnostic(
              "DESIGN_UNKNOWN_TOKEN",
              relFile,
              line,
              property,
              value,
              `Unknown design token ${variable}.`
            ),
            actual: variable,
            allowed: [...semanticVariables].sort()
          });
        }
      }

      const rawColorProperty = COLOR_PROPERTY.test(property)
        && !value.includes("var(")
        && !["inherit", "initial", "unset", "revert", "currentcolor", "transparent"].includes(value.toLowerCase());
      const rawBackground = property === "background"
        && !value.includes("var(")
        && value.toLowerCase() !== "none"
        && !/^url\(/i.test(value);
      if (RAW_COLOR.test(value) || NAMED_COLOR.test(value) || rawColorProperty || rawBackground) {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_COLOR",
          relFile,
          line,
          property,
          value,
          "Reusable colors in components and shell must come from semantic design tokens."
        ));
      }

      if (SPACING_PROPERTY.test(property) && (RAW_LENGTH.test(value) || RAW_PERCENTAGE.test(value))) {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_SPACING",
          relFile,
          line,
          property,
          value,
          `Property "${property}" contains raw spacing. Use a semantic spacing token.`
        ));
      }

      if (property === "font-size" && !isExactSemanticVar(value) && !["inherit", "initial", "unset", "revert"].includes(value.toLowerCase())) {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_TYPOGRAPHY",
          relFile,
          line,
          property,
          value,
          "font-size must use a semantic typography token."
        ));
      }
      if (property === "font-family" && !isExactSemanticVar(value) && !["inherit", "initial", "unset", "revert"].includes(value.toLowerCase())) {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_TYPOGRAPHY",
          relFile,
          line,
          property,
          value,
          "font-family must use a semantic typography token."
        ));
      }
      if (property === "line-height" && !isExactSemanticVar(value) && !["normal", "inherit", "initial", "unset", "revert"].includes(value.toLowerCase())) {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_TYPOGRAPHY",
          relFile,
          line,
          property,
          value,
          "line-height must use a semantic typography token."
        ));
      }

      if (property === "border-radius" && value !== "0" && !isExactSemanticVar(value)) {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_RADIUS",
          relFile,
          line,
          property,
          value,
          "border-radius must use a semantic radius token."
        ));
      }

      if (property === "box-shadow" && !isExactSemanticVar(value) && value.toLowerCase() !== "none") {
        diagnostics.push(designDiagnostic(
          "DESIGN_RAW_SHADOW",
          relFile,
          line,
          property,
          value,
          "box-shadow must use a semantic shadow token or none."
        ));
      }
    }
  }
}

export async function validateDesign(root: string): Promise<Diagnostic[]> {
  const loaded = await loadDesign(root);
  const diagnostics = [...loaded.diagnostics];
  if (loaded.diagnostics.some(diagnostic => diagnostic.severity === "error")) return diagnostics;

  const files = [
    ...await listAstroFiles(join(root, "components")),
    ...await listAstroFiles(join(root, "shell"))
  ].sort();

  for (const file of files) {
    await validateAstroDesignFile(root, file, loaded.semanticVariables, loaded.primitiveVariables, diagnostics);
  }
  return diagnostics;
}

export async function inspectDesign(root: string): Promise<{ design: DesignInspection; diagnostics: Diagnostic[] }> {
  const loaded = await loadDesign(root);
  return { design: loaded.inspection, diagnostics: loaded.diagnostics };
}

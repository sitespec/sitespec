import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  Ajv2020 as Ajv2020Instance,
  ErrorObject,
  Options as AjvOptions,
  ValidateFunction
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

const require = createRequire(import.meta.url);

type Ajv2020Constructor = new (opts?: AjvOptions) => Ajv2020Instance;

function loadAjv2020(): Ajv2020Constructor {
  const loaded = require("ajv/dist/2020.js") as unknown;
  if (typeof loaded === "function") return loaded as Ajv2020Constructor;

  const candidate = (loaded as { default?: unknown; Ajv2020?: unknown }).default
    ?? (loaded as { Ajv2020?: unknown }).Ajv2020;
  if (typeof candidate !== "function") {
    throw new TypeError("ajv/dist/2020.js did not export an Ajv2020 constructor.");
  }
  return candidate as Ajv2020Constructor;
}

function loadFormatsPlugin(): FormatsPlugin {
  const loaded = require("ajv-formats") as unknown;
  if (typeof loaded === "function") return loaded as FormatsPlugin;

  const candidate = (loaded as { default?: unknown }).default;
  if (typeof candidate !== "function") {
    throw new TypeError("ajv-formats did not export a formats plugin.");
  }
  return candidate as FormatsPlugin;
}

const Ajv2020 = loadAjv2020();
const addFormats = loadFormatsPlugin();

function schemaUrl(name: string): URL {
  const besideModule = new URL(`./schemas/${name}`, import.meta.url);
  if (existsSync(besideModule)) return besideModule;
  return new URL(`../src/schemas/${name}`, import.meta.url);
}

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaUrl(name), "utf8")) as Record<string, unknown>;
}

function schemaAlias(schema: Record<string, unknown>, id: string): Record<string, unknown> {
  return { ...schema, $id: id };
}

export function createAjv(): Ajv2020Instance {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: false });
  addFormats(ajv);
  const action = loadSchema("types/action.schema.json");
  const image = loadSchema("types/image.schema.json");
  const navigation = loadSchema("types/navigation.schema.json");
  ajv.addSchema(action);
  ajv.addSchema(image);
  ajv.addSchema(navigation);
  ajv.addSchema(schemaAlias(action, "urn:site-spec:0.2:type:action"));
  ajv.addSchema(schemaAlias(image, "urn:site-spec:0.2:type:image"));
  ajv.addSchema(schemaAlias(navigation, "urn:site-spec:0.2:type:navigation"));
  ajv.addSchema(schemaAlias(action, "urn:site-spec:0.3:type:action"));
  ajv.addSchema(schemaAlias(image, "urn:site-spec:0.3:type:image"));
  ajv.addSchema(schemaAlias(navigation, "urn:site-spec:0.3:type:navigation"));
  ajv.addSchema(schemaAlias(action, "urn:site-spec:0.4:type:action"));
  ajv.addSchema(schemaAlias(image, "urn:site-spec:0.4:type:image"));
  ajv.addSchema(schemaAlias(navigation, "urn:site-spec:0.4:type:navigation"));
  const pagination = loadSchema("types/pagination.schema.json");
  ajv.addSchema(pagination);
  ajv.addSchema(schemaAlias(pagination, "urn:site-spec:0.3:type:pagination"));
  ajv.addSchema(schemaAlias(pagination, "urn:site-spec:0.4:type:pagination"));
  return ajv;
}

export const baseAjv = createAjv();
export const validateSiteSchema = baseAjv.compile(loadSchema("site.schema.json"));
export const validatePageSchema = baseAjv.compile(loadSchema("page.schema.json"));
export const validateComponentSchema = baseAjv.compile(loadSchema("component.schema.json"));
export const validateUiSchema = baseAjv.compile(loadSchema("ui.schema.json"));
export const validateSectionPresetSchema = baseAjv.compile(loadSchema("section-preset.schema.json"));
export const validateFontsSchema = baseAjv.compile(loadSchema("fonts.schema.json"));
export const validateCollectionSchema = baseAjv.compile(loadSchema("collection.schema.json"));
export const validateDesignSystemSchema = baseAjv.compile(loadSchema("design-system.schema.json"));

export function compilePropsSchema(schema: Record<string, unknown>): ValidateFunction {
  const ajv = createAjv();
  if (!ajv.validateSchema(schema)) {
    const detail = formatAjvErrors(ajv.errors);
    throw new Error(detail || "Invalid props JSON Schema.");
  }
  return ajv.compile(schema);
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(e => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`).join("; ");
}

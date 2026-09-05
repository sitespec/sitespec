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

export function createAjv(): Ajv2020Instance {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: false });
  addFormats(ajv);
  ajv.addSchema(loadSchema("types/action.schema.json"));
  ajv.addSchema(loadSchema("types/image.schema.json"));
  ajv.addSchema(loadSchema("types/navigation.schema.json"));
  return ajv;
}

export const baseAjv = createAjv();
export const validateSiteSchema = baseAjv.compile(loadSchema("site.schema.json"));
export const validatePageSchema = baseAjv.compile(loadSchema("page.schema.json"));
export const validateComponentSchema = baseAjv.compile(loadSchema("component.schema.json"));
export const validateFontsSchema = baseAjv.compile(loadSchema("fonts.schema.json"));

export function compilePropsSchema(schema: Record<string, unknown>): ValidateFunction {
  const ajv = createAjv();
  if (!ajv.validateSchema(schema)) {
    const detail = formatAjvErrors(ajv.errors);
    throw new Error(detail || "Invalid component props JSON Schema.");
  }
  return ajv.compile(schema);
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(e => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`).join("; ");
}

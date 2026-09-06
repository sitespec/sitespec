import { cp, readFile, realpath, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { basename, dirname, extname, join, relative } from "node:path";
import { build as astroBuild, dev as astroDev } from "astro";
import { inspectDesign, loadDesignFonts, loadDesignSystemContract } from "@sitespec/core";
import type { Diagnostic, RegisteredComponent, RegisteredUiPrimitive, ResolvedPage, ResolvedSite } from "@sitespec/core";

type SharpPipeline = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpPipeline["metadata"]>>;

export interface AstroBuildOptions {
  root: string;
  site: ResolvedSite;
  registry?: Map<string, RegisteredComponent>;
  uiRegistry?: Map<string, RegisteredUiPrimitive>;
  outDir?: string;
}

export interface AstroBuildResult {
  success: boolean;
  outDir: string;
  pages: string[];
  diagnostics: Diagnostic[];
}

export interface AstroDevOptions {
  root: string;
  site?: ResolvedSite;
  host?: string;
  port?: number;
  diagnostics?: Diagnostic[];
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
}

export interface AstroDevServer {
  host: string;
  port: number;
  url: string;
  watcher: Awaited<ReturnType<typeof astroDev>>["watcher"];
  update(site: ResolvedSite): Promise<Diagnostic[]>;
  showDiagnostics(diagnostics: Diagnostic[]): Promise<void>;
  stop(): Promise<void>;
}

const GENERATED_DIR = ".site/astro";
const rendererRequire = createRequire(import.meta.url);

/**
 * SiteSpec intentionally owns the Astro runtime; generated sites only depend on
 * @sitespec/cli. Astro transforms generated .astro files into modules that use
 * bare `astro/*` runtime imports. When the rendered project is outside the
 * renderer package tree (for example a temp fixture or a standalone site), Vite
 * would otherwise try to resolve those imports from the site root. Resolve all
 * exported Astro subpaths from @sitespec/astro's dependency context instead.
 */
function astroRuntimeResolverPlugin() {
  return {
    name: "sitespec:astro-runtime-resolver",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (!source.startsWith("astro/")) return null;
      try {
        return rendererRequire.resolve(source);
      } catch {
        return null;
      }
    }
  };
}


export interface AstroComponentContractOptions {
  root: string;
  registry: Map<string, RegisteredComponent>;
  uiRegistry?: Map<string, RegisteredUiPrimitive>;
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readUiSource(root: string, primitive: RegisteredUiPrimitive): Promise<{ file: string; source?: string; diagnostic?: Diagnostic }> {
  const file = join(root, primitive.implementation);
  try {
    return { file: relative(root, file), source: await readFile(file, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      file: relative(root, file),
      diagnostic: {
        code: code === "ENOENT" ? "UI_IMPLEMENTATION_MISSING" : "UI_IMPLEMENTATION_READ_FAILED",
        severity: "error",
        file: relative(root, file),
        message: code === "ENOENT"
          ? `Astro implementation for UI primitive "${primitive.id}" was not found.`
          : error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function readComponentSource(root: string, component: RegisteredComponent): Promise<{ file: string; source?: string; diagnostic?: Diagnostic }> {
  const file = join(root, "components", component.id, "index.astro");
  try {
    return { file: relative(root, file), source: await readFile(file, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      file: relative(root, file),
      diagnostic: {
        code: code === "ENOENT" ? "RENDERER_COMPONENT_IMPLEMENTATION_MISSING" : "RENDERER_COMPONENT_IMPLEMENTATION_READ_FAILED",
        severity: "error",
        file: relative(root, file),
        component: component.id,
        message: code === "ENOENT"
          ? `Astro implementation for component "${component.id}" was not found.`
          : error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function validateAstroComponentContracts(options: AstroComponentContractOptions): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  const contract = await loadDesignSystemContract(options.root);
  const shellEntries = contract.designSystem
    ? [...new Set(Object.values(contract.designSystem.value.shells.items).map(shell => shell.entry))].sort()
    : ["shell/default.astro"];

  for (const shellEntry of shellEntries) {
    const shellFile = join(options.root, shellEntry);
    try {
      const shellSource = await readFile(shellFile, "utf8");
      if (!/<slot(?:\s|\/>|>)/i.test(shellSource)) {
        diagnostics.push({
          code: "SHELL_SLOT_MISSING",
          severity: "error",
          file: shellEntry,
          message: `Site shell ${shellEntry} must render <slot /> so page sections remain visible.`,
          expected: "<slot />",
          suggestions: [{
            action: "restore-shell-slot",
            file: shellEntry,
            message: "Render <slot /> at the point where page sections should appear."
          }]
        });
      }
    } catch (error) {
      diagnostics.push({
        code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "SHELL_IMPLEMENTATION_MISSING" : "SHELL_IMPLEMENTATION_READ_FAILED",
        severity: "error",
        file: shellEntry,
        message: (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Site shell ${shellEntry} was not found.`
          : error instanceof Error ? error.message : String(error),
        suggestions: [{
          action: "restore-site-shell",
          file: shellEntry,
          message: "Restore the user-owned shell pack entry. Renderer code must not contain header/footer presentation."
        }]
      });
    }
  }

  for (const component of [...options.registry.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const loaded = await readComponentSource(options.root, component);
    if (loaded.diagnostic) {
      diagnostics.push(loaded.diagnostic);
      continue;
    }

    const source = loaded.source!;
    const requiredMarkers: Array<[string, string]> = [
      ["data-section={sectionId}", "data-section={sectionId}"],
      [`data-component="${component.id}"`, `data-component="${component.id}"`],
      ["data-variant={variant}", "data-variant={variant}"],
      ["data-theme={theme}", "data-theme={theme}"]
    ];

    for (const [needle, label] of requiredMarkers) {
      if (!source.includes(needle)) {
        diagnostics.push({
          code: "COMPONENT_CONTRACT_IDENTITY_MISSING",
          severity: "error",
          file: loaded.file,
          component: component.id,
          message: `Component "${component.id}" must render ${label} on its section root.`
        });
      }
    }

    const h1Count = countMatches(source, /<h1(?:\s|>)/gi);
    if (component.manifest.semantics?.pageHeading === true && h1Count !== 1) {
      diagnostics.push({
        code: "COMPONENT_CONTRACT_PAGE_HEADING_INVALID",
        severity: "error",
        file: loaded.file,
        component: component.id,
        message: `Component "${component.id}" declares semantics.pageHeading=true and must render exactly one <h1>; found ${h1Count}.`
      });
    }
    if (component.manifest.semantics?.pageHeading !== true && h1Count > 0) {
      diagnostics.push({
        code: "COMPONENT_CONTRACT_UNDECLARED_H1",
        severity: "error",
        file: loaded.file,
        component: component.id,
        message: `Component "${component.id}" renders <h1> but does not declare semantics.pageHeading=true.`
      });
    }

    const imageTags = source.match(/<img\b[^>]*>/gi) ?? [];
    for (const tag of imageTags) {
      if (!/\balt\s*=/.test(tag)) {
        diagnostics.push({
          code: "COMPONENT_CONTRACT_IMAGE_ALT_MISSING",
          severity: "error",
          file: loaded.file,
          component: component.id,
          message: `Component "${component.id}" contains an <img> without an alt attribute.`
        });
      }
      if (component.manifest.specVersion === "0.5" && (!/\bwidth\s*=/.test(tag) || !/\bheight\s*=/.test(tag))) {
        diagnostics.push({
          code: "COMPONENT_CONTRACT_IMAGE_DIMENSIONS_MISSING",
          severity: "error",
          file: loaded.file,
          component: component.id,
          message: `SiteSpec 0.5 components must render explicit width and height on raw <img> elements. Prefer @site-generated/components/SiteImage.astro for responsive media.`
        });
      }
    }

    const allowsJavascript = component.manifest.runtime?.javascript === true;
    const hasScript = /<script(?:\s|>)/i.test(source);
    const hasClientDirective = /\bclient:[a-z-]+\s*=/i.test(source);
    if (!allowsJavascript && (hasScript || hasClientDirective)) {
      diagnostics.push({
        code: "COMPONENT_CONTRACT_JAVASCRIPT_FORBIDDEN",
        severity: "error",
        file: loaded.file,
        component: component.id,
        message: `Component "${component.id}" ships client JavaScript but runtime.javascript is not true.`,
        hint: "Remove the client JavaScript or declare runtime.javascript: true in component.yaml."
      });
    }
  }

  for (const primitive of [...(options.uiRegistry?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const loaded = await readUiSource(options.root, primitive);
    if (loaded.diagnostic) {
      diagnostics.push(loaded.diagnostic);
      continue;
    }

    const source = loaded.source!;
    if (!source.includes(`data-ui="${primitive.id}"`)) {
      diagnostics.push({
        code: "UI_CONTRACT_IDENTITY_MISSING",
        severity: "error",
        file: loaded.file,
        message: `UI primitive "${primitive.id}" must render data-ui="${primitive.id}" on its root element.`
      });
    }
    if (!source.includes("data-variant={variant}")) {
      diagnostics.push({
        code: "UI_CONTRACT_VARIANT_MISSING",
        severity: "error",
        file: loaded.file,
        message: `UI primitive "${primitive.id}" must expose data-variant={variant} on its root element.`
      });
    }

    for (const tag of source.match(/<img\b[^>]*>/gi) ?? []) {
      if (!/\balt\s*=/.test(tag)) {
        diagnostics.push({
          code: "UI_CONTRACT_IMAGE_ALT_MISSING",
          severity: "error",
          file: loaded.file,
          message: `UI primitive "${primitive.id}" contains an <img> without an alt attribute.`
        });
      }
      if (primitive.manifest.specVersion === "0.5" && (!/\bwidth\s*=/.test(tag) || !/\bheight\s*=/.test(tag))) {
        diagnostics.push({
          code: "UI_CONTRACT_IMAGE_DIMENSIONS_MISSING",
          severity: "error",
          file: loaded.file,
          message: `SiteSpec 0.5 UI primitives must render explicit width and height on raw <img> elements.`
        });
      }
    }

    const allowsJavascript = primitive.manifest.runtime?.javascript === true;
    const hasScript = /<script(?:\s|>)/i.test(source);
    const hasClientDirective = /\bclient:[a-z-]+\s*=/i.test(source);
    if (!allowsJavascript && (hasScript || hasClientDirective)) {
      diagnostics.push({
        code: "UI_CONTRACT_JAVASCRIPT_FORBIDDEN",
        severity: "error",
        file: loaded.file,
        message: `UI primitive "${primitive.id}" ships client JavaScript but runtime.javascript is not true.`,
        hint: "Remove the client JavaScript or declare runtime.javascript: true in ui.yaml."
      });
    }
  }

  return diagnostics;
}

function outputPageFile(outDir: string, route: string): string {
  if (route === "/") return join(outDir, "index.html");
  return join(outDir, ...route.slice(1).split("/"), "index.html");
}

function hasLinkRelHref(html: string, relValue: string, hrefValue: string): boolean {
  return (html.match(/<link\b[^>]*>/gi) ?? []).some(tag => {
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.split(/\s+/) ?? [];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    return rel.includes(relValue) && href === hrefValue;
  });
}

function hasLinkHreflangHref(html: string, language: string, hrefValue: string): boolean {
  return (html.match(/<link\b[^>]*>/gi) ?? []).some(tag => {
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.split(/\s+/) ?? [];
    const hreflang = tag.match(/\bhreflang=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    return rel.includes("alternate") && hreflang === language && href === hrefValue;
  });
}

function hasMetaContent(html: string, attribute: "name" | "property", key: string, content: string): boolean {
  return (html.match(/<meta\b[^>]*>/gi) ?? []).some(tag => {
    const tagKey = tag.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
    const tagContent = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    return tagKey === key && tagContent === content;
  });
}

export async function validateAstroBuildOutput(options: AstroComponentContractOptions & { outDir: string; site: ResolvedSite }): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  for (const page of options.site.pages.filter(page => page.state === "published")) {
    const file = outputPageFile(options.outDir, page.route);
    let html: string;
    try {
      html = await readFile(file, "utf8");
    } catch (error) {
      diagnostics.push({
        code: "RENDERER_OUTPUT_PAGE_MISSING",
        severity: "error",
        file: relative(options.root, file),
        page: page.id,
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const basePath = siteBasePath(options.site.site.url);
    const expectedFavicon = rebaseSitePath(options.site.assets.favicon, basePath);
    if (!hasLinkRelHref(html, "icon", expectedFavicon)) {
      diagnostics.push({
        code: "RENDERER_FAVICON_MISSING",
        severity: "error",
        file: relative(options.root, file),
        page: page.id,
        message: `Rendered page must include favicon ${JSON.stringify(expectedFavicon)} from Site Spec assets.favicon.`,
        expected: expectedFavicon
      });
    }

    if (!hasLinkRelHref(html, "canonical", page.seo.canonical)) {
      diagnostics.push({
        code: "RENDERER_CANONICAL_MISSING",
        severity: "error",
        file: relative(options.root, file),
        page: page.id,
        message: `Rendered page must include canonical ${JSON.stringify(page.seo.canonical)}.`
      });
    }
    if (!hasMetaContent(html, "name", "description", page.seo.description)) {
      diagnostics.push({
        code: "RENDERER_META_DESCRIPTION_MISSING",
        severity: "error",
        file: relative(options.root, file),
        page: page.id,
        message: "Rendered page is missing its resolved meta description."
      });
    }
    for (const [language, href] of Object.entries(page.seo.hreflang)) {
      if (!hasLinkHreflangHref(html, language, href)) {
        diagnostics.push({
          code: "RENDERER_HREFLANG_MISSING",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: `Rendered page is missing hreflang ${JSON.stringify(language)} -> ${JSON.stringify(href)}.`
        });
      }
    }
    const requiredMeta: Array<["name" | "property", string, string]> = [
      ["property", "og:type", page.seo.openGraph.type],
      ["property", "og:title", page.seo.openGraph.title],
      ["property", "og:description", page.seo.openGraph.description],
      ["property", "og:url", page.seo.openGraph.url],
      ["name", "twitter:card", page.seo.twitter.card]
    ];
    for (const [attribute, key, content] of requiredMeta) {
      if (!hasMetaContent(html, attribute, key, content)) {
        diagnostics.push({
          code: "RENDERER_SOCIAL_META_MISSING",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: `Rendered page is missing ${key} metadata.`
        });
      }
    }
    if (options.site.specVersion === "0.5" && !/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(html)) {
      diagnostics.push({
        code: "RENDERER_JSON_LD_MISSING",
        severity: "error",
        file: relative(options.root, file),
        page: page.id,
        message: "SiteSpec 0.5 pages must render JSON-LD structured data."
      });
    }

    if (options.site.assets.appleTouchIcon) {
      const expectedAppleTouchIcon = rebaseSitePath(options.site.assets.appleTouchIcon, basePath);
      if (!hasLinkRelHref(html, "apple-touch-icon", expectedAppleTouchIcon)) {
        diagnostics.push({
          code: "RENDERER_APPLE_TOUCH_ICON_MISSING",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: `Rendered page must include apple touch icon ${JSON.stringify(expectedAppleTouchIcon)} from Site Spec assets.appleTouchIcon.`,
          expected: expectedAppleTouchIcon
        });
      }
    }

    for (const section of page.sections) {
      const sectionPattern = new RegExp(`<[^>]+\\bdata-section="${escapeRegExp(section.id)}"[^>]*>`, "i");
      const openingTag = html.match(sectionPattern)?.[0];
      if (!openingTag) {
        diagnostics.push({
          code: "RENDERER_SECTION_IDENTITY_MISSING",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          section: section.id,
          component: section.component,
          message: `Rendered page is missing data-section="${section.id}".`
        });
        continue;
      }

      const expected = [
        `data-component="${section.component}"`,
        `data-variant="${section.variant}"`,
        `data-theme="${section.theme}"`
      ];
      for (const marker of expected) {
        if (!openingTag.includes(marker)) {
          diagnostics.push({
            code: "RENDERER_SECTION_IDENTITY_MISMATCH",
            severity: "error",
            file: relative(options.root, file),
            page: page.id,
            section: section.id,
            component: section.component,
            message: `Rendered section "${section.id}" must contain ${marker}.`
          });
        }
      }
    }

    if (page.archetype !== "blank") {
      const h1Count = countMatches(html, /<h1(?:\s|>)/gi);
      if (h1Count !== 1) {
        diagnostics.push({
          code: "RENDERER_PAGE_HEADING_INVALID",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: `Rendered page must contain exactly one <h1>; found ${h1Count}.`
        });
      }
    }

    for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
      if (!/\balt=/.test(tag)) {
        diagnostics.push({
          code: "RENDERER_IMAGE_ALT_MISSING",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: "Rendered page contains an <img> without an alt attribute."
        });
      }
      if (options.site.specVersion === "0.5" && (!/\bwidth=["'][1-9][0-9]*["']/i.test(tag) || !/\bheight=["'][1-9][0-9]*["']/i.test(tag))) {
        diagnostics.push({
          code: "RENDERER_IMAGE_DIMENSIONS_MISSING",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: "SiteSpec 0.5 rendered images must include numeric width and height attributes to prevent layout shifts."
        });
      }
    }

    if (basePath) {
      const attributes = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)];
      for (const match of attributes) {
        const value = match[1]!;
        if (!value.startsWith("/") || value.startsWith("//")) continue;
        if (value === basePath || value.startsWith(`${basePath}/`)) continue;
        diagnostics.push({
          code: "RENDERER_BASE_PATH_BYPASS",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: `Rendered root-relative URL ${JSON.stringify(value)} bypasses deployment base path ${JSON.stringify(basePath)}.`,
          hint: "Pass internal URLs through Site Spec props instead of hardcoding root-relative href/src values in components."
        });
      }
    }

    const allowsJavascript = page.sections.some(section => options.registry.get(section.component)?.manifest.runtime?.javascript === true);
    if (!allowsJavascript) {
      const executableScripts = (html.match(/<script\b[^>]*>/gi) ?? [])
        .filter(tag => !/type=["']application\/ld\+json["']/i.test(tag));
      if (executableScripts.length > 0) {
        diagnostics.push({
          code: "RENDERER_UNDECLARED_JAVASCRIPT",
          severity: "error",
          file: relative(options.root, file),
          page: page.id,
          message: `Rendered page contains ${executableScripts.length} executable script tag(s), but none of its sections declare runtime.javascript=true.`
        });
      }
    }
  }

  return diagnostics;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cssName(parts: string[]): string {
  return parts
    .join("-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function tokenValueToCss(value: unknown): string | undefined {
  if (typeof value === "string") {
    const alias = value.match(/^\{([a-zA-Z0-9._-]+)\}$/);
    if (alias) return `var(--${cssName(alias[1]!.split("."))})`;
    return value;
  }
  if (typeof value === "number") return String(value);
  return undefined;
}

function collectTokens(
  value: unknown,
  path: string[],
  out: Array<{ name: string; value: string }>,
  diagnostics: Diagnostic[]
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if ("$value" in record) {
    const cssValue = tokenValueToCss(record.$value);
    if (cssValue === undefined) {
      diagnostics.push({
        code: "RENDERER_TOKEN_VALUE_UNSUPPORTED",
        severity: "error",
        file: "design/tokens.json",
        path: `/${path.join("/")}/$value`,
        message: `Token "${path.join(".")}" must resolve to a string or number in Site Spec v0.2.`
      });
      return;
    }
    const outputPath = path[0] === "semantic" ? path.slice(1) : path;
    out.push({ name: cssName(outputPath), value: cssValue });
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith("$")) continue;
    collectTokens(child, [...path, key], out, diagnostics);
  }
}


function cssString(value: string): string {
  return JSON.stringify(value);
}

async function compileFonts(root: string, generatedSrc: string, siteUrl: string, diagnostics: Diagnostic[]): Promise<void> {
  const loaded = await loadDesignFonts(root);
  diagnostics.push(...loaded.diagnostics);
  const basePath = siteBasePath(siteUrl);
  const blocks: string[] = [];

  for (const family of loaded.fonts) {
    for (const source of family.sources) {
      const src = rebaseSitePath(source.src, basePath);
      blocks.push(`@font-face {\n  font-family: ${cssString(family.family)};\n  src: url(${cssString(src)}) format(${cssString(source.format)});\n  font-style: ${source.style};\n  font-weight: ${source.weight};\n  font-display: ${source.display};\n}`);
    }
  }

  await writeFile(join(generatedSrc, "styles", "fonts.css"), blocks.length ? `${blocks.join("\n\n")}\n` : "", "utf8");
}

async function compileTokens(root: string, generatedSrc: string, diagnostics: Diagnostic[]): Promise<void> {
  const loaded = await inspectDesign(root);
  diagnostics.push(...loaded.diagnostics);
  if (loaded.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
    await writeFile(join(generatedSrc, "styles", "tokens.css"), ":root {}\n", "utf8");
    return;
  }

  const valueFor = (token: { value: string | number; alias?: string }): string => {
    if (token.alias) return `var(--${cssName(token.alias.split("."))})`;
    return String(token.value);
  };
  const baseTokens = [...loaded.design.primitive, ...loaded.design.semantic]
    .sort((a, b) => a.cssVariable.localeCompare(b.cssVariable));
  const baseBody = baseTokens.map(token => `  ${token.cssVariable}: ${valueFor(token)};`).join("\n");
  const blocks = [`:root {\n${baseBody}\n}`];

  for (const theme of loaded.design.themes.items) {
    if (theme.overrides.length === 0) continue;
    const body = theme.overrides
      .map(token => `  ${token.cssVariable}: ${valueFor(token)};`)
      .join("\n");
    blocks.push(`${theme.selector} {\n${body}\n}`);
  }

  await writeFile(join(generatedSrc, "styles", "tokens.css"), `${blocks.join("\n\n")}\n`, "utf8");
}

interface RenderImageSource {
  type: string;
  srcset: string;
}

interface RenderImageRecord extends Record<string, unknown> {
  src: string;
  alt?: string;
  decorative?: boolean;
  width?: number;
  height?: number;
  sizes?: string;
  widths?: number[];
  formats?: Array<"avif" | "webp">;
  quality?: number;
  loading?: "eager" | "lazy";
  decoding?: "async" | "sync" | "auto";
  fetchPriority?: "high" | "low" | "auto";
  crop?: {
    aspectRatio: string;
    focalPoint?: { x: number; y: number };
  };
  srcset?: string;
  sources?: RenderImageSource[];
  aspectRatio?: number;
  originalSrc?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function looksLikeImage(value: unknown): value is RenderImageRecord {
  if (!isPlainObject(value) || typeof value.src !== "string") return false;
  let pathname = value.src;
  try {
    if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname;
  } catch {
    return false;
  }
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(pathname.split(/[?#]/, 1)[0] ?? "")) return true;
  return ["alt", "decorative", "width", "height", "sizes", "widths", "formats", "quality", "loading", "decoding", "fetchPriority", "crop"]
    .some(key => key in value);
}

function safePublicPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%") || value.includes("\0")) return false;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 && !parts.some(part => part === "." || part === "..");
}

function ratioFromCrop(crop: RenderImageRecord["crop"]): number | undefined {
  const match = crop?.aspectRatio.match(/^([1-9][0-9]{0,3}):([1-9][0-9]{0,3})$/);
  return match ? Number(match[1]) / Number(match[2]) : undefined;
}

function orientedDimensions(width: number, height: number, orientation?: number): { width: number; height: number } {
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

function cropRectangle(
  width: number,
  height: number,
  ratio: number,
  focalPoint: { x: number; y: number } = { x: 0.5, y: 0.5 }
): { left: number; top: number; width: number; height: number } {
  const current = width / height;
  if (Math.abs(current - ratio) < 0.0001) return { left: 0, top: 0, width, height };
  if (current > ratio) {
    const cropWidth = Math.max(1, Math.round(height * ratio));
    const center = focalPoint.x * width;
    const left = Math.max(0, Math.min(width - cropWidth, Math.round(center - cropWidth / 2)));
    return { left, top: 0, width: cropWidth, height };
  }
  const cropHeight = Math.max(1, Math.round(width / ratio));
  const center = focalPoint.y * height;
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(center - cropHeight / 2)));
  return { left: 0, top, width, height: cropHeight };
}

function mimeForFormat(format: string): string {
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "svg") return "image/svg+xml";
  return `image/${format}`;
}

function normalizedImageFormat(format: string | undefined): "avif" | "webp" | "jpeg" | "png" | undefined {
  if (format === "jpg" || format === "jpeg") return "jpeg";
  if (format === "avif" || format === "webp" || format === "png") return format;
  return undefined;
}

function formatExtension(format: "avif" | "webp" | "jpeg" | "png"): string {
  return format === "jpeg" ? "jpg" : format;
}

function applySharpFormat(
  pipeline: SharpPipeline,
  format: "avif" | "webp" | "jpeg" | "png",
  quality: number
): SharpPipeline {
  if (format === "avif") return pipeline.avif({ quality });
  if (format === "webp") return pipeline.webp({ quality });
  if (format === "jpeg") return pipeline.jpeg({ quality, mozjpeg: true });
  return pipeline.png({ quality });
}

function mediaOutputParts(output: string): string[] {
  return output.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

async function renderDerivative(
  sourceFile: string,
  outFile: string,
  width: number,
  format: "avif" | "webp" | "jpeg" | "png",
  quality: number,
  crop?: { left: number; top: number; width: number; height: number }
): Promise<void> {
  let pipeline = sharp(sourceFile, { animated: false }).rotate();
  if (crop) pipeline = pipeline.extract(crop);
  pipeline = pipeline.resize({ width, withoutEnlargement: true });
  await applySharpFormat(pipeline, format, quality).toFile(outFile);
}

async function prepareImage(
  root: string,
  generatedPublic: string,
  site: ResolvedSite,
  image: RenderImageRecord,
  cache: Map<string, RenderImageRecord>,
  diagnostics: Diagnostic[]
): Promise<RenderImageRecord> {
  if (/^https?:\/\//i.test(image.src)) {
    return {
      ...image,
      alt: image.decorative ? "" : image.alt,
      loading: image.loading ?? "lazy",
      decoding: image.decoding ?? "async",
      aspectRatio: image.width && image.height ? image.width / image.height : undefined
    };
  }
  if (!safePublicPath(image.src)) return image;

  const sourceFile = join(root, "public", ...image.src.slice(1).split("/"));
  let metadata: SharpMetadata;
  let bytes: Buffer;
  try {
    [metadata, bytes] = await Promise.all([
      sharp(sourceFile, { animated: true }).metadata(),
      readFile(sourceFile)
    ]);
  } catch (error) {
    diagnostics.push({
      code: "MEDIA_RENDER_READ_FAILED",
      severity: "error",
      sourceFile: `public${image.src}`,
      message: error instanceof Error ? error.message : String(error)
    });
    return image;
  }

  if (!metadata.width || !metadata.height) return image;
  const oriented = orientedDimensions(metadata.width, metadata.height, metadata.orientation);
  const cropRatio = ratioFromCrop(image.crop);
  const crop = cropRatio
    ? cropRectangle(oriented.width, oriented.height, cropRatio, image.crop?.focalPoint)
    : undefined;
  const outputRatio = cropRatio ?? (oriented.width / oriented.height);
  const maxWidth = crop?.width ?? oriented.width;
  const requestedWidths = image.widths?.length ? image.widths : site.media.widths;
  const widths = [...new Set([...requestedWidths, maxWidth])]
    .filter(width => Number.isInteger(width) && width > 0 && width <= maxWidth)
    .sort((a, b) => a - b);
  if (widths.length === 0) widths.push(maxWidth);

  const formats = [...new Set(image.formats?.length ? image.formats : site.media.formats)];
  const sourceFormat = normalizedImageFormat(metadata.format);
  const fallbackFormat = sourceFormat ?? (metadata.format === "svg" ? "png" : undefined);
  const sourceAnimated = (metadata.pages ?? 1) > 1;
  if (sourceAnimated) {
    if (image.crop || image.widths?.length || image.formats?.length) diagnostics.push({
      code: "MEDIA_ANIMATED_PASSTHROUGH",
      severity: "warning",
      sourceFile: `public${image.src}`,
      message: `Animated image ${image.src} is kept as-is; responsive transforms and cropping are not applied.`
    });
    return {
      ...image,
      width: oriented.width,
      height: oriented.height,
      aspectRatio: oriented.width / oriented.height,
      loading: image.loading ?? "lazy",
      decoding: image.decoding ?? "async"
    };
  }

  const signature = JSON.stringify({
    src: image.src,
    content: createHash("sha256").update(bytes).digest("hex"),
    crop: image.crop,
    widths,
    formats,
    sizes: image.sizes,
    quality: image.quality,
    siteQuality: site.media.quality
  });
  const cacheKey = createHash("sha256").update(signature).digest("hex");
  const cached = cache.get(cacheKey);
  if (cached) return {
    ...cached,
    alt: image.decorative ? "" : image.alt,
    sizes: image.sizes ?? cached.sizes,
    loading: image.loading ?? cached.loading,
    decoding: image.decoding ?? cached.decoding,
    fetchPriority: image.fetchPriority
  };

  const hash = cacheKey.slice(0, 12);
  const outputParts = mediaOutputParts(site.media.output);
  if (outputParts.some(part => part === "." || part === "..")) {
    diagnostics.push({
      code: "MEDIA_OUTPUT_PATH_INVALID",
      severity: "error",
      file: "site.yaml",
      path: "/media/output",
      message: `media.output must be a safe public path; received ${JSON.stringify(site.media.output)}.`
    });
    return image;
  }
  const outputDir = join(generatedPublic, ...outputParts, hash);
  await mkdir(outputDir, { recursive: true });
  const rawStem = basename(image.src, extname(image.src));
  const stem = rawStem.replace(/[^A-Za-z0-9_-]+/g, "-") || "image";
  const urlBase = `/${[...outputParts, hash].join("/")}`;

  const sourceSets: RenderImageSource[] = [];
  for (const format of formats) {
    const urls: string[] = [];
    for (const width of widths) {
      const extension = formatExtension(format);
      const filename = `${stem}-${width}.${extension}`;
      await renderDerivative(sourceFile, join(outputDir, filename), width, format, image.quality ?? site.media.quality[format], crop);
      urls.push(`${urlBase}/${filename} ${width}w`);
    }
    sourceSets.push({ type: mimeForFormat(format), srcset: urls.join(", ") });
  }

  let fallbackSrc = image.src;
  let fallbackSrcset: string | undefined;
  if (fallbackFormat) {
    const fallbackUrls: string[] = [];
    for (const width of widths) {
      const extension = formatExtension(fallbackFormat);
      const filename = `${stem}-${width}.${extension}`;
      const file = join(outputDir, filename);
      const quality = image.quality ?? site.media.quality[fallbackFormat];
      await renderDerivative(sourceFile, file, width, fallbackFormat, quality, crop);
      fallbackUrls.push(`${urlBase}/${filename} ${width}w`);
    }
    fallbackSrcset = fallbackUrls.join(", ");
    fallbackSrc = fallbackUrls[fallbackUrls.length - 1]!.split(" ", 1)[0]!;
  }

  const rendered: RenderImageRecord = {
    ...image,
    originalSrc: image.src,
    src: fallbackSrc,
    alt: image.decorative ? "" : image.alt,
    width: maxWidth,
    height: Math.max(1, Math.round(maxWidth / outputRatio)),
    aspectRatio: outputRatio,
    sizes: image.sizes ?? "100vw",
    srcset: fallbackSrcset,
    sources: sourceSets,
    loading: image.loading ?? "lazy",
    decoding: image.decoding ?? "async",
    fetchPriority: image.fetchPriority
  };
  cache.set(cacheKey, rendered);
  return rendered;
}

async function prepareMediaValue(
  root: string,
  generatedPublic: string,
  site: ResolvedSite,
  value: unknown,
  cache: Map<string, RenderImageRecord>,
  diagnostics: Diagnostic[]
): Promise<unknown> {
  if (looksLikeImage(value)) return prepareImage(root, generatedPublic, site, value, cache, diagnostics);
  if (Array.isArray(value)) return Promise.all(value.map(item => prepareMediaValue(root, generatedPublic, site, item, cache, diagnostics)));
  if (!isPlainObject(value)) return value;
  const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => [
    key,
    await prepareMediaValue(root, generatedPublic, site, child, cache, diagnostics)
  ] as const));
  return Object.fromEntries(entries);
}

async function prepareMediaSite(
  root: string,
  generatedPublic: string,
  site: ResolvedSite,
  diagnostics: Diagnostic[]
): Promise<ResolvedSite> {
  if (site.specVersion !== "0.5") return site;
  const cache = new Map<string, RenderImageRecord>();
  const pages = await Promise.all(site.pages.map(async page => ({
    ...page,
    sections: await Promise.all(page.sections.map(async section => ({
      ...section,
      props: await prepareMediaValue(root, generatedPublic, site, section.props, cache, diagnostics) as Record<string, unknown>
    }))),
    content: page.content ? {
      entry: page.content.entry
        ? await prepareMediaValue(root, generatedPublic, site, page.content.entry, cache, diagnostics) as Record<string, unknown>
        : undefined,
      queries: Object.fromEntries(await Promise.all(Object.entries(page.content.queries).map(async ([id, query]) => [
        id,
        {
          ...query,
          items: await prepareMediaValue(root, generatedPublic, site, query.items, cache, diagnostics) as Record<string, unknown>[]
        }
      ] as const)))
    } : undefined
  })));
  return { ...site, pages };
}

function siteImageSource(): string {
  return `---
interface ImageSource { type: string; srcset: string }
interface ImageValue {
  src: string;
  alt?: string;
  decorative?: boolean;
  width?: number;
  height?: number;
  sizes?: string;
  srcset?: string;
  sources?: ImageSource[];
  loading?: "eager" | "lazy";
  decoding?: "async" | "sync" | "auto";
  fetchPriority?: "high" | "low" | "auto";
}
interface Props { image: ImageValue; class?: string }
const { image, class: className } = Astro.props;
const alt = image.decorative ? "" : (image.alt ?? "");
---
<picture>
  {image.sources?.map((source) => <source type={source.type} srcset={source.srcset} sizes={image.sizes} />)}
  <img
    src={image.src}
    srcset={image.srcset}
    sizes={image.srcset ? image.sizes : undefined}
    alt={alt}
    width={image.width}
    height={image.height}
    loading={image.loading ?? "lazy"}
    decoding={image.decoding ?? "async"}
    fetchpriority={image.fetchPriority}
    class={className}
  />
</picture>

<style>
  img { max-width: 100%; height: auto; }
</style>
`;
}

function wrapSocialText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.join(" ").length > lines.join(" ").length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/[.…]+$/, "")}…`;
  }
  return lines;
}

async function writeGeneratedSocialImages(generatedPublic: string, site: ResolvedSite, diagnostics: Diagnostic[]): Promise<void> {
  for (const page of site.pages.filter(page => page.state === "published" && page.seo.socialImage?.generated)) {
    const social = page.seo.socialImage!;
    const parts = social.path.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.some(part => part === "." || part === "..")) continue;
    const file = join(generatedPublic, ...parts);
    await mkdir(dirname(file), { recursive: true });
    const width = social.width;
    const height = social.height;
    const titleLines = wrapSocialText(page.seo.openGraph.title, 34, 3);
    const descriptionLines = wrapSocialText(page.seo.openGraph.description, 58, 2);
    const titleSize = Math.max(44, Math.round(width / 18));
    const descriptionSize = Math.max(24, Math.round(width / 38));
    const left = Math.round(width * 0.07);
    const top = Math.round(height * 0.20);
    const titleSvg = titleLines.map((line, index) => `<tspan x="${left}" dy="${index === 0 ? 0 : Math.round(titleSize * 1.12)}">${escapeXml(line)}</tspan>`).join("");
    const descriptionY = top + titleLines.length * Math.round(titleSize * 1.12) + Math.round(height * 0.06);
    const descriptionSvg = descriptionLines.map((line, index) => `<tspan x="${left}" dy="${index === 0 ? 0 : Math.round(descriptionSize * 1.35)}">${escapeXml(line)}</tspan>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${site.seo.socialImages.background}"/>
<text x="${left}" y="${Math.round(height * 0.10)}" fill="${site.seo.socialImages.foreground}" font-family="Arial, Helvetica, sans-serif" font-size="${Math.max(22, Math.round(width / 48))}" font-weight="700">${escapeXml(site.seo.siteName)}</text>
<text x="${left}" y="${top}" fill="${site.seo.socialImages.foreground}" font-family="Arial, Helvetica, sans-serif" font-size="${titleSize}" font-weight="800">${titleSvg}</text>
<text x="${left}" y="${descriptionY}" fill="${site.seo.socialImages.foreground}" opacity="0.78" font-family="Arial, Helvetica, sans-serif" font-size="${descriptionSize}" font-weight="400">${descriptionSvg}</text>
</svg>`;
    try {
      let pipeline = sharp(Buffer.from(svg));
      if (social.format === "png") pipeline = pipeline.png();
      else if (social.format === "jpeg") pipeline = pipeline.jpeg({ quality: site.media.quality.jpeg, mozjpeg: true });
      else pipeline = pipeline.webp({ quality: site.media.quality.webp });
      await pipeline.toFile(file);
    } catch (error) {
      diagnostics.push({
        code: "SOCIAL_IMAGE_GENERATION_FAILED",
        severity: "error",
        page: page.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function syncPublicDirectory(root: string, generatedPublic: string): Promise<void> {
  await rm(generatedPublic, { recursive: true, force: true });
  try {
    await cp(join(root, "public"), generatedPublic, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(generatedPublic, { recursive: true });
  }
}

async function listAstroFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".astro")) files.push(child);
    }
  }
  await walk(root);
  return files;
}

function layoutSource(): string {
  return `---
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/global.css";

const { page, assets, designSystem, jsonLd, siteSeo } = Astro.props;
---
<!doctype html>
<html lang={page.locale} data-site-theme={designSystem?.theme}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="SiteSpec" />
    <title>{page.seo.title}</title>
    <meta name="description" content={page.seo.description} />
    <link rel="canonical" href={page.seo.canonical} />
    <link rel="icon" href={assets.favicon} />
    {assets.appleTouchIcon && <link rel="apple-touch-icon" href={assets.appleTouchIcon} />}
    {page.seo.noindex && <meta name="robots" content="noindex, nofollow" />}
    {Object.entries(page.seo.hreflang ?? {}).map(([language, href]) => (
      <link rel="alternate" hreflang={language} href={href} />
    ))}
    {siteSeo?.rss?.enabled && <link rel="alternate" type="application/rss+xml" title={siteSeo.rss.title} href={siteSeo.rss.url} />}
    {siteSeo?.llms?.enabled && <link rel="describedby" href={siteSeo.llms.url} />}

    <meta property="og:type" content={page.seo.openGraph.type} />
    <meta property="og:title" content={page.seo.openGraph.title} />
    <meta property="og:description" content={page.seo.openGraph.description} />
    <meta property="og:url" content={page.seo.openGraph.url} />
    <meta property="og:site_name" content={page.seo.openGraph.siteName} />
    <meta property="og:locale" content={page.seo.openGraph.locale} />
    {page.seo.openGraph.image && <meta property="og:image" content={page.seo.openGraph.image} />}
    {page.seo.openGraph.imageWidth && <meta property="og:image:width" content={String(page.seo.openGraph.imageWidth)} />}
    {page.seo.openGraph.imageHeight && <meta property="og:image:height" content={String(page.seo.openGraph.imageHeight)} />}

    <meta name="twitter:card" content={page.seo.twitter.card} />
    <meta name="twitter:title" content={page.seo.twitter.title} />
    <meta name="twitter:description" content={page.seo.twitter.description} />
    {page.seo.twitter.image && <meta name="twitter:image" content={page.seo.twitter.image} />}

    {jsonLd && <script is:inline type="application/ld+json" set:html={jsonLd}></script>}
  </head>
  <body>
    <slot />
  </body>
</html>
`;
}

function globalCssSource(): string {
  return "";
}

function pageFilePath(generatedSrc: string, route: string): string {
  if (route === "/") return join(generatedSrc, "pages", "index.astro");
  return join(generatedSrc, "pages", ...route.slice(1).split("/"), "index.astro");
}


function siteBasePath(siteUrl: string): string {
  const pathname = new URL(siteUrl).pathname.replace(/\/+$/, "");
  return pathname === "/" ? "" : pathname;
}

function astroSiteOrigin(siteUrl: string): string {
  return new URL(siteUrl).origin;
}

function rebaseSitePath(value: string, basePath: string): string {
  if (!basePath || !value.startsWith("/") || value.startsWith("//")) return value;
  if (value === basePath || value.startsWith(`${basePath}/`)) return value;
  return value === "/" ? `${basePath}/` : `${basePath}${value}`;
}

function rebaseGeneratedHtml(value: string, basePath: string): string {
  if (!basePath) return value;
  return value.replace(/\b(href|src)="(\/[^"\s]*)"/g, (_match, attribute: string, path: string) => {
    return `${attribute}="${rebaseSitePath(path, basePath)}"`;
  });
}

function rebaseRenderValue(value: unknown, basePath: string): unknown {
  if (Array.isArray(value)) return value.map(item => rebaseRenderValue(item, basePath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if (key === "html" && typeof child === "string") {
      return [key, rebaseGeneratedHtml(child, basePath)];
    }
    if ((key === "href" || key.endsWith("Href") || key === "src") && typeof child === "string") {
      return [key, rebaseSitePath(child, basePath)];
    }
    if (key === "srcset" && typeof child === "string") {
      const rebased = child.split(",").map(candidate => {
        const trimmed = candidate.trim();
        const match = trimmed.match(/^(\S+)(\s+.+)?$/);
        return match ? `${rebaseSitePath(match[1]!, basePath)}${match[2] ?? ""}` : trimmed;
      }).join(", ");
      return [key, rebased];
    }
    return [key, rebaseRenderValue(child, basePath)];
  }));
}

function jsonLdForPage(page: ResolvedPage, site: ResolvedSite): string {
  const websiteId = `${site.site.url}/#website`;
  const webpageId = `${page.seo.canonical}#webpage`;
  const graph: Record<string, unknown>[] = [
    {
      "@type": "WebSite",
      "@id": websiteId,
      url: site.site.url,
      name: site.seo.siteName,
      inLanguage: site.site.locale
    },
    {
      "@type": "WebPage",
      "@id": webpageId,
      url: page.seo.canonical,
      name: page.seo.title,
      description: page.seo.description,
      inLanguage: page.locale,
      isPartOf: { "@id": websiteId }
    }
  ];

  if (page.archetype === "article" && !page.structuredData.some(item => item.type === "Article")) {
    const entryDate = page.content?.entry?.date;
    graph.push({
      "@type": "Article",
      headline: page.seo.openGraph.title,
      description: page.seo.openGraph.description,
      url: page.seo.canonical,
      mainEntityOfPage: { "@id": webpageId },
      ...(page.seo.image ? { image: page.seo.image } : {}),
      ...(typeof entryDate === "string" ? { datePublished: entryDate } : {})
    });
  }

  for (const item of page.structuredData) graph.push({ ...item.data, "@type": item.type });

  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function pageSource(page: ResolvedPage, site: ResolvedSite): string {
  const basePath = siteBasePath(site.site.url);
  const renderPage: ResolvedPage = {
    ...page,
    sections: page.sections.map(section => ({
      ...section,
      props: rebaseRenderValue(section.props, basePath) as Record<string, unknown>
    })),
    content: page.content ? rebaseRenderValue(page.content, basePath) as ResolvedPage["content"] : undefined
  };
  const renderSite = {
    ...site.site,
    homeHref: rebaseSitePath("/", basePath)
  };
  const renderBrand = {
    ...site.brand,
    logo: site.brand.logo ? rebaseSitePath(site.brand.logo, basePath) : undefined,
    logoDark: site.brand.logoDark ? rebaseSitePath(site.brand.logoDark, basePath) : undefined
  };
  const renderAssets = {
    ...site.assets,
    favicon: rebaseSitePath(site.assets.favicon, basePath),
    appleTouchIcon: site.assets.appleTouchIcon ? rebaseSitePath(site.assets.appleTouchIcon, basePath) : undefined
  };
  const renderNavigation = Object.fromEntries(Object.entries(site.navigation).map(([collection, items]) => [
    collection,
    items.map(item => ({
      ...item,
      href: rebaseSitePath(item.href, basePath),
      current: !item.external && ((item.href.split(/[?#]/, 1)[0] || "/") === page.route)
    }))
  ]));
  const jsonLd = jsonLdForPage(page, site);
  const siteSeo = {
    rss: {
      enabled: site.seo.rss.enabled,
      title: site.seo.rss.title,
      url: `${site.site.url}${site.seo.rss.path}`
    },
    llms: {
      enabled: site.seo.llms.enabled,
      url: `${site.site.url}/llms.txt`
    }
  };
  const unique = [...new Set(page.sections.map(section => section.component))];
  const shellEntry = site.designSystem?.shellEntry ?? "shell/default.astro";
  const variableFor = new Map(unique.map((component, index) => [component, `Section${index}`]));
  const imports = unique
    .map(component => `import ${variableFor.get(component)} from "@site-project/components/${component}/index.astro";`)
    .join("\n");
  const sectionMarkup = page.sections
    .map((section, index) => {
      const component = variableFor.get(section.component)!;
      return `  <${component}
    sectionId={page.sections[${index}].id}
    variant={page.sections[${index}].variant}
    theme={page.sections[${index}].theme}
    props={page.sections[${index}].props}
  />`;
    })
    .join("\n");

  return `---
import SiteLayout from "@site-generated/layouts/SiteLayout.astro";
import SiteShell from "@site-project/${shellEntry}";
${imports}

const site = ${JSON.stringify(renderSite, null, 2)};
const page = ${JSON.stringify(renderPage, null, 2)};
const brand = ${JSON.stringify(renderBrand, null, 2)};
const assets = ${JSON.stringify(renderAssets, null, 2)};
const navigation = ${JSON.stringify(renderNavigation, null, 2)};
const designSystem = ${JSON.stringify(site.designSystem)};
const jsonLd = ${JSON.stringify(jsonLd)};
const siteSeo = ${JSON.stringify(siteSeo, null, 2)};
---
<SiteLayout page={page} assets={assets} designSystem={designSystem} jsonLd={jsonLd} siteSeo={siteSeo}>
  <SiteShell site={site} brand={brand} page={page} navigation={navigation}>
${sectionMarkup}
  </SiteShell>
</SiteLayout>
`;
}

async function validateImplementations(root: string, site: ResolvedSite): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const used = new Set(
    site.pages
      .filter(page => page.state === "published")
      .flatMap(page => page.sections.map(section => section.component))
  );
  for (const component of [...used].sort()) {
    const file = join(root, "components", component, "index.astro");
    try {
      await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        diagnostics.push({
          code: "RENDERER_COMPONENT_IMPLEMENTATION_MISSING",
          severity: "error",
          file: relative(root, file),
          component,
          message: `Astro implementation for component "${component}" was not found.`
        });
      } else {
        diagnostics.push({
          code: "RENDERER_COMPONENT_IMPLEMENTATION_READ_FAILED",
          severity: "error",
          file: relative(root, file),
          component,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return diagnostics;
}

async function writeGeneratedProject(root: string, site: ResolvedSite, diagnostics: Diagnostic[]): Promise<string> {
  const generatedRoot = join(root, GENERATED_DIR);
  const generatedSrc = join(generatedRoot, "src");
  await rm(generatedRoot, { recursive: true, force: true });
  await syncGeneratedProject(root, site, diagnostics, { includeDrafts: false });
  return generatedSrc;
}

async function syncGeneratedProject(
  root: string,
  site: ResolvedSite,
  diagnostics: Diagnostic[],
  options: { includeDrafts: boolean }
): Promise<string> {
  const generatedRoot = join(root, GENERATED_DIR);
  const generatedSrc = join(generatedRoot, "src");
  const generatedPublic = join(generatedRoot, "public");
  await mkdir(join(generatedSrc, "pages"), { recursive: true });
  await mkdir(join(generatedSrc, "layouts"), { recursive: true });
  await mkdir(join(generatedSrc, "styles"), { recursive: true });
  await mkdir(join(generatedSrc, "components"), { recursive: true });

  await syncPublicDirectory(root, generatedPublic);
  const renderSite = await prepareMediaSite(root, generatedPublic, site, diagnostics);
  await writeGeneratedSocialImages(generatedPublic, renderSite, diagnostics);
  await writeGeneratedMetadata(generatedPublic, renderSite);
  await compileTokens(root, generatedSrc, diagnostics);
  await compileFonts(root, generatedSrc, renderSite.site.url, diagnostics);
  await writeFile(join(generatedSrc, "layouts", "SiteLayout.astro"), layoutSource(), "utf8");
  await writeFile(join(generatedSrc, "components", "SiteImage.astro"), siteImageSource(), "utf8");
  await writeFile(join(generatedSrc, "styles", "global.css"), globalCssSource(), "utf8");

  const pages = options.includeDrafts ? renderSite.pages : renderSite.pages.filter(page => page.state === "published");
  const desiredPageFiles = new Set<string>();
  for (const page of pages) {
    const file = pageFilePath(generatedSrc, page.route);
    desiredPageFiles.add(file);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pageSource(page, renderSite), "utf8");
  }

  for (const file of await listAstroFiles(join(generatedSrc, "pages"))) {
    if (!desiredPageFiles.has(file)) await rm(file, { force: true });
  }

  return generatedSrc;
}

function devDiagnosticLayoutSource(diagnostics: Diagnostic[]): string {
  const payload = JSON.stringify(diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    file: diagnostic.file,
    page: diagnostic.page,
    section: diagnostic.section,
    sourceFile: diagnostic.sourceFile,
    sourcePath: diagnostic.sourcePath,
    hint: diagnostic.hint
  })));
  return `---
const diagnostics = ${payload};
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="1" />
    <title>Site Spec diagnostics</title>
    <style>
      :root { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color-scheme: light dark; }
      body { margin: 0; padding: 32px; background: Canvas; color: CanvasText; }
      main { max-width: 960px; margin: 0 auto; }
      h1 { font: 700 28px/1.2 system-ui, sans-serif; margin: 0 0 8px; }
      .lead { opacity: .7; margin: 0 0 28px; }
      article { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 10px; padding: 16px; margin: 12px 0; }
      .code { font-weight: 700; }
      .where, .hint { opacity: .75; margin-top: 8px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Site Spec is temporarily invalid</h1>
      <p class="lead">The dev server is still running. This page refreshes automatically after the source is fixed.</p>
      {diagnostics.map((diagnostic) => (
        <article>
          <div class="code">{diagnostic.severity.toUpperCase()} {diagnostic.code}</div>
          <div>{diagnostic.message}</div>
          {(diagnostic.file || diagnostic.page || diagnostic.section) && (
            <div class="where">{[diagnostic.file, diagnostic.page, diagnostic.section].filter(Boolean).join(" :: ")}</div>
          )}
          {diagnostic.sourceFile && <div class="where">source: {diagnostic.sourceFile}{diagnostic.sourcePath ?? ""}</div>}
          {diagnostic.hint && <div class="hint">hint: {diagnostic.hint}</div>}
        </article>
      ))}
    </main>
  </body>
</html>
`;
}

async function writeDevDiagnostics(root: string, diagnostics: Diagnostic[]): Promise<string> {
  const generatedSrc = join(root, GENERATED_DIR, "src");
  await mkdir(join(generatedSrc, "pages"), { recursive: true });
  await mkdir(join(generatedSrc, "layouts"), { recursive: true });
  await mkdir(join(generatedSrc, "styles"), { recursive: true });
  await writeFile(join(generatedSrc, "layouts", "SiteLayout.astro"), devDiagnosticLayoutSource(diagnostics), "utf8");
  await writeFile(join(generatedSrc, "styles", "fonts.css"), "", "utf8");
  await writeFile(join(generatedSrc, "styles", "tokens.css"), ":root {}\n", "utf8");
  await writeFile(join(generatedSrc, "styles", "global.css"), globalCssSource(), "utf8");

  const pageFiles = await listAstroFiles(join(generatedSrc, "pages"));
  if (pageFiles.length === 0) {
    await writeFile(join(generatedSrc, "pages", "index.astro"), `---\nimport SiteLayout from "@site-generated/layouts/SiteLayout.astro";\n---\n<SiteLayout />\n`, "utf8");
  }
  await writeFile(join(generatedSrc, "pages", "404.astro"), `---\nimport SiteLayout from "@site-generated/layouts/SiteLayout.astro";\n---\n<SiteLayout />\n`, "utf8");
  return generatedSrc;
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startAstroDevServer(options: AstroDevOptions): Promise<AstroDevServer> {
  // Astro/Vite cache module metadata by normalized absolute path. On macOS,
  // paths under /var resolve physically under /private/var; mixing both spellings
  // makes Astro treat project-owned .astro files as outside config.root and breaks
  // virtual style-module metadata lookup. Canonicalize the project root once and
  // derive every renderer path/alias from that same physical path.
  const root = await realpath(options.root);
  const initialDiagnostics = options.diagnostics ?? [];
  let generatedSrc: string;
  if (options.site) {
    generatedSrc = await syncGeneratedProject(root, options.site, initialDiagnostics, { includeDrafts: true });
    if (initialDiagnostics.some(diagnostic => diagnostic.severity === "error")) {
      generatedSrc = await writeDevDiagnostics(root, initialDiagnostics);
    }
  } else {
    generatedSrc = await writeDevDiagnostics(root, initialDiagnostics);
  }

  const server = await astroDev({
    root,
    configFile: false,
    devToolbar: { enabled: false },
    srcDir: generatedSrc,
    publicDir: join(root, GENERATED_DIR, "public"),
    cacheDir: join(root, ".site", "astro-cache"),
    output: "static",
    site: options.site ? astroSiteOrigin(options.site.site.url) : undefined,
    base: options.site ? (siteBasePath(options.site.site.url) || "/") : "/",
    logLevel: options.logLevel ?? "warn",
    server: {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4321
    },
    vite: {
      envDir: join(root, GENERATED_DIR),
      cacheDir: join(root, ".site", "vite-cache"),
      plugins: [astroRuntimeResolverPlugin()],
      resolve: {
        alias: {
          "@site-project": root,
          "@site-generated": generatedSrc
        }
      }
    }
  });

  const address = server.address;
  const host = options.host ?? "127.0.0.1";
  const url = `http://${displayHost(host)}:${address.port}/`;

  return {
    host,
    port: address.port,
    url,
    watcher: server.watcher,
    update: async site => {
      const diagnostics: Diagnostic[] = [];
      await syncGeneratedProject(root, site, diagnostics, { includeDrafts: true });
      if (diagnostics.some(diagnostic => diagnostic.severity === "error")) {
        await writeDevDiagnostics(root, diagnostics);
      }
      return diagnostics;
    },
    showDiagnostics: diagnostics => writeDevDiagnostics(root, diagnostics).then(() => undefined),
    stop: () => server.stop()
  };
}

function safeMetadataOutputFile(outDir: string, publicPath: string): string | undefined {
  const parts = publicPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === "." || part === "..")) return undefined;
  return join(outDir, ...parts);
}

function rssDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toUTCString();
}

function sitemapLastmod(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.000Z$/, "Z");
}

function llmsText(site: ResolvedSite, pages: ResolvedPage[]): string {
  const description = site.seo.llms.description ?? site.seo.defaultDescription ?? `${site.site.name} website.`;
  const lines = [
    `# ${site.seo.siteName}`,
    "",
    `> ${description}`,
    "",
    "## Pages",
    ""
  ];
  for (const page of pages) {
    lines.push(`- [${page.seo.title}](${page.seo.canonical}): ${page.seo.description}`);
  }
  if (site.seo.rss.enabled) {
    lines.push("", "## Feeds", "", `- [RSS](${site.site.url}${site.seo.rss.path}): ${site.seo.rss.description}`);
  }
  return `${lines.join("\n")}\n`;
}

function rssXml(site: ResolvedSite, pages: ResolvedPage[]): string {
  const articles = pages
    .filter(page => page.archetype === "article")
    .sort((a, b) => {
      const aDate = typeof a.content?.entry?.date === "string" ? Date.parse(a.content.entry.date) : 0;
      const bDate = typeof b.content?.entry?.date === "string" ? Date.parse(b.content.entry.date) : 0;
      return bDate - aDate || a.route.localeCompare(b.route);
    });
  const feedUrl = `${site.site.url}${site.seo.rss.path}`;
  const items = articles.map(page => {
    const published = rssDate(page.content?.entry?.date);
    return `    <item>\n      <title>${escapeXml(page.seo.title)}</title>\n      <link>${escapeXml(page.seo.canonical)}</link>\n      <guid isPermaLink="true">${escapeXml(page.seo.canonical)}</guid>\n      <description>${escapeXml(page.seo.description)}</description>${published ? `\n      <pubDate>${escapeXml(published)}</pubDate>` : ""}\n    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(site.seo.rss.title)}</title>\n    <link>${escapeXml(site.site.url)}</link>\n    <description>${escapeXml(site.seo.rss.description)}</description>\n    <language>${escapeXml(site.site.locale)}</language>\n    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />${items ? `\n${items}` : ""}\n  </channel>\n</rss>\n`;
}

async function writeGeneratedMetadata(outDir: string, site: ResolvedSite): Promise<void> {
  const pages = site.pages
    .filter(page => page.state === "published" && !page.seo.noindex)
    .sort((a, b) => a.route.localeCompare(b.route));

  const sitemapFile = join(outDir, "sitemap.xml");
  if (site.seo.sitemap.enabled) {
    const hasAlternates = pages.some(page => Object.keys(page.seo.hreflang).length > 0);
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ""}>\n${pages
      .map(page => {
        const lastmod = sitemapLastmod(page.content?.entry?.date);
        const alternates = Object.entries(page.seo.hreflang)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([language, href]) => `\n    <xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(href)}" />`)
          .join("");
        return `  <url>\n    <loc>${escapeXml(page.seo.canonical)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}${alternates}\n  </url>`;
      })
      .join("\n")}\n</urlset>\n`;
    await writeFile(sitemapFile, sitemap, "utf8");
  } else {
    await rm(sitemapFile, { force: true });
  }

  const robotsLines: string[] = [];
  const rules = site.seo.robots.rules;
  if (!site.seo.robots.index) {
    robotsLines.push("User-agent: *", "Disallow: /", "");
  } else if (rules.length > 0) {
    for (const rule of rules) {
      robotsLines.push(`User-agent: ${rule.userAgent}`);
      for (const path of rule.allow ?? []) robotsLines.push(`Allow: ${path}`);
      for (const path of rule.disallow ?? []) robotsLines.push(`Disallow: ${path}`);
      robotsLines.push("");
    }
  } else {
    robotsLines.push("User-agent: *", "Allow: /", "");
  }
  if (site.seo.sitemap.enabled) robotsLines.push(`Sitemap: ${site.site.url}/sitemap.xml`, "");
  await writeFile(join(outDir, "robots.txt"), `${robotsLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");

  const llmsFile = join(outDir, "llms.txt");
  if (site.seo.llms.enabled) await writeFile(llmsFile, llmsText(site, pages), "utf8");
  else await rm(llmsFile, { force: true });

  const rssFile = safeMetadataOutputFile(outDir, site.seo.rss.path);
  if (site.seo.rss.enabled && rssFile) {
    await mkdir(dirname(rssFile), { recursive: true });
    await writeFile(rssFile, rssXml(site, pages), "utf8");
  } else if (rssFile) {
    await rm(rssFile, { force: true });
  }
}

export async function buildAstroSite(options: AstroBuildOptions): Promise<AstroBuildResult> {
  // Keep Astro config.root, srcDir and @site-project aliases in the same canonical
  // path namespace. This is required on macOS where /var/... and /private/var/...
  // can point at the same directory but are different cache keys to Astro/Vite.
  const root = await realpath(options.root);
  const outDir = options.outDir ?? join(root, "dist");
  const diagnostics = options.registry
    ? await validateAstroComponentContracts({ root, registry: options.registry, uiRegistry: options.uiRegistry })
    : await validateImplementations(root, options.site);
  if (diagnostics.some(diagnostic => diagnostic.severity === "error")) {
    return { success: false, outDir, pages: [], diagnostics };
  }

  const generatedSrc = await writeGeneratedProject(root, options.site, diagnostics);
  if (diagnostics.some(diagnostic => diagnostic.severity === "error")) {
    return { success: false, outDir, pages: [], diagnostics };
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  try {
    await astroBuild({
      root,
      configFile: false,
      srcDir: generatedSrc,
      publicDir: join(root, GENERATED_DIR, "public"),
      outDir,
      cacheDir: join(root, ".site", "astro-cache"),
      site: astroSiteOrigin(options.site.site.url),
      base: siteBasePath(options.site.site.url) || "/",
      output: "static",
      vite: {
        envDir: join(root, GENERATED_DIR),
        cacheDir: join(root, ".site", "vite-cache"),
        plugins: [astroRuntimeResolverPlugin()],
        resolve: {
          alias: {
            "@site-project": root,
            "@site-generated": generatedSrc
          }
        }
      }
    });
  } catch (error) {
    diagnostics.push({
      code: "RENDERER_BUILD_FAILED",
      severity: "error",
      message: error instanceof Error ? error.message : String(error)
    });
    return { success: false, outDir, pages: [], diagnostics };
  }

  await writeGeneratedMetadata(outDir, options.site);
  if (options.registry) {
    diagnostics.push(...await validateAstroBuildOutput({ root, outDir, site: options.site, registry: options.registry }));
  }
  const pages = options.site.pages
    .filter(page => page.state === "published")
    .map(page => page.route)
    .sort();
  return {
    success: !diagnostics.some(diagnostic => diagnostic.severity === "error"),
    outDir,
    pages,
    diagnostics
  };
}

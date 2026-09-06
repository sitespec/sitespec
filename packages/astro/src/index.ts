import { readFile, realpath, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { build as astroBuild, dev as astroDev } from "astro";
import { loadDesignFonts } from "@sitespec/core";
import type { Diagnostic, RegisteredComponent, RegisteredUiPrimitive, ResolvedPage, ResolvedSite } from "@sitespec/core";

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

  const shellFile = join(options.root, "shell", "default.astro");
  try {
    const shellSource = await readFile(shellFile, "utf8");
    if (!/<slot(?:\s|\/>|>)/i.test(shellSource)) {
      diagnostics.push({
        code: "SHELL_SLOT_MISSING",
        severity: "error",
        file: "shell/default.astro",
        message: "Site shell must render <slot /> so page sections remain visible.",
        expected: "<slot />",
        suggestions: [{
          action: "restore-shell-slot",
          file: "shell/default.astro",
          message: "Render <slot /> at the point where page sections should appear."
        }]
      });
    }
  } catch (error) {
    diagnostics.push({
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "SHELL_IMPLEMENTATION_MISSING" : "SHELL_IMPLEMENTATION_READ_FAILED",
      severity: "error",
      file: "shell/default.astro",
      message: (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Site shell shell/default.astro was not found."
        : error instanceof Error ? error.message : String(error),
      suggestions: [{
        action: "restore-site-shell",
        file: "shell/default.astro",
        message: "Restore the user-owned Site Shell. Renderer code must not contain header/footer presentation."
      }]
    });
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
  const file = join(root, "design", "tokens.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await writeFile(join(generatedSrc, "styles", "tokens.css"), ":root {}\n", "utf8");
      return;
    }
    diagnostics.push({
      code: "RENDERER_TOKENS_READ_FAILED",
      severity: "error",
      file: "design/tokens.json",
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    diagnostics.push({
      code: "RENDERER_TOKENS_PARSE_FAILED",
      severity: "error",
      file: "design/tokens.json",
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const tokens: Array<{ name: string; value: string }> = [];
  collectTokens(parsed, [], tokens, diagnostics);
  tokens.sort((a, b) => a.name.localeCompare(b.name));
  const body = tokens.map(token => `  --${token.name}: ${token.value};`).join("\n");
  await writeFile(join(generatedSrc, "styles", "tokens.css"), `:root {\n${body}\n}\n`, "utf8");
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

const { page, assets, jsonLd } = Astro.props;
---
<!doctype html>
<html lang={page.locale}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="Site Spec v0.2" />
    <title>{page.seo.title}</title>
    <meta name="description" content={page.seo.description} />
    <link rel="canonical" href={page.seo.canonical} />
    <link rel="icon" href={assets.favicon} />
    {assets.appleTouchIcon && <link rel="apple-touch-icon" href={assets.appleTouchIcon} />}
    {page.seo.noindex && <meta name="robots" content="noindex, nofollow" />}

    <meta property="og:type" content="website" />
    <meta property="og:title" content={page.seo.openGraph.title} />
    <meta property="og:description" content={page.seo.openGraph.description} />
    <meta property="og:url" content={page.seo.openGraph.url} />
    {page.seo.openGraph.image && <meta property="og:image" content={page.seo.openGraph.image} />}

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

function rebaseRenderValue(value: unknown, basePath: string): unknown {
  if (Array.isArray(value)) return value.map(item => rebaseRenderValue(item, basePath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    if ((key === "href" || key === "src") && typeof child === "string") {
      return [key, rebaseSitePath(child, basePath)];
    }
    return [key, rebaseRenderValue(child, basePath)];
  }));
}

function pageSource(page: ResolvedPage, site: ResolvedSite): string {
  const basePath = siteBasePath(site.site.url);
  const renderPage: ResolvedPage = {
    ...page,
    sections: page.sections.map(section => ({
      ...section,
      props: rebaseRenderValue(section.props, basePath) as Record<string, unknown>
    }))
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
  const jsonLd = page.structuredData
    ? JSON.stringify({
        ...page.structuredData.data,
        "@context": "https://schema.org",
        "@type": page.structuredData.type
      }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026")
    : undefined;
  const unique = [...new Set(page.sections.map(section => section.component))];
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
import SiteShell from "@site-project/shell/default.astro";
${imports}

const site = ${JSON.stringify(renderSite, null, 2)};
const page = ${JSON.stringify(renderPage, null, 2)};
const brand = ${JSON.stringify(renderBrand, null, 2)};
const assets = ${JSON.stringify(renderAssets, null, 2)};
const navigation = ${JSON.stringify(renderNavigation, null, 2)};
const jsonLd = ${JSON.stringify(jsonLd)};
---
<SiteLayout page={page} assets={assets} jsonLd={jsonLd}>
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
  await mkdir(join(generatedSrc, "pages"), { recursive: true });
  await mkdir(join(generatedSrc, "layouts"), { recursive: true });
  await mkdir(join(generatedSrc, "styles"), { recursive: true });

  await compileTokens(root, generatedSrc, diagnostics);
  await compileFonts(root, generatedSrc, site.site.url, diagnostics);
  await writeFile(join(generatedSrc, "layouts", "SiteLayout.astro"), layoutSource(), "utf8");
  await writeFile(join(generatedSrc, "styles", "global.css"), globalCssSource(), "utf8");

  const pages = options.includeDrafts ? site.pages : site.pages.filter(page => page.state === "published");
  const desiredPageFiles = new Set<string>();
  for (const page of pages) {
    const file = pageFilePath(generatedSrc, page.route);
    desiredPageFiles.add(file);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pageSource(page, site), "utf8");
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
    publicDir: join(root, "public"),
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

async function writeGeneratedMetadata(outDir: string, site: ResolvedSite): Promise<void> {
  const pages = site.pages
    .filter(page => page.state === "published" && !page.seo.noindex)
    .sort((a, b) => a.route.localeCompare(b.route));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map(page => `  <url><loc>${escapeXml(page.seo.canonical)}</loc></url>`)
    .join("\n")}\n</urlset>\n`;
  const robots = `User-agent: *\nAllow: /\nSitemap: ${site.site.url}/sitemap.xml\n`;
  await writeFile(join(outDir, "sitemap.xml"), sitemap, "utf8");
  await writeFile(join(outDir, "robots.txt"), robots, "utf8");
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
      publicDir: join(root, "public"),
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

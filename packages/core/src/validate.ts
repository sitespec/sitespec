import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Diagnostic, LoadedProject, ResolvedNavigation, ResolvedPage, ResolvedSite,
  SourceNavigation, ValidationResult
} from "./types.js";
import { hasErrors, nearestStrings } from "./diagnostics.js";
import { loadProject } from "./project.js";
import { resolvePage } from "./resolver.js";
import { validateDesign } from "./design.js";

interface AssetRule {
  label: string;
  value?: string;
  path: string;
  required?: boolean;
  extensions: string[];
}

function publicAssetPathIsSafe(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%") || value.includes("\0")) return false;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 && !parts.some(part => part === "." || part === "..");
}

async function validateAssetRule(project: LoadedProject, rule: AssetRule, diagnostics: Diagnostic[]): Promise<void> {
  if (!rule.value) {
    if (rule.required) diagnostics.push({
      code: "ASSET_REQUIRED",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: `${rule.label} is required in Site Spec v0.1.`,
      expected: `public asset path (${rule.extensions.join(", ")})`,
      actual: undefined,
      suggestions: [{
        action: "add-asset",
        field: rule.path,
        message: `Add the asset under public/ and reference it from ${rule.path}.`
      }]
    });
    return;
  }

  if (!publicAssetPathIsSafe(rule.value)) {
    diagnostics.push({
      code: "ASSET_PATH_INVALID",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: `${rule.label} must be a safe root-relative path inside public/.`,
      expected: "/path/to/file.ext without query, fragment, backslashes, or dot segments",
      actual: rule.value
    });
    return;
  }

  const extension = extname(rule.value).toLowerCase();
  if (!rule.extensions.includes(extension)) {
    diagnostics.push({
      code: "ASSET_FORMAT_UNSUPPORTED",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: `${rule.label} uses unsupported format "${extension || "(none)"}".`,
      expected: rule.extensions,
      actual: extension || undefined,
      allowed: rule.extensions,
      suggestions: [{
        action: "use-supported-asset-format",
        field: rule.path,
        candidates: rule.extensions
      }]
    });
  }

  const publicRoot = resolve(project.root, "public");
  const file = join(publicRoot, rule.value.slice(1));
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      diagnostics.push({
        code: "ASSET_SYMLINK_FORBIDDEN",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} must be a regular file, not a symbolic link.`,
        actual: rule.value
      });
      return;
    }
    if (!info.isFile()) {
      diagnostics.push({
        code: "ASSET_NOT_FILE",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} does not point to a regular file.`,
        actual: rule.value
      });
      return;
    }

    const [realPublicRoot, realFile] = await Promise.all([realpath(publicRoot), realpath(file)]);
    const rel = relative(realPublicRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      diagnostics.push({
        code: "ASSET_OUTSIDE_PUBLIC",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} resolves outside public/.`,
        actual: rule.value
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      diagnostics.push({
        code: "ASSET_NOT_FOUND",
        severity: "error",
        file: "site.yaml",
        path: rule.path,
        message: `${rule.label} was not found at public${rule.value}.`,
        expected: `existing file public${rule.value}`,
        actual: rule.value,
        suggestions: [{
          action: "create-asset",
          file: `public${rule.value}`,
          message: `Create public${rule.value} or update ${rule.path}.`
        }]
      });
      return;
    }
    diagnostics.push({
      code: "ASSET_READ_FAILED",
      severity: "error",
      file: "site.yaml",
      path: rule.path,
      message: error instanceof Error ? error.message : String(error),
      actual: rule.value
    });
  }
}

async function validateSiteAssets(project: LoadedProject, diagnostics: Diagnostic[]): Promise<void> {
  if (!project.site) return;
  const rules: AssetRule[] = [
    {
      label: "assets.favicon",
      value: project.site.assets.favicon,
      path: "/assets/favicon",
      required: true,
      extensions: [".ico", ".png", ".svg"]
    },
    {
      label: "assets.appleTouchIcon",
      value: project.site.assets.appleTouchIcon,
      path: "/assets/appleTouchIcon",
      extensions: [".png"]
    },
    {
      label: "assets.defaultOgImage",
      value: project.site.assets.defaultOgImage,
      path: "/assets/defaultOgImage",
      extensions: [".jpg", ".jpeg", ".png", ".webp"]
    },
    {
      label: "brand.logo",
      value: project.site.brand?.logo,
      path: "/brand/logo",
      extensions: [".svg", ".png", ".jpg", ".jpeg", ".webp"]
    },
    {
      label: "brand.logoDark",
      value: project.site.brand?.logoDark,
      path: "/brand/logoDark",
      extensions: [".svg", ".png", ".jpg", ".jpeg", ".webp"]
    }
  ];

  for (const rule of rules) await validateAssetRule(project, rule, diagnostics);
}

function collectHrefs(value: unknown, out: string[]): void {
  if (Array.isArray(value)) { value.forEach(v => collectHrefs(v, out)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.href === "string") out.push(record.href);
  Object.values(record).forEach(v => collectHrefs(v, out));
}

function internalRoute(href: string): string | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined;
  return href.split(/[?#]/, 1)[0] || "/";
}

function isSupportedExternalHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(href);
}

function validateGlobalIdentities(project: LoadedProject, diagnostics: Diagnostic[]): void {
  const ids = new Map<string, string>();
  const routes = new Map<string, string>();
  for (const page of project.pages) {
    const id = page.value.page.id;
    const route = page.value.page.route;
    if (ids.has(id)) diagnostics.push({
      code: "PAGE_ID_DUPLICATE", severity: "error", file: page.file, page: id,
      message: `Duplicate page id "${id}"; first declared in ${ids.get(id)}.`
    }); else ids.set(id, page.file);
    if (routes.has(route)) diagnostics.push({
      code: "PAGE_ROUTE_DUPLICATE", severity: "error", file: page.file, page: id,
      message: `Duplicate route "${route}"; first declared in ${routes.get(route)}.`
    }); else routes.set(route, page.file);
  }
}

function validateInternalLinks(pages: ResolvedPage[], diagnostics: Diagnostic[]): void {
  const states = new Map(pages.map(p => [p.route, p.state]));
  const routes = [...states.keys()].sort();
  for (const page of pages) {
    for (const section of page.sections) {
      const hrefs: string[] = [];
      collectHrefs(section.props, hrefs);
      for (const href of hrefs) {
        const route = internalRoute(href);
        if (!route) continue;
        const state = states.get(route);
        if (!state) {
          const candidates = nearestStrings(route, routes);
          diagnostics.push({
            code: "LINK_INTERNAL_NOT_FOUND", severity: "error", page: page.id, section: section.id,
            component: section.component, message: `Internal link "${href}" does not match a page route.`,
            expected: "existing page route",
            actual: route,
            allowed: routes,
            suggestions: candidates.length > 0 ? [{
              action: "use-route",
              candidates,
              message: "Use an existing route when it matches the intended destination."
            }] : undefined
          });
        }
        else if (page.state === "published" && state === "draft") diagnostics.push({
          code: "LINK_TARGET_DRAFT", severity: "error", page: page.id, section: section.id,
          component: section.component, message: `Published page links to draft route "${route}".`,
          expected: "published route",
          actual: "draft",
          suggestions: [{
            action: "publish-target-or-change-link",
            field: route,
            message: "Publish the target page or link to a published route."
          }]
        });
      }
    }
  }
}

function resolveNavigation(
  navigation: SourceNavigation,
  pages: ResolvedPage[],
  diagnostics: Diagnostic[]
): ResolvedNavigation {
  const states = new Map(pages.map(page => [page.route, page.state]));
  const routes = [...states.keys()].sort();
  const resolved: ResolvedNavigation = {};

  for (const collectionId of Object.keys(navigation).sort()) {
    const items = navigation[collectionId] ?? [];
    const seen = new Set<string>();
    resolved[collectionId] = [];

    items.forEach((item, index) => {
      const path = `/navigation/${collectionId}/${index}`;
      if (seen.has(item.id)) {
        diagnostics.push({
          code: "NAVIGATION_ITEM_ID_DUPLICATE",
          severity: "error",
          file: "site.yaml",
          path: `${path}/id`,
          message: `Navigation collection "${collectionId}" contains duplicate item id "${item.id}".`,
          expected: "unique item id within navigation collection",
          actual: item.id
        });
      }
      seen.add(item.id);

      const route = internalRoute(item.href);
      const external = route === undefined;
      if (route) {
        const state = states.get(route);
        if (!state) {
          const candidates = nearestStrings(route, routes);
          diagnostics.push({
            code: "NAVIGATION_LINK_INTERNAL_NOT_FOUND",
            severity: "error",
            file: "site.yaml",
            path: `${path}/href`,
            message: `Navigation item "${collectionId}.${item.id}" links to unknown route "${route}".`,
            expected: "existing page route",
            actual: route,
            allowed: routes,
            suggestions: candidates.length > 0 ? [{
              action: "use-route",
              field: `${collectionId}.${item.id}`,
              candidates,
              message: "Use an existing site route."
            }] : undefined
          });
        } else if (state === "draft") {
          diagnostics.push({
            code: "NAVIGATION_LINK_TARGET_DRAFT",
            severity: "error",
            file: "site.yaml",
            path: `${path}/href`,
            message: `Navigation item "${collectionId}.${item.id}" links to draft route "${route}".`,
            expected: "published route",
            actual: "draft",
            suggestions: [{
              action: "publish-target-or-change-link",
              field: route,
              message: "Publish the target page or point the navigation item at a published route."
            }]
          });
        }
      } else if (!isSupportedExternalHref(item.href)) {
        diagnostics.push({
          code: "NAVIGATION_HREF_INVALID",
          severity: "error",
          file: "site.yaml",
          path: `${path}/href`,
          message: `Navigation item "${collectionId}.${item.id}" has unsupported href "${item.href}".`,
          expected: "site route beginning with /, or http(s), mailto:, or tel: URL",
          actual: item.href,
          suggestions: [{
            action: "use-route-or-absolute-url",
            field: `${collectionId}.${item.id}`,
            message: "Use a stable site route or an explicit external URL."
          }]
        });
      }

      resolved[collectionId]!.push({
        id: item.id,
        label: item.label,
        href: item.href,
        target: item.target ?? "self",
        external
      });
    });
  }

  return resolved;
}

export async function validateLoadedProject(project: LoadedProject): Promise<ValidationResult> {
  const diagnostics = [...project.diagnostics];
  validateGlobalIdentities(project, diagnostics);
  await validateSiteAssets(project, diagnostics);
  diagnostics.push(...await validateDesign(project.root));

  const resolvedPages: ResolvedPage[] = [];
  if (project.site) {
    for (const page of project.pages) {
      const resolved = await resolvePage(project, page);
      diagnostics.push(...resolved.diagnostics);
      if (resolved.page) resolvedPages.push(resolved.page);
    }
    validateInternalLinks(resolvedPages, diagnostics);
  }

  const navigation = project.site
    ? resolveNavigation(project.site.navigation ?? {}, resolvedPages, diagnostics)
    : {};

  const site: ResolvedSite | undefined = project.site ? {
    specVersion: "0.1",
    site: { ...project.site.site },
    brand: { ...(project.site.brand ?? {}) },
    assets: { ...project.site.assets },
    navigation,
    pages: resolvedPages.sort((a, b) => a.route.localeCompare(b.route)),
    generated: { sitemap: true, robots: true }
  } : undefined;

  return { valid: !hasErrors(diagnostics), site, diagnostics };
}

export async function validateProject(root: string): Promise<ValidationResult> {
  return validateLoadedProject(await loadProject(root));
}

export async function resolveSite(root: string): Promise<ResolvedSite> {
  const result = await validateProject(root);
  if (!result.valid || !result.site) {
    const summary = result.diagnostics.filter(d => d.severity === "error").map(d => `${d.code}: ${d.message}`).join("\n");
    throw new Error(summary || "Site validation failed.");
  }
  return result.site;
}

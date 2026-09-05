import { join } from "node:path";
import { fileExists } from "./fs.js";
import { loadProject } from "./project.js";
import { validateLoadedProject } from "./validate.js";
import { inspectDesign } from "./design.js";

export function agentProtocol(): Record<string, unknown> {
  return {
    protocolVersion: "1",
    bootstrapFiles: ["AGENTS.md", "CLAUDE.md"],
    workflow: {
      inspect: "npm run site -- spec --json",
      inspectTarget: "npm run site -- spec <page-or-component-or-navigation-or-shell-or-assets-or-design-or-fonts> --json",
      validate: "npm run site -- validate --json",
      build: "npm run build",
      addComponent: "npm run site -- add component <id>"
    },
    design: {
      define: "design/tokens.json",
      inspect: "npm run site -- spec design --json",
      inspectFonts: "npm run site -- spec fonts --json",
      model: "primitive values -> semantic aliases -> components/shell",
      rule: "Use semantic design tokens for reusable visual decisions. Components and shell must not use primitive tokens or raw reusable colors, spacing, typography, radius, or shadows.",
      fonts: {
        define: "design/fonts.yaml",
        fileRoot: "public/fonts/",
        formats: ["woff2", "woff"],
        remoteFonts: false,
        rule: "Declare local @font-face sources in design/fonts.yaml, then select families through design/tokens.json. Do not put @font-face or remote font stylesheets in shell/components."
      },
      taskRecipe: [
        "Run npm run site -- spec design --json before changing visual styling.",
        "For site-wide visual changes, edit primitive values or semantic mappings in design/tokens.json.",
        "For component-specific layout/behavior, edit that component while consuming semantic var(--...) tokens.",
        "For supported page-level presentation choices, select component variant/theme; never add styling fields to Page Spec.",
        "Run npm run site -- validate --json, fix every design diagnostic, then run npm run build."
      ]
    },
    assets: {
      define: "site.yaml#/assets",
      inspect: "npm run site -- spec assets --json",
      fileRoot: "public/",
      faviconRequired: true,
      rule: "Declare global semantic assets in site.yaml and store their files under public/. Do not hardcode favicon or default social assets in shell/components.",
      taskRecipe: [
        "Run npm run site -- spec assets --json.",
        "Put the file under public/ and reference it with a root-relative path in site.yaml assets.",
        "Use assets.favicon for the required favicon; assets.appleTouchIcon and assets.defaultOgImage are optional v0.1 assets.",
        "Run npm run site -- validate --json, fix every error, then run npm run build."
      ]
    },
    navigation: {
      define: "site.yaml#/navigation/<collection>",
      inspect: "npm run site -- spec navigation:<collection> --json",
      inspectShell: "npm run site -- spec shell --json",
      shellUsage: "Use navigation.<collection> in shell/*.astro.",
      componentUsage: "Use { $ref: 'navigation:<collection>' } in a component prop whose schema accepts urn:site-spec:0.1:type:navigation.",
      rule: "Define shared navigation once and reference it; do not duplicate cross-site menu items in components or pages.",
      taskRecipe: [
        "Run npm run site -- spec --json and npm run site -- spec shell --json.",
        "Define or update the named collection in site.yaml navigation.",
        "Render the collection in shell/Header.astro, shell/Footer.astro, or another shell element when it is persistent UI.",
        "For page content, reuse the collection with $ref: navigation:<collection>; prefer navigation-list for a simple list.",
        "Run npm run site -- validate --json, fix every error, then run npm run build."
      ]
    },
    rules: {
      preferExistingComponents: true,
      pageUsesRegisteredSectionsOnly: true,
      newComponentsViaCliOnly: true,
      sharedNavigationInSiteYaml: true,
      siteShellOwnsPersistentUi: true,
      semanticAssetsInSiteYaml: true,
      semanticDesignTokensOnly: true,
      rawReusableStylesForbidden: true,
      localFontsOnly: true,
      fontFacesInDesignConfig: true,
      faviconRequired: true,
      inlineHtml: false,
      inlineStyles: false,
      editGeneratedFiles: false,
      validateAfterChanges: true,
      fixAllValidationErrors: true,
      buildBeforeComplete: true
    },
    sourceOfTruth: [
      "site.yaml",
      "shell/",
      "pages/",
      "content/",
      "components/*/component.yaml",
      "components/*/index.astro",
      "design/tokens.json",
      "design/fonts.yaml",
      "public/"
    ],
    generated: [".site/", "dist/"]
  };
}

export async function inspectProject(root: string, query?: string): Promise<Record<string, unknown>> {
  const project = await loadProject(root);
  const validation = await validateLoadedProject(project);
  const diagnostics = validation.diagnostics;
  const design = (await inspectDesign(root)).design;

  const components = [...project.registry.values()].map(component => ({
    id: component.id,
    role: component.role,
    description: component.manifest.description,
    files: {
      contract: component.file,
      implementation: `components/${component.id}/index.astro`
    },
    variants: component.variants,
    themes: component.themes,
    props: component.manifest.props,
    runtime: { javascript: component.manifest.runtime?.javascript === true },
    rules: component.manifest.rules ?? {},
    semantics: component.manifest.semantics ?? {}
  }));

  const pages = project.pages.map(page => ({
    id: page.value.page.id,
    route: page.value.page.route,
    archetype: page.value.page.archetype,
    state: page.value.page.state ?? "published",
    sections: page.value.sections.map(section => ({
      id: section.id,
      use: section.use,
      variant: section.variant ?? "default",
      theme: section.theme ?? "default"
    }))
  }));

  const resolvedNavigation = validation.site?.navigation ?? {};
  const navigation = Object.keys(project.site?.navigation ?? {}).sort().map(id => ({
    id,
    reference: `navigation:${id}`,
    source: `site.yaml#/navigation/${id}`,
    items: resolvedNavigation[id] ?? project.site?.navigation?.[id] ?? []
  }));

  const shell = {
    layout: "shell/default.astro",
    exists: await fileExists(join(root, "shell", "default.astro")),
    conventionalFiles: {
      header: { path: "shell/Header.astro", exists: await fileExists(join(root, "shell", "Header.astro")) },
      footer: { path: "shell/Footer.astro", exists: await fileExists(join(root, "shell", "Footer.astro")) }
    },
    receives: ["site", "brand", "page", "navigation"],
    renderContext: {
      site: ["id", "name", "url", "locale", "homeHref"],
      navigationItem: ["id", "label", "href", "target", "external", "current"]
    },
    navigationUsage: "navigation.<collection>",
    defaultBindings: {
      header: "navigation.primary",
      footer: "navigation.footer ?? navigation.primary"
    },
    purpose: "Persistent UI around every page. Header/footer are user-owned shell code, not renderer code."
  };

  const assets = {
    source: "site.yaml#/assets",
    publicDirectory: "public/",
    values: project.site?.assets,
    contract: {
      favicon: { required: true, formats: [".ico", ".png", ".svg"] },
      appleTouchIcon: { required: false, formats: [".png"] },
      defaultOgImage: { required: false, formats: [".jpg", ".jpeg", ".png", ".webp"] }
    },
    behavior: {
      documentHead: "Renderer injects favicon and optional apple-touch-icon automatically.",
      openGraphFallback: "assets.defaultOgImage is used when page.seo.image is not set.",
      deploymentBasePath: "Root-relative public asset paths are rebased automatically for deployment."
    }
  };

  const base = {
    specVersion: "0.1",
    valid: validation.valid,
    site: project.site?.site,
    agent: agentProtocol(),
    capabilities: {
      pageArchetypes: ["marketing", "article", "listing", "detail", "legal", "blank"],
      contentReferences: true,
      navigationCollections: true,
      navigationReferences: true,
      siteShell: true,
      semanticSiteAssets: true,
      designTokens: true,
      semanticDesignTokens: true,
      designLint: true,
      localWebFonts: true,
      remoteFonts: false,
      faviconRequired: true,
      dynamicRoutes: false,
      inlineHtml: false,
      inlineStyles: false,
      remoteData: false,
      componentJavascriptOptIn: true
    },
    shell,
    assets,
    design,
    navigation,
    pages,
    components,
    diagnostics
  };

  if (!query) return base;
  if (query === "shell") {
    return {
      specVersion: "0.1",
      valid: validation.valid,
      type: "shell",
      agent: agentProtocol(),
      shell,
      navigation,
      diagnostics
    };
  }
  if (query === "assets") {
    return {
      specVersion: "0.1",
      valid: validation.valid,
      type: "assets",
      agent: agentProtocol(),
      assets,
      diagnostics
    };
  }
  if (query === "design") {
    return {
      specVersion: "0.1",
      valid: validation.valid,
      type: "design",
      agent: agentProtocol(),
      design,
      diagnostics
    };
  }
  if (query === "fonts") {
    return {
      specVersion: "0.1",
      valid: validation.valid,
      type: "fonts",
      agent: agentProtocol(),
      fonts: design.fonts,
      typographyTokens: {
        primitive: design.primitive.filter(token => token.type === "fontFamily"),
        semantic: design.semantic.filter(token => token.type === "fontFamily")
      },
      diagnostics
    };
  }
  const page = pages.find(item => item.id === query || item.route === query);
  if (page) return { specVersion: "0.1", valid: validation.valid, type: "page", agent: agentProtocol(), page, diagnostics };
  const component = components.find(item => item.id === query);
  if (component) return { specVersion: "0.1", valid: validation.valid, type: "component", agent: agentProtocol(), component, diagnostics };
  const navigationId = query.startsWith("navigation:") ? query.slice("navigation:".length) : undefined;
  const navigationCollection = navigationId ? navigation.find(item => item.id === navigationId) : undefined;
  if (navigationCollection) {
    return {
      specVersion: "0.1",
      valid: validation.valid,
      type: "navigation",
      agent: agentProtocol(),
      navigation: navigationCollection,
      usage: {
        shell: `navigation.${navigationCollection.id}`,
        componentProp: { $ref: navigationCollection.reference }
      },
      diagnostics
    };
  }
  return {
    specVersion: "0.1",
    valid: false,
    type: "not-found",
    query,
    agent: agentProtocol(),
    diagnostics: [
      ...diagnostics,
      {
        code: "SPEC_QUERY_NOT_FOUND",
        severity: "error",
        message: `No page, component, navigation collection, shell, assets, design, or fonts target matched "${query}".`,
        actual: query,
        allowed: [
          ...pages.map(item => item.id),
          ...components.map(item => item.id),
          "shell",
          "assets",
          "design",
          "fonts",
          ...navigation.map(item => item.reference)
        ],
        suggestions: [
          { action: "inspect-project", command: "npm run site -- spec --json" }
        ]
      }
    ]
  };
}

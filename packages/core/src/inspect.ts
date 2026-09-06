import { join } from "node:path";
import { fileExists } from "./fs.js";
import { loadProject } from "./project.js";
import { validateLoadedProject } from "./validate.js";
import { inspectDesign } from "./design.js";
import { inspectDesignSystem } from "./design-system.js";
import { routeParamNames } from "./routes.js";
import { resolvedContentEntry } from "./content-query.js";

export function agentProtocol(): Record<string, unknown> {
  return {
    protocolVersion: "5",
    bootstrapFiles: ["AGENTS.md", "CLAUDE.md"],
    workflow: {
      inspect: "npm run site -- spec --json",
      inspectTarget: "npm run site -- spec <page-or-collection-or-entry-or-component-or-ui-or-section-or-navigation-or-shell-or-assets-or-media-or-seo-or-design-or-design-system-or-fonts> --json",
      inspectDesignSystem: "npm run site -- spec design-system --json",
      inspectDesignSystemPack: "npm run site -- design-system --json",
      installDesignSystem: "npm run site -- design-system install <pack> --replace",
      packDesignSystem: "npm run site -- design-system pack <directory>",
      validate: "npm run site -- validate --json",
      build: "npm run build",
      addComponent: "npm run site -- add component <id>",
      addUi: "npm run site -- add ui <id>"
    },
    composition: {
      pageLayer: "pages/*.yaml may use registered sections or reusable section:<id> presets only.",
      sectionLayer: "components/* are page-level sections.",
      uiLayer: "ui/* are internal Design System primitives used by sections/shell; Page Spec cannot use them directly.",
      designSystem: "design-system.yaml declares the portable v0.4+ Design System contract: UI and section libraries, shell packs, layout convention, themes, token sources, and extension policy.",
      reusableSections: "Store reusable section configuration under sections/*.yaml and reference it with { id, $ref: 'section:<id>' }.",
      dynamicRoutes: "Use /path/[param] with page.paths in specVersion 0.2+, or bind the route to content.entry in specVersion 0.3.",
      content: "Define typed collections under content/<collection>/collection.yaml. Bind detail pages with content.entry and listing data with content.queries; consume values through entry: and query: refs."
    },
    design: {
      define: "design/tokens.json",
      inspect: "npm run site -- spec design --json",
      inspectFonts: "npm run site -- spec fonts --json",
      inspectSystem: "npm run site -- design-system --json",
      model: "primitive values -> semantic aliases -> ui/components/shell",
      rule: "Use semantic design tokens for reusable visual decisions. UI primitives, components, and shell must not use primitive tokens or raw reusable colors, spacing, typography, radius, or shadows.",
      fonts: {
        define: "design/fonts.yaml",
        fileRoot: "public/fonts/",
        formats: ["woff2", "woff"],
        remoteFonts: false
      },
      layoutConvention: {
        outer: "Outer shell/section owns responsive page gutter via var(--space-page).",
        inner: "Inner container owns max-width via var(--size-content) and margin-inline:auto."
      }
    },
    designSystem: {
      define: "design-system.yaml",
      inspect: "npm run site -- spec design-system --json",
      inspectPack: "npm run site -- design-system --json",
      install: "npm run site -- design-system install <pack> --replace",
      pack: "npm run site -- design-system pack <directory>",
      model: "portable source pack -> copy into site -> site-owned executable design system",
      runtimeDependency: false
    },
    assets: {
      define: "site.yaml#/assets",
      inspect: "npm run site -- spec assets --json",
      fileRoot: "public/",
      faviconRequired: true
    },
    media: {
      define: "site.yaml#/media + urn:site-spec:0.5:type:image props",
      sourceRoot: "public/",
      renderer: "@site-generated/components/SiteImage.astro",
      generatedRoot: "media.output (default /_media)",
      formats: ["avif", "webp"],
      rule: "Declare images in typed props. SiteSpec validates media and generates responsive derivatives; do not hand-author an Astro image pipeline."
    },
    seo: {
      site: "site.yaml#/seo",
      page: "pages/*.yaml#/seo",
      generated: ["sitemap.xml", "robots.txt", "llms.txt", "RSS", "per-page social images"],
      rule: "Canonical, hreflang, Open Graph/Twitter and JSON-LD are resolved by SiteSpec; do not duplicate page head metadata in Astro components."
    },
    navigation: {
      define: "site.yaml#/navigation/<collection>",
      inspect: "npm run site -- spec navigation:<collection> --json",
      inspectShell: "npm run site -- spec shell --json",
      shellUsage: "Use navigation.<collection> in shell/*.astro.",
      componentUsage: "Use { $ref: 'navigation:<collection>' } in a component prop whose schema accepts a navigation core type."
    },
    content: {
      define: "content/<collection>/collection.yaml + .md/.yaml/.yml/.json entries",
      inspect: "npm run site -- spec content --json",
      inspectCollection: "npm run site -- spec collection:<id> --json",
      inspectEntry: "npm run site -- spec entry:<collection>/<id> --json",
      refs: ["entry:<field>", "query:<id>.items", "query:<id>.pagination"],
      markdown: true,
      remoteData: false
    },
    rules: {
      preferExistingComponents: true,
      pageUsesRegisteredSectionsOnly: true,
      pageCannotUseUiPrimitives: true,
      newComponentsViaCliOnly: true,
      newUiViaCliOnly: true,
      sharedNavigationInSiteYaml: true,
      siteShellOwnsPersistentUi: true,
      semanticAssetsInSiteYaml: true,
      mediaPipelineInSiteSpec: true,
      seoMetadataInSiteSpec: true,
      faviconRequired: true,
      semanticDesignTokensOnly: true,
      rawReusableStylesForbidden: true,
      designSystemIsSourceOwned: true,
      tokenExtensionsFollowContract: true,
      localFontsOnly: true,
      fontFacesInDesignConfig: true,
      inlineHtml: false,
      inlineStyles: false,
      editGeneratedFiles: false,
      validateAfterChanges: true,
      buildBeforeComplete: true
    },
    sourceOfTruth: [
      "site.yaml",
      "design-system.yaml",
      "shell/",
      "pages/",
      "sections/",
      "content/",
      "components/*/component.yaml",
      "components/*/index.astro",
      "ui/*/ui.yaml",
      "ui/*/index.astro",
      "design/tokens.json",
      "design/extensions.json",
      "design/themes/",
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
  const designSystem = project.designSystem ? (await inspectDesignSystem(root)).designSystem : undefined;
  const specVersion = project.site?.specVersion ?? "0.5";

  const components = [...project.registry.values()].map(component => ({
    id: component.id,
    role: component.role,
    description: component.manifest.description,
    files: { contract: component.file, implementation: `components/${component.id}/index.astro` },
    variants: component.variants,
    themes: component.themes,
    props: component.manifest.props,
    runtime: { javascript: component.manifest.runtime?.javascript === true },
    rules: component.manifest.rules ?? {},
    semantics: component.manifest.semantics ?? {}
  }));

  const ui = [...project.uiRegistry.values()].map(primitive => ({
    id: primitive.id,
    role: primitive.role,
    description: primitive.manifest.description,
    files: { contract: primitive.file, implementation: primitive.implementation },
    variants: primitive.variants,
    props: primitive.manifest.props,
    runtime: { javascript: primitive.manifest.runtime?.javascript === true },
    usage: {
      componentImport: `../../ui/${primitive.id}/index.astro`,
      shellImport: `../ui/${primitive.id}/index.astro`,
      pageSpec: "forbidden"
    }
  }));

  const sectionPresets = project.sectionPresets.map(preset => ({
    id: preset.id,
    reference: `section:${preset.id}`,
    source: preset.file,
    description: preset.value.description,
    section: preset.value.section
  }));

  const resolvedByTemplate = new Map<string, Array<{ id: string; route: string; params: Record<string, string> }>>();
  for (const page of validation.site?.pages ?? []) {
    const list = resolvedByTemplate.get(page.templateId) ?? [];
    list.push({ id: page.id, route: page.route, params: page.params });
    resolvedByTemplate.set(page.templateId, list);
  }

  const pages = project.pages.map(page => ({
    id: page.value.page.id,
    route: page.value.page.route,
    dynamic: routeParamNames(page.value.page.route).length > 0,
    params: routeParamNames(page.value.page.route),
    paths: page.value.page.paths ?? [],
    generatedRoutes: (resolvedByTemplate.get(page.value.page.id) ?? []).sort((a, b) => a.route.localeCompare(b.route)),
    archetype: page.value.page.archetype,
    state: page.value.page.state ?? "published",
    content: page.value.content ?? undefined,
    sections: page.value.sections.map(section => "use" in section
      ? { id: section.id, use: section.use, variant: section.variant ?? "default", theme: section.theme ?? "default" }
      : { id: section.id, ref: section.$ref })
  }));

  const contentCollections = project.contentCollections.map(collection => ({
    id: collection.value.collection.id,
    reference: `collection:${collection.value.collection.id}`,
    source: collection.file,
    directory: collection.dir,
    schema: collection.value.entry.schema,
    relations: collection.value.relations ?? {},
    counts: {
      total: collection.entries.length,
      published: collection.entries.filter(entry => entry.status === "published").length,
      draft: collection.entries.filter(entry => entry.status === "draft").length
    },
    entries: collection.entries.map(entry => ({
      id: entry.id,
      reference: `entry:${collection.value.collection.id}/${entry.id}`,
      slug: entry.slug,
      date: entry.date,
      status: entry.status,
      href: entry.href,
      format: entry.body?.format ?? "data",
      source: entry.source
    }))
  }));

  const resolvedNavigation = validation.site?.navigation ?? {};
  const navigation = Object.keys(project.site?.navigation ?? {}).sort().map(id => ({
    id,
    reference: `navigation:${id}`,
    source: `site.yaml#/navigation/${id}`,
    items: resolvedNavigation[id] ?? project.site?.navigation?.[id] ?? []
  }));

  const selectedShellId = project.site?.designSystem?.shell ?? project.designSystem?.value.shells.default ?? "default";
  const selectedShellEntry = project.designSystem?.value.shells.items[selectedShellId]?.entry ?? "shell/default.astro";
  const shell = {
    id: selectedShellId,
    layout: selectedShellEntry,
    exists: await fileExists(join(root, selectedShellEntry)),
    conventionalFiles: {
      header: { path: "shell/Header.astro", exists: await fileExists(join(root, "shell", "Header.astro")) },
      footer: { path: "shell/Footer.astro", exists: await fileExists(join(root, "shell", "Footer.astro")) }
    },
    receives: ["site", "brand", "page", "navigation"],
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
    }
  };

  const media = {
    source: "site.yaml#/media",
    publicDirectory: "public/",
    imageType: `urn:site-spec:${specVersion}:type:image`,
    renderer: "@site-generated/components/SiteImage.astro",
    config: validation.site?.media ?? project.site?.media
  };

  const seo = {
    source: "site.yaml#/seo + pages/*.yaml#/seo",
    config: validation.site?.seo ?? project.site?.seo,
    generated: validation.site?.generated,
    pages: (validation.site?.pages ?? []).map(page => ({
      id: page.id,
      route: page.route,
      locale: page.locale,
      canonical: page.seo.canonical,
      hreflang: page.seo.hreflang,
      noindex: page.seo.noindex,
      openGraph: page.seo.openGraph,
      twitter: page.seo.twitter,
      socialImage: page.seo.socialImage
    }))
  };

  const base = {
    specVersion,
    valid: validation.valid,
    site: project.site?.site,
    agent: agentProtocol(),
    capabilities: {
      pageArchetypes: ["marketing", "article", "listing", "detail", "legal", "blank"],
      contentReferences: true,
      navigationCollections: true,
      navigationReferences: true,
      sectionPresets: specVersion !== "0.1",
      uiPrimitives: specVersion !== "0.1",
      dynamicRoutes: specVersion !== "0.1",
      routeParamReferences: specVersion !== "0.1",
      paginationCoreType: specVersion !== "0.1",
      typedContentCollections: specVersion === "0.3" || specVersion === "0.4" || specVersion === "0.5",
      markdownEntries: specVersion === "0.3" || specVersion === "0.4" || specVersion === "0.5",
      contentRelations: specVersion === "0.3" || specVersion === "0.4" || specVersion === "0.5",
      contentQueries: specVersion === "0.3" || specVersion === "0.4" || specVersion === "0.5",
      contentPagination: specVersion === "0.3" || specVersion === "0.4" || specVersion === "0.5",
      designSystemContract: specVersion === "0.4" || specVersion === "0.5",
      designSystemPacks: specVersion === "0.4" || specVersion === "0.5",
      shellPacks: specVersion === "0.4" || specVersion === "0.5",
      themes: specVersion === "0.4" || specVersion === "0.5",
      tokenExtensions: specVersion === "0.4" || specVersion === "0.5",
      mediaPipeline: specVersion === "0.5",
      responsiveImages: specVersion === "0.5",
      generatedSocialImages: specVersion === "0.5",
      hreflang: specVersion === "0.5",
      llmsTxt: specVersion === "0.5",
      rss: specVersion === "0.5",
      siteShell: true,
      semanticSiteAssets: true,
      designTokens: true,
      semanticDesignTokens: true,
      designLint: true,
      localWebFonts: true,
      remoteFonts: false,
      inlineHtml: false,
      inlineStyles: false,
      remoteData: false,
      componentJavascriptOptIn: true
    },
    coreTypes: {
      action: `urn:site-spec:${specVersion}:type:action`,
      image: `urn:site-spec:${specVersion}:type:image`,
      navigation: `urn:site-spec:${specVersion}:type:navigation`,
      ...(specVersion !== "0.1" ? { pagination: `urn:site-spec:${specVersion}:type:pagination` } : {})
    },
    shell,
    designSystem,
    assets,
    media,
    seo,
    design,
    navigation,
    content: contentCollections,
    pages,
    components,
    ui,
    sectionPresets,
    diagnostics
  };

  if (!query) return base;
  if (query === "shell") return { specVersion, valid: validation.valid, type: "shell", agent: agentProtocol(), shell, navigation, diagnostics };
  if (query === "assets") return { specVersion, valid: validation.valid, type: "assets", agent: agentProtocol(), assets, diagnostics };
  if (query === "media") return { specVersion, valid: validation.valid, type: "media", agent: agentProtocol(), media, diagnostics };
  if (query === "seo") return { specVersion, valid: validation.valid, type: "seo", agent: agentProtocol(), seo, diagnostics };
  if (query === "design") return { specVersion, valid: validation.valid, type: "design", agent: agentProtocol(), design, diagnostics };
  if (query === "design-system") return { specVersion, valid: validation.valid, type: "design-system", agent: agentProtocol(), designSystem, diagnostics };
  if (query === "fonts") return {
    specVersion, valid: validation.valid, type: "fonts", agent: agentProtocol(), fonts: design.fonts,
    typographyTokens: {
      primitive: design.primitive.filter(token => token.type === "fontFamily"),
      semantic: design.semantic.filter(token => token.type === "fontFamily")
    }, diagnostics
  };
  if (query === "ui") return { specVersion, valid: validation.valid, type: "ui-index", agent: agentProtocol(), ui, diagnostics };
  if (query === "sections") return { specVersion, valid: validation.valid, type: "section-presets", agent: agentProtocol(), sectionPresets, diagnostics };
  if (query === "content") return {
    specVersion, valid: validation.valid, type: "content-index", agent: agentProtocol(),
    collections: contentCollections, diagnostics
  };

  const collectionId = query.startsWith("collection:") ? query.slice("collection:".length) : undefined;
  const contentCollection = collectionId ? contentCollections.find(item => item.id === collectionId) : undefined;
  if (contentCollection) return {
    specVersion, valid: validation.valid, type: "content-collection", agent: agentProtocol(),
    collection: contentCollection, diagnostics
  };

  const entryLogical = query.startsWith("entry:") ? query.slice("entry:".length) : undefined;
  if (entryLogical) {
    const slash = entryLogical.indexOf("/");
    const entryCollectionId = slash > 0 ? entryLogical.slice(0, slash) : "";
    const entryId = slash > 0 ? entryLogical.slice(slash + 1) : "";
    const collection = project.contentRegistry.get(entryCollectionId);
    const entry = collection?.entries.find(item => item.id === entryId);
    if (collection && entry) return {
      specVersion,
      valid: validation.valid,
      type: "content-entry",
      agent: agentProtocol(),
      entry: {
        collection: entryCollectionId,
        reference: `entry:${entryCollectionId}/${entry.id}`,
        source: entry.source,
        ...resolvedContentEntry(project.contentRegistry, entry)
      },
      diagnostics
    };
  }

  const page = pages.find(item => item.id === query || item.route === query || item.generatedRoutes.some(route => route.route === query));
  if (page) return { specVersion, valid: validation.valid, type: "page", agent: agentProtocol(), page, diagnostics };
  const component = components.find(item => item.id === query);
  if (component) return { specVersion, valid: validation.valid, type: "component", agent: agentProtocol(), component, diagnostics };
  const uiId = query.startsWith("ui:") ? query.slice(3) : undefined;
  const primitive = uiId ? ui.find(item => item.id === uiId) : undefined;
  if (primitive) return { specVersion, valid: validation.valid, type: "ui", agent: agentProtocol(), ui: primitive, diagnostics };
  const sectionId = query.startsWith("section:") ? query.slice("section:".length) : undefined;
  const preset = sectionId ? sectionPresets.find(item => item.id === sectionId) : undefined;
  if (preset) return { specVersion, valid: validation.valid, type: "section-preset", agent: agentProtocol(), sectionPreset: preset, diagnostics };
  const navigationId = query.startsWith("navigation:") ? query.slice("navigation:".length) : undefined;
  const navigationCollection = navigationId ? navigation.find(item => item.id === navigationId) : undefined;
  if (navigationCollection) return {
    specVersion, valid: validation.valid, type: "navigation", agent: agentProtocol(), navigation: navigationCollection,
    usage: { shell: `navigation.${navigationCollection.id}`, componentProp: { $ref: navigationCollection.reference } }, diagnostics
  };

  return {
    specVersion,
    valid: false,
    type: "not-found",
    query,
    agent: agentProtocol(),
    diagnostics: [
      ...diagnostics,
      {
        code: "SPEC_QUERY_NOT_FOUND",
        severity: "error",
        message: `No page, content collection/entry, component, UI primitive, section preset, navigation collection, shell, assets, design, Design System, or fonts target matched "${query}".`,
        actual: query,
        allowed: [
          ...pages.map(item => item.id), ...components.map(item => item.id), ...ui.map(item => `ui:${item.id}`),
          ...sectionPresets.map(item => item.reference), "content", ...contentCollections.map(item => item.reference),
          ...contentCollections.flatMap(item => item.entries.map(entry => entry.reference)),
          "shell", "assets", "design", "design-system", "fonts", ...navigation.map(item => item.reference)
        ],
        suggestions: [{ action: "inspect-project", command: "npm run site -- spec --json" }]
      }
    ]
  };
}

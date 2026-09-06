import type { ValidateFunction } from "ajv";

export type SpecVersion = "0.1" | "0.2" | "0.3" | "0.4" | "0.5";
export type Archetype = "marketing" | "article" | "listing" | "detail" | "legal" | "blank";
export type PageState = "draft" | "published";
export type ContentStatus = PageState;
export type ComponentRole = "intro" | "content" | "proof" | "conversion" | "utility";
export type UiRole = "layout" | "action" | "content" | "navigation" | "feedback" | "media" | "typography";
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticSuggestion {
  action: string;
  message?: string;
  command?: string;
  file?: string;
  field?: string;
  value?: unknown;
  candidates?: string[];
  patch?: unknown;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  path?: string;
  page?: string;
  section?: string;
  component?: string;
  sourceFile?: string;
  sourcePath?: string;
  hint?: string;
  expected?: unknown;
  actual?: unknown;
  allowed?: unknown[];
  suggestions?: DiagnosticSuggestion[];
  details?: Record<string, unknown>;
}

export interface SourceNavigationItem {
  id: string;
  label: string;
  href: string;
  target?: "self" | "blank";
}

export type SourceNavigation = Record<string, SourceNavigationItem[]>;

export type MediaFormat = "avif" | "webp";
export type SocialImageFormat = "png" | "jpeg" | "webp";

export interface SourceRobotsRule {
  userAgent: string;
  allow?: string[];
  disallow?: string[];
}

export interface SourceSiteSeo {
  titleTemplate?: string;
  defaultDescription?: string;
  siteName?: string;
  sitemap?: { enabled?: boolean };
  robots?: { index?: boolean; rules?: SourceRobotsRule[] };
  llms?: { enabled?: boolean; description?: string };
  rss?: { enabled?: boolean; path?: string; title?: string; description?: string };
  socialImages?: {
    generate?: boolean;
    format?: SocialImageFormat;
    width?: number;
    height?: number;
    background?: string;
    foreground?: string;
  };
}

export interface SourceMediaConfig {
  output?: string;
  widths?: number[];
  formats?: MediaFormat[];
  quality?: { avif?: number; webp?: number; jpeg?: number; png?: number };
}

export interface SourceSite {
  specVersion: SpecVersion;
  site: { id: string; name: string; url: string; locale: string };
  designSystem?: { theme?: string; shell?: string };
  brand?: { logo?: string; logoDark?: string };
  assets: { favicon: string; appleTouchIcon?: string; defaultOgImage?: string };
  navigation?: SourceNavigation;
  media?: SourceMediaConfig;
  seo?: SourceSiteSeo;
  quality?: {
    accessibility?: "AA";
    performance?: { lighthouse?: number; javascriptKb?: number };
  };
}

export interface SourceSection {
  id: string;
  use: string;
  variant?: string;
  theme?: string;
  props?: Record<string, unknown>;
}

export interface SourceSectionReference {
  id: string;
  $ref: string;
}

export type SourceSectionEntry = SourceSection | SourceSectionReference;
export type RouteParams = Record<string, string>;

export interface SourceContentRelation {
  collection: string;
  many?: boolean;
}

export interface CollectionManifest {
  specVersion: "0.3" | "0.4" | "0.5";
  collection: { id: string };
  entry: { schema: Record<string, unknown> };
  relations?: Record<string, SourceContentRelation>;
}

export interface ContentBody {
  format: "markdown";
  source: string;
  html: string;
}

export interface ContentEntry {
  collection: string;
  id: string;
  slug: string;
  date?: string;
  status: ContentStatus;
  data: Record<string, unknown>;
  body?: ContentBody;
  source: string;
  href?: string;
}

export interface LoadedContentCollection {
  file: string;
  dir: string;
  value: CollectionManifest;
  entries: ContentEntry[];
  validateEntry: ValidateFunction;
}

export type ContentFilterOperator = "eq" | "ne" | "in" | "contains" | "gt" | "gte" | "lt" | "lte";
export type SourceContentFilterValue = string | number | boolean | null | string[] | number[] | { $ref: string };

export interface SourceContentFilter {
  field: string;
  eq?: SourceContentFilterValue;
  ne?: SourceContentFilterValue;
  in?: SourceContentFilterValue;
  contains?: SourceContentFilterValue;
  gt?: SourceContentFilterValue;
  gte?: SourceContentFilterValue;
  lt?: SourceContentFilterValue;
  lte?: SourceContentFilterValue;
}

export interface SourceContentSort {
  field: string;
  order?: "asc" | "desc";
}

export interface SourceContentPagination {
  size: number;
  route: string;
}

export interface SourceContentQuery {
  collection: string;
  filter?: SourceContentFilter[];
  sort?: SourceContentSort[];
  paginate?: SourceContentPagination;
}

export interface SourcePageContent {
  entry?: string;
  queries?: Record<string, SourceContentQuery>;
}

export interface SourceStructuredData {
  type: string;
  data?: Record<string, unknown>;
}

export interface SourcePageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noindex?: boolean;
  hreflang?: Record<string, string>;
  openGraph?: {
    title?: string;
    description?: string;
    image?: string;
    type?: string;
    siteName?: string;
    locale?: string;
  };
  twitter?: {
    card?: "summary" | "summary_large_image";
    title?: string;
    description?: string;
    image?: string;
  };
  socialImage?: { generate?: boolean };
}

export interface SourcePage {
  specVersion: SpecVersion;
  page: {
    id: string;
    route: string;
    archetype: Archetype;
    state?: PageState;
    locale?: string;
    paths?: RouteParams[];
  };
  seo?: SourcePageSeo;
  structuredData?: SourceStructuredData | SourceStructuredData[];
  content?: SourcePageContent;
  sections: SourceSectionEntry[];
}

export interface SectionPresetManifest {
  specVersion: "0.2" | "0.3" | "0.4" | "0.5";
  description?: string;
  section: Omit<SourceSection, "id">;
}

export interface ComponentManifest {
  specVersion: SpecVersion;
  component: { id: string; role: ComponentRole };
  description?: string;
  variants?: string[];
  themes?: string[];
  props: Record<string, unknown>;
  runtime?: { javascript?: boolean };
  rules?: {
    maxPerPage?: number;
    allowedArchetypes?: Archetype[];
    placement?: "any" | "first" | "last";
  };
  semantics?: { pageHeading?: boolean };
}

export interface UiManifest {
  specVersion: "0.2" | "0.3" | "0.4" | "0.5";
  ui: { id: string; role: UiRole };
  description?: string;
  variants?: string[];
  props: Record<string, unknown>;
  runtime?: { javascript?: boolean };
}

export interface RegisteredComponent {
  id: string;
  role: ComponentRole;
  variants: string[];
  themes: string[];
  manifest: ComponentManifest;
  validateProps: ValidateFunction;
  file: string;
}

export interface RegisteredUiPrimitive {
  id: string;
  role: UiRole;
  variants: string[];
  manifest: UiManifest;
  validateProps: ValidateFunction;
  file: string;
  implementation: string;
}

export interface LoadedPage { file: string; value: SourcePage }
export interface LoadedComponent { file: string; dirName: string; value: ComponentManifest }
export interface LoadedUiPrimitive { file: string; dirName: string; value: UiManifest }
export interface LoadedSectionPreset { file: string; id: string; value: SectionPresetManifest }

export type DesignSystemExtensionMode = "locked" | "additive";

export interface DesignSystemManifest {
  specVersion: "0.4" | "0.5";
  designSystem: {
    id: string;
    name: string;
    version: string;
    description?: string;
  };
  tokens: {
    source: string;
    extension: string;
    rules: {
      primitive: DesignSystemExtensionMode;
      semantic: DesignSystemExtensionMode;
    };
  };
  fonts: {
    source: string;
    assetsRoot: string;
  };
  themes: {
    default: string;
    items: Record<string, { label?: string; source?: string }>;
  };
  layout: {
    convention: "outer-gutter-inner-container";
    tokens: {
      pageGutter: string;
      contentWidth: string;
      sectionSpacing: string;
    };
  };
  libraries: {
    ui: string[];
    sections: string[];
    presets: string[];
  };
  shells: {
    default: string;
    items: Record<string, { entry: string; files: string[] }>;
  };
}

export interface LoadedDesignSystem {
  file: "design-system.yaml";
  value: DesignSystemManifest;
}

export interface LoadedProject {
  root: string;
  site?: SourceSite;
  siteFile: string;
  pages: LoadedPage[];
  components: LoadedComponent[];
  registry: Map<string, RegisteredComponent>;
  ui: LoadedUiPrimitive[];
  uiRegistry: Map<string, RegisteredUiPrimitive>;
  sectionPresets: LoadedSectionPreset[];
  designSystem?: LoadedDesignSystem;
  contentCollections: LoadedContentCollection[];
  contentRegistry: Map<string, LoadedContentCollection>;
  diagnostics: Diagnostic[];
}

export interface Origin {
  file: string;
  path: string;
}

export interface ResolvedNavigationItem {
  id: string;
  label: string;
  href: string;
  target: "self" | "blank";
  external: boolean;
}

export type ResolvedNavigation = Record<string, ResolvedNavigationItem[]>;

export interface ResolvedSection {
  id: string;
  component: string;
  role: ComponentRole;
  variant: string;
  theme: string;
  props: Record<string, unknown>;
  preset?: string;
}

export interface ResolvedSocialImage {
  generated: boolean;
  path: string;
  width: number;
  height: number;
  format: SocialImageFormat;
}

export interface ResolvedSeo {
  title: string;
  description: string;
  canonical: string;
  image?: string;
  noindex: boolean;
  hreflang: Record<string, string>;
  openGraph: {
    type: string;
    title: string;
    description: string;
    url: string;
    image?: string;
    imageWidth?: number;
    imageHeight?: number;
    siteName: string;
    locale: string;
  };
  twitter: {
    card: "summary" | "summary_large_image";
    title: string;
    description: string;
    image?: string;
  };
  socialImage?: ResolvedSocialImage;
}

export interface ResolvedPage {
  id: string;
  templateId: string;
  route: string;
  routeTemplate: string;
  params: RouteParams;
  archetype: Archetype;
  state: PageState;
  locale: string;
  seo: ResolvedSeo;
  sections: ResolvedSection[];
  content?: {
    entry?: Record<string, unknown>;
    queries: Record<string, ResolvedContentQuery>;
  };
  structuredData: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface ResolvedContentPagination {
  currentPage: number;
  totalPages: number;
  previousHref?: string;
  nextHref?: string;
  pages: Array<{ page: number; href: string; current: boolean }>;
}

export interface ResolvedContentQuery {
  items: Record<string, unknown>[];
  pagination?: ResolvedContentPagination;
}

export interface ResolvedSite {
  specVersion: SpecVersion;
  site: { id: string; name: string; url: string; locale: string };
  designSystem?: {
    id: string;
    name: string;
    version: string;
    theme: string;
    shell: string;
    shellEntry: string;
  };
  brand: { logo?: string; logoDark?: string };
  assets: { favicon: string; appleTouchIcon?: string; defaultOgImage?: string };
  media: {
    output: string;
    widths: number[];
    formats: MediaFormat[];
    quality: { avif: number; webp: number; jpeg: number; png: number };
  };
  seo: {
    siteName: string;
    titleTemplate?: string;
    defaultDescription?: string;
    sitemap: { enabled: boolean };
    robots: { index: boolean; rules: SourceRobotsRule[] };
    llms: { enabled: boolean; description?: string };
    rss: { enabled: boolean; path: string; title: string; description: string };
    socialImages: {
      generate: boolean;
      format: SocialImageFormat;
      width: number;
      height: number;
      background: string;
      foreground: string;
    };
  };
  navigation: ResolvedNavigation;
  pages: ResolvedPage[];
  generated: { sitemap: boolean; robots: boolean; llms: boolean; rss: boolean; socialImages: boolean; media: boolean };
}

export interface ValidationResult {
  valid: boolean;
  site?: ResolvedSite;
  diagnostics: Diagnostic[];
}

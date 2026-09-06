import type { ValidateFunction } from "ajv";

export type SpecVersion = "0.1" | "0.2" | "0.3";
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

export interface SourceSite {
  specVersion: SpecVersion;
  site: { id: string; name: string; url: string; locale: string };
  brand?: { logo?: string; logoDark?: string };
  assets: { favicon: string; appleTouchIcon?: string; defaultOgImage?: string };
  navigation?: SourceNavigation;
  seo?: { titleTemplate?: string; defaultDescription?: string };
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
  specVersion: "0.3";
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

export interface SourcePage {
  specVersion: SpecVersion;
  page: {
    id: string;
    route: string;
    archetype: Archetype;
    state?: PageState;
    paths?: RouteParams[];
  };
  seo?: {
    title?: string;
    description?: string;
    canonical?: string;
    image?: string;
    noindex?: boolean;
  };
  structuredData?: {
    type: "Organization" | "WebSite" | "WebPage" | "Article" | "Product" | "FAQPage" | "BreadcrumbList";
    data?: Record<string, unknown>;
  };
  content?: SourcePageContent;
  sections: SourceSectionEntry[];
}

export interface SectionPresetManifest {
  specVersion: "0.2" | "0.3";
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
  specVersion: "0.2" | "0.3";
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

export interface ResolvedSeo {
  title: string;
  description: string;
  canonical: string;
  image?: string;
  noindex: boolean;
  openGraph: {
    title: string;
    description: string;
    url: string;
    image?: string;
  };
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
  structuredData?: { type: string; data: Record<string, unknown> };
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
  brand: { logo?: string; logoDark?: string };
  assets: { favicon: string; appleTouchIcon?: string; defaultOgImage?: string };
  navigation: ResolvedNavigation;
  pages: ResolvedPage[];
  generated: { sitemap: true; robots: true };
}

export interface ValidationResult {
  valid: boolean;
  site?: ResolvedSite;
  diagnostics: Diagnostic[];
}

import type { ValidateFunction } from "ajv";

export type Archetype = "marketing" | "article" | "listing" | "detail" | "legal" | "blank";
export type PageState = "draft" | "published";
export type ComponentRole = "intro" | "content" | "proof" | "conversion" | "utility";
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
  specVersion: "0.1";
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

export interface SourcePage {
  specVersion: "0.1";
  page: { id: string; route: string; archetype: Archetype; state?: PageState };
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
  sections: SourceSection[];
}

export interface ComponentManifest {
  specVersion: "0.1";
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

export interface RegisteredComponent {
  id: string;
  role: ComponentRole;
  variants: string[];
  themes: string[];
  manifest: ComponentManifest;
  validateProps: ValidateFunction;
  file: string;
}

export interface LoadedPage { file: string; value: SourcePage }
export interface LoadedComponent { file: string; dirName: string; value: ComponentManifest }

export interface LoadedProject {
  root: string;
  site?: SourceSite;
  siteFile: string;
  pages: LoadedPage[];
  components: LoadedComponent[];
  registry: Map<string, RegisteredComponent>;
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
  route: string;
  archetype: Archetype;
  state: PageState;
  locale: string;
  seo: ResolvedSeo;
  sections: ResolvedSection[];
  structuredData?: { type: string; data: Record<string, unknown> };
}

export interface ResolvedSite {
  specVersion: "0.1";
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

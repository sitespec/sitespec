import chokidar, { type FSWatcher } from "chokidar";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadProject, validateLoadedProject, type Diagnostic, type ResolvedSite } from "@sitespec/core";
import { startAstroDevServer, validateAstroComponentContracts } from "@sitespec/astro";

export interface DevProjectOptions {
  root: string;
  host?: string;
  port?: number;
  debounceMs?: number;
  rendererLogLevel?: "debug" | "info" | "warn" | "error" | "silent";
  designLab?: boolean;
  onEvent?: (event: DevEvent) => void;
}

export type DevEvent =
  | { event: "ready"; url: string; labUrl?: string; host: string; port: number; valid: boolean; diagnostics: Diagnostic[] }
  | { event: "updated"; valid: true; diagnostics: Diagnostic[] }
  | { event: "invalid"; valid: false; diagnostics: Diagnostic[] }
  | { event: "error"; valid: false; diagnostics: Diagnostic[] };

export interface DevProjectServer {
  root: string;
  host: string;
  port: number;
  url: string;
  labUrl?: string;
  close(): Promise<void>;
}

interface DevValidationState {
  valid: boolean;
  site?: ResolvedSite;
  diagnostics: Diagnostic[];
}

const WATCHED_SOURCE_PATHS: string[] = [
  "site.yaml",
  "design-system.yaml",
  "pages",
  "content",
  "sections",
  "components",
  "ui",
  "shell",
  "design",
  "public"
];

export type DesignLabRootSource = "explicit" | "project" | "repository-example";

export interface DesignLabRootResolution {
  root: string;
  source: DesignLabRootSource;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isSiteSpecSourceRepository(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      private?: unknown;
      workspaces?: unknown;
    };
    return manifest.name === "sitespec"
      && manifest.private === true
      && Array.isArray(manifest.workspaces)
      && manifest.workspaces.includes("examples/*");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Resolve the SiteSpec project used by `sitespec design dev`. Installed projects
 * default to the current directory. When developing the SiteSpec monorepo itself,
 * the repository root is not a SiteSpec website, so the bundled marketing example
 * is used as the executable Design System fixture. An explicit --root always wins.
 */
export async function resolveDesignLabProjectRoot(options: {
  root?: string;
  cwd?: string;
} = {}): Promise<DesignLabRootResolution> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.root !== undefined) {
    return { root: resolve(cwd, options.root), source: "explicit" };
  }

  if (await pathExists(join(cwd, "site.yaml"))) {
    return { root: cwd, source: "project" };
  }

  const repositoryExample = join(cwd, "examples", "marketing");
  if (await isSiteSpecSourceRepository(cwd) && await pathExists(join(repositoryExample, "site.yaml"))) {
    return { root: repositoryExample, source: "repository-example" };
  }

  return { root: cwd, source: "project" };
}

function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === "error");
}

function designLabUrl(serverUrl: string, site?: ResolvedSite): string | undefined {
  if (!site) return undefined;
  const basePath = new URL(site.site.url).pathname.replace(/\/+$/, "");
  const path = `${basePath && basePath !== "/" ? basePath : ""}/__sitespec/design/`;
  return new URL(path, serverUrl).href;
}

async function validateForDev(root: string): Promise<DevValidationState> {
  try {
    const project = await loadProject(root);
    const result = await validateLoadedProject(project);
    const rendererDiagnostics = await validateAstroComponentContracts({ root, registry: project.registry, uiRegistry: project.uiRegistry });
    const diagnostics = [...result.diagnostics, ...rendererDiagnostics];
    return {
      valid: result.valid && !!result.site && !hasErrors(rendererDiagnostics),
      site: result.site,
      diagnostics
    };
  } catch (error) {
    return {
      valid: false,
      diagnostics: [{
        code: "DEV_VALIDATE_FAILED",
        severity: "error",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

function sourcePath(root: string, absoluteOrRelativePath: string): string {
  const absolute = isAbsolute(absoluteOrRelativePath)
    ? absoluteOrRelativePath
    : resolve(root, absoluteOrRelativePath);
  return relative(root, absolute).replaceAll("\\", "/");
}

function isWatchedSourcePath(path: string): boolean {
  if (path === "site.yaml" || path === "design-system.yaml") return true;
  return ["pages/", "content/", "sections/", "components/", "ui/", "shell/", "design/", "public/"]
    .some(prefix => path.startsWith(prefix));
}

async function waitForWatcherReady(watcher: FSWatcher): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    const onReady = (): void => {
      watcher.off("error", onError);
      resolveReady();
    };
    const onError = (error: unknown): void => {
      watcher.off("ready", onReady);
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
}

export async function startDev(options: DevProjectOptions): Promise<DevProjectServer> {
  const root = await realpath(resolve(options.root));
  const initial = await validateForDev(root);
  const dev = await startAstroDevServer({
    root,
    site: initial.valid ? initial.site : undefined,
    diagnostics: initial.diagnostics,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 4321,
    logLevel: options.rendererLogLevel,
    designLab: options.designLab === true
  });
  const initialValid = initial.valid && !hasErrors(initial.diagnostics);

  let timer: NodeJS.Timeout | undefined;
  let processing = false;
  let pending = false;
  let closed = false;
  const debounceMs = options.debounceMs ?? 80;

  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (processing) {
      pending = true;
      return;
    }
    processing = true;
    try {
      const state = await validateForDev(root);
      if (!state.valid || !state.site) {
        await dev.showDiagnostics(state.diagnostics);
        options.onEvent?.({ event: "invalid", valid: false, diagnostics: state.diagnostics });
        return;
      }

      const rendererDiagnostics = await dev.update(state.site);
      const diagnostics = [...state.diagnostics, ...rendererDiagnostics];
      if (hasErrors(rendererDiagnostics)) {
        options.onEvent?.({ event: "invalid", valid: false, diagnostics });
      } else {
        options.onEvent?.({ event: "updated", valid: true, diagnostics });
      }
    } catch (error) {
      const diagnostics: Diagnostic[] = [{
        code: "DEV_REFRESH_FAILED",
        severity: "error",
        message: error instanceof Error ? error.message : String(error)
      }];
      try {
        await dev.showDiagnostics(diagnostics);
      } catch {
        // The Astro dev server may already be stopping; the event still explains the failure.
      }
      options.onEvent?.({ event: "error", valid: false, diagnostics });
    } finally {
      processing = false;
      if (pending && !closed) {
        pending = false;
        void refresh();
      }
    }
  };

  const onSourceChange = (changedPath: string): void => {
    if (closed) return;
    const path = sourcePath(root, changedPath);
    if (!isWatchedSourcePath(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  };

  const sourceWatcher = chokidar.watch(WATCHED_SOURCE_PATHS, {
    cwd: root,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 }
  });
  sourceWatcher.on("all", (_event: string, changedPath: string) => onSourceChange(changedPath));
  try {
    await waitForWatcherReady(sourceWatcher);
  } catch (error) {
    await sourceWatcher.close();
    await dev.stop();
    throw error;
  }

  const labUrl = options.designLab ? designLabUrl(dev.url, initial.site) : undefined;
  options.onEvent?.({
    event: "ready",
    url: dev.url,
    labUrl,
    host: dev.host,
    port: dev.port,
    valid: initialValid,
    diagnostics: initial.diagnostics
  });

  return {
    root,
    host: dev.host,
    port: dev.port,
    url: dev.url,
    labUrl,
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      await sourceWatcher.close();
      await dev.stop();
    }
  };
}

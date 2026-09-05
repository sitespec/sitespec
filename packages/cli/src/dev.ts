import { watch } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadProject, validateLoadedProject, type Diagnostic, type ResolvedSite } from "@sitespec/core";
import { startAstroDevServer, validateAstroComponentContracts } from "@sitespec/astro";

export interface DevProjectOptions {
  root: string;
  host?: string;
  port?: number;
  debounceMs?: number;
  rendererLogLevel?: "debug" | "info" | "warn" | "error" | "silent";
  onEvent?: (event: DevEvent) => void;
}

export type DevEvent =
  | { event: "ready"; url: string; host: string; port: number; valid: boolean; diagnostics: Diagnostic[] }
  | { event: "updated"; valid: true; diagnostics: Diagnostic[] }
  | { event: "invalid"; valid: false; diagnostics: Diagnostic[] }
  | { event: "error"; valid: false; diagnostics: Diagnostic[] };

export interface DevProjectServer {
  root: string;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface DevValidationState {
  valid: boolean;
  site?: ResolvedSite;
  diagnostics: Diagnostic[];
}

function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === "error");
}

async function validateForDev(root: string): Promise<DevValidationState> {
  try {
    const project = await loadProject(root);
    const result = await validateLoadedProject(project);
    const rendererDiagnostics = await validateAstroComponentContracts({ root, registry: project.registry });
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
  if (path === "site.yaml") return true;
  return ["pages/", "content/", "components/", "shell/", "design/", "public/"]
    .some(prefix => path.startsWith(prefix));
}

export async function startDev(options: DevProjectOptions): Promise<DevProjectServer> {
  // Keep validation, SiteSpec source watching and Astro/Vite in the same
  // physical path namespace. On macOS, /var/... resolves to /private/var/...;
  // canonicalizing once prevents the CLI and renderer from comparing two
  // spellings of the same project path.
  const root = await realpath(resolve(options.root));
  const initial = await validateForDev(root);
  const dev = await startAstroDevServer({
    root,
    site: initial.valid ? initial.site : undefined,
    diagnostics: initial.diagnostics,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 4321,
    logLevel: options.rendererLogLevel
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

  const onSourceChange = (_event: string, changedPath: string | Buffer | null): void => {
    if (closed || changedPath === null) return;
    const path = sourcePath(root, changedPath.toString());
    if (!isWatchedSourcePath(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  };

  // Keep SiteSpec source watching separate from Astro/Vite's generated-source
  // watcher. Adding project paths to an already-running Vite watcher is racy:
  // startDev() can return before chokidar has finished subscribing to those
  // newly-added paths, so the first edit after startup may be missed. Node 22+
  // supports recursive fs.watch on our supported desktop/server platforms, and
  // watch() is active before it returns, so the ready signal below means source
  // changes are actually observable.
  const sourceWatcher = watch(root, { recursive: true }, onSourceChange);

  options.onEvent?.({
    event: "ready",
    url: dev.url,
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
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      sourceWatcher.close();
      await dev.stop();
    }
  };
}

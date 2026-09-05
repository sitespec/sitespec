import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  // Keep the CLI watcher and Astro/Vite in the same physical path namespace.
  // On macOS, /var/... resolves to /private/var/...; if only the renderer
  // canonicalizes the root, chokidar reports /private/var/... while this
  // layer compares events against /var/... and silently drops source changes.
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

  const watched = [
    join(root, "site.yaml"),
    join(root, "pages"),
    join(root, "content"),
    join(root, "components"),
    join(root, "shell"),
    join(root, "design"),
    join(root, "public")
  ];
  dev.watcher.add(watched);

  options.onEvent?.({
    event: "ready",
    url: dev.url,
    host: dev.host,
    port: dev.port,
    valid: initialValid,
    diagnostics: initial.diagnostics
  });

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

  const onWatcherEvent = (_event: string, changedPath: string): void => {
    if (closed) return;
    const path = sourcePath(root, changedPath);
    if (!isWatchedSourcePath(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  };

  dev.watcher.on("all", onWatcherEvent);

  return {
    root,
    host: dev.host,
    port: dev.port,
    url: dev.url,
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      dev.watcher.off("all", onWatcherEvent);
      await dev.stop();
    }
  };
}

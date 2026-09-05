import chokidar, { type FSWatcher } from "chokidar";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
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

const WATCHED_SOURCE_PATHS = [
  "site.yaml",
  "pages",
  "content",
  "components",
  "shell",
  "design",
  "public"
];

async function waitForWatcherReady(watcher: FSWatcher): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    const onReady = (): void => {
      watcher.off("error", onError);
      resolveReady();
    };
    const onError = (error: unknown): void => {
      watcher.off("ready", onReady);
      rejectReady(
        error instanceof Error ? error : new Error(String(error))
      );
    };

    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
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

  const onSourceChange = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  };

  // SiteSpec source watching is deliberately separate from Astro/Vite's
  // generated-source watcher. Chokidar gives us a cross-platform `ready`
  // barrier, so startDev() cannot return while the first source edit is still
  // able to race watcher subscription (observed on GitHub Actions/Linux).
  const sourceWatcher = chokidar.watch(WATCHED_SOURCE_PATHS, {
    cwd: root,
    persistent: true,
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 10
    }
  });
  sourceWatcher.on("all", onSourceChange);

  try {
    await waitForWatcherReady(sourceWatcher);
  } catch (error) {
    await sourceWatcher.close();
    await dev.stop();
    throw new Error(
      `Failed to start SiteSpec source watcher: ${error instanceof Error ? error.message : String(error)}`
    );
  }

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
      sourceWatcher.off("all", onSourceChange);
      await sourceWatcher.close();
      await dev.stop();
    }
  };
}

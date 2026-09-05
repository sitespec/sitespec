import { createReadStream } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { isBuildFresh } from "./build-state.js";

export interface PreviewProjectOptions {
  root: string;
  host?: string;
  port?: number;
}

export interface PreviewServer {
  root: string;
  outDir: string;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export class PreviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8"
};

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function safePathname(rawUrl: string | undefined): string | undefined {
  try {
    const url = new URL(rawUrl ?? "/", "http://preview.local");
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("\0")) return undefined;
    const segments = decoded.split("/");
    if (segments.some(segment => segment === ".." || segment === ".")) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

async function regularFile(path: string, realOutDir?: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (realOutDir) {
      const resolvedFile = await realpath(path);
      if (!inside(realOutDir, resolvedFile)) return false;
    }
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function resolveRequestFile(outDir: string, realOutDir: string, pathname: string): Promise<string | undefined> {
  const clean = pathname.replace(/^\/+/, "");
  const exact = join(outDir, clean);
  if (!inside(outDir, exact)) return undefined;

  if (pathname.endsWith("/")) {
    const index = join(exact, "index.html");
    return inside(outDir, index) && await regularFile(index, realOutDir) ? index : undefined;
  }

  if (await regularFile(exact, realOutDir)) return exact;

  const routeIndex = join(exact, "index.html");
  if (inside(outDir, routeIndex) && await regularFile(routeIndex, realOutDir)) return routeIndex;
  return undefined;
}

async function serveFile(response: ServerResponse, file: string, method: string, status = 200): Promise<void> {
  const info = await stat(file);
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(status, {
    "content-type": type,
    "content-length": String(info.size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}

async function verifyPreviewBuild(root: string, outDir: string): Promise<string> {
  try {
    await access(outDir);
  } catch {
    throw new PreviewError("PREVIEW_BUILD_MISSING", `No production build found at ${relative(root, outDir) || "dist"}. Run npm run build first.`);
  }
  const outInfo = await lstat(outDir);
  if (outInfo.isSymbolicLink() || !outInfo.isDirectory()) {
    throw new PreviewError("PREVIEW_BUILD_INVALID", "dist must be a real directory, not a symlink. Run npm run build again.");
  }
  const realOutDir = await realpath(outDir);
  if (!await regularFile(join(outDir, "index.html"), realOutDir)) {
    throw new PreviewError("PREVIEW_BUILD_INVALID", "dist/index.html is missing. Run npm run build again.");
  }

  const freshness = await isBuildFresh(root);
  if (!freshness.state) {
    throw new PreviewError("PREVIEW_BUILD_STATE_MISSING", ".site/build.json is missing or invalid. Run npm run build again.");
  }
  if (!freshness.fresh) {
    throw new PreviewError("PREVIEW_BUILD_STALE", "Source files changed after the last production build. Run npm run build again before previewing.");
  }
  return realOutDir;
}

export async function startPreview(options: PreviewProjectOptions): Promise<PreviewServer> {
  const root = resolve(options.root);
  const outDir = join(root, "dist");
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4321;

  const realOutDir = await verifyPreviewBuild(root, outDir);

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        sendText(response, 405, "Method Not Allowed\n");
        return;
      }

      const pathname = safePathname(request.url);
      if (!pathname) {
        sendText(response, 400, "Bad Request\n");
        return;
      }

      const file = await resolveRequestFile(outDir, realOutDir, pathname);
      if (file) {
        await serveFile(response, file, method);
        return;
      }

      const notFound = join(outDir, "404.html");
      if (await regularFile(notFound, realOutDir)) {
        await serveFile(response, notFound, method, 404);
        return;
      }
      sendText(response, 404, "Not Found\n");
    } catch (error) {
      if (!response.headersSent) {
        sendText(response, 500, "Internal Preview Error\n");
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  } catch (error) {
    throw new PreviewError(
      "PREVIEW_LISTEN_FAILED",
      `Could not listen on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new PreviewError("PREVIEW_LISTEN_FAILED", "Preview server did not expose a TCP address.");
  }
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const actualHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  const url = `http://${actualHost}:${address.port}/`;

  return {
    root,
    outDir,
    host,
    port: address.port,
    url,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    })
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { startDev, type DevEvent } from "../packages/cli/src/dev.ts";

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  if (lastError) throw lastError;
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("npm run dev serves source changes, survives invalid specs, and does not create dist", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-dev-"));
  const root = join(temp, "acme");
  const linkedRoot = join(temp, "acme-link");
  const events: DevEvent[] = [];
  let dev: Awaited<ReturnType<typeof startDev>> | undefined;

  try {
    await initProject({ directory: root, name: "Acme" });
    const devRoot = process.platform === "win32" ? root : linkedRoot;
    if (process.platform !== "win32") await symlink(root, linkedRoot, "dir");

    dev = await startDev({ root: devRoot, port: 0, debounceMs: 20, onEvent: event => events.push(event) });
    assert.equal(dev.root, await realpath(root));

    const pageFile = join(root, "pages", "home.yaml");
    const original = await readFile(pageFile, "utf8");
    const titleLine = original.match(/^      title: (.+)$/m);
    assert.ok(titleLine);
    const originalTitle = titleLine[1]!;

    const initial = await fetch(dev.url);
    assert.equal(initial.status, 200);
    assert.ok((await initial.text()).includes(originalTitle));
    assert.equal(await exists(join(root, "dist")), false);

    const updated = original.replace(
      titleLine[0],
      "      title: A live Site Spec development loop"
    );
    await writeFile(pageFile, updated, "utf8");

    await waitFor(async () => {
      const response = await fetch(dev!.url);
      const html = await response.text();
      return html.includes("A live Site Spec development loop") ? html : undefined;
    });
    assert.ok(events.some(event => event.event === "updated"));

    await writeFile(pageFile, `${updated}\nunknownTopLevelField: true\n`, "utf8");
    const diagnosticsHtml = await waitFor(async () => {
      const response = await fetch(dev!.url);
      const html = await response.text();
      return html.includes("Site Spec is temporarily invalid") ? html : undefined;
    });
    assert.match(diagnosticsHtml, /PAGE_SCHEMA_INVALID/);
    assert.ok(events.some(event => event.event === "invalid"));

    await writeFile(pageFile, original, "utf8");
    await waitFor(async () => {
      const response = await fetch(dev!.url);
      const html = await response.text();
      return html.includes(originalTitle) ? html : undefined;
    });
    assert.equal(await exists(join(root, "dist")), false);
  } finally {
    if (dev) await dev.close();
    await rm(temp, { recursive: true, force: true });
  }
});

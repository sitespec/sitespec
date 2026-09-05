import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBuildState } from "../packages/cli/src/build-state.ts";
import { PreviewError, startPreview } from "../packages/cli/src/preview.ts";

async function makePreviewProject(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "acme");
  await mkdir(join(root, "pages"), { recursive: true });
  await mkdir(join(root, "dist", "pricing"), { recursive: true });
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await writeFile(join(root, "site.yaml"), 'specVersion: "0.1"\n', "utf8");
  await writeFile(join(root, "pages", "home.yaml"), 'specVersion: "0.1"\n', "utf8");
  await writeFile(join(root, "dist", "index.html"), "<!doctype html><h1>Home</h1>", "utf8");
  await writeFile(join(root, "dist", "pricing", "index.html"), "<!doctype html><h1>Pricing</h1>", "utf8");
  await writeFile(join(root, "dist", "assets", "app.css"), "body{}", "utf8");
  await writeFile(join(root, "dist", "404.html"), "<!doctype html><h1>Missing</h1>", "utf8");
  await writeFile(join(temp, "outside.txt"), "outside", "utf8");
  await symlink(join(temp, "outside.txt"), join(root, "dist", "assets", "outside.txt"));
  await writeBuildState(root, ["/", "/pricing"]);
  return { temp, root };
}

test("npm run preview serves only the existing static production build", async () => {
  const { temp, root } = await makePreviewProject("site-preview-");
  let preview: Awaited<ReturnType<typeof startPreview>> | undefined;
  try {
    preview = await startPreview({ root, port: 0 });

    const home = await fetch(preview.url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Home/);
    assert.equal(home.headers.get("cache-control"), "no-store");

    const pricing = await fetch(new URL("/pricing", preview.url));
    assert.equal(pricing.status, 200);
    assert.match(await pricing.text(), /Pricing/);

    const css = await fetch(new URL("/assets/app.css", preview.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const missing = await fetch(new URL("/does-not-exist", preview.url));
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Missing/);

    const escapedSymlink = await fetch(new URL("/assets/outside.txt", preview.url));
    assert.equal(escapedSymlink.status, 404);
    assert.doesNotMatch(await escapedSymlink.text(), /outside/);

    const head = await fetch(new URL("/pricing", preview.url), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const post = await fetch(preview.url, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  } finally {
    if (preview) await preview.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("npm run preview refuses a stale production build", async () => {
  const { temp, root } = await makePreviewProject("site-preview-stale-");
  try {
    await writeFile(join(root, "pages", "home.yaml"), 'specVersion: "0.1"\nchanged: true\n', "utf8");
    await assert.rejects(
      () => startPreview({ root, port: 0 }),
      (error: unknown) => error instanceof PreviewError && error.code === "PREVIEW_BUILD_STALE"
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("npm run preview refuses missing build metadata", async () => {
  const { temp, root } = await makePreviewProject("site-preview-state-");
  try {
    await rm(join(root, ".site", "build.json"), { force: true });
    await assert.rejects(
      () => startPreview({ root, port: 0 }),
      (error: unknown) => error instanceof PreviewError && error.code === "PREVIEW_BUILD_STATE_MISSING"
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

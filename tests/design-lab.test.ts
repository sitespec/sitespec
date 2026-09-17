import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { resolveDesignLabProjectRoot, startDev } from "../packages/cli/src/dev.ts";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("design dev exposes the installed Design System through the live Design Lab", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-design-lab-"));
  const root = join(temp, "site");
  let dev: Awaited<ReturnType<typeof startDev>> | undefined;

  try {
    await initProject({ directory: root, name: "Design Lab Test" });
    dev = await startDev({ root, port: 0, designLab: true, rendererLogLevel: "silent" });
    assert.ok(dev.labUrl);

    const response = await fetch(dev.labUrl!);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /SiteSpec Design Lab/);
    assert.match(html, /Foundations/);
    assert.match(html, /data-lab-ui="button"/);
    assert.match(html, /data-lab-ui="icon-button"/);
    assert.match(html, /data-lab-ui="text-field"/);
    assert.match(html, /data-lab-ui="textarea-field"/);
    assert.match(html, /data-lab-ui="select-field"/);
    assert.match(html, /data-lab-ui="checkbox"/);
    assert.match(html, /data-lab-ui="radio-group"/);
    assert.match(html, /data-lab-ui="switch"/);
    assert.match(html, /data-lab-ui-state="hover"/);
    assert.match(html, /data-lab-ui-state="active"/);
    assert.match(html, /data-lab-ui-state="focus-visible"/);
    assert.match(html, /data-lab-ui-state="disabled"/);
    assert.match(html, /data-lab-ui-state="invalid"/);
    assert.match(html, /data-lab-ui-state="readonly"/);
    assert.match(html, /data-lab-ui-state="checked"/);
    assert.match(html, /data-lab-form-benchmark/);
    assert.match(html, /Form composition/);
    assert.match(html, /data-sitespec-state/);
    assert.match(html, /data-lab-section="hero"/);
    assert.match(html, /data-lab-theme/);
    assert.match(html, /data-lab-stress-toggle/);
    assert.match(html, /data-lab-page-frame/);
    assert.match(html, /sitespec-design-preview/);
    assert.match(html, /sitespec:design-lab-theme/);
    assert.match(html, /sitespec:design-lab-state/);

    const themedResponse = await fetch(new URL("sitespec-design-preview/dark/normal/home", dev.url));
    assert.equal(themedResponse.status, 200);
    const themedHtml = await themedResponse.text();
    assert.match(themedHtml, /<html[^>]+data-site-theme="dark"/);
    assert.match(themedHtml, /data-sitespec-theme-bootstrap/);
    assert.match(themedHtml, /sitespec-design-preview/);
    assert.match(themedHtml, /href="\/sitespec-design-preview\/dark\/normal\/features"/);
    assert.match(themedHtml, /sitespec:design-lab-state/);

    const stressResponse = await fetch(new URL("sitespec-design-preview/dark/stress/home", dev.url));
    assert.equal(stressResponse.status, 200);
    const stressHtml = await stressResponse.text();
    assert.match(stressHtml, /<html[^>]+data-site-theme="dark"/);
    assert.match(stressHtml, /A much longer heading that deliberately wraps/);
    assert.match(stressHtml, /deliberately long navigation label/);
    assert.match(stressHtml, /href="\/sitespec-design-preview\/dark\/stress\/blog"/);

    const generated = await readFile(join(root, ".site", "astro", "src", "pages", "[...designLab].astro"), "utf8");
    assert.match(generated, /params: \{ designLab: "__sitespec\/design" \}/);
    assert.match(generated, /@site-project\/ui\/button\/index\.astro/);
    assert.match(generated, /@site-project\/ui\/text-field\/index\.astro/);
    assert.match(generated, /benchmark-email-stress/);
    assert.match(generated, /@site-project\/components\/hero\/index\.astro/);
    const regularResponse = await fetch(dev.url);
    const regularHtml = await regularResponse.text();
    assert.match(regularHtml, /data-sitespec-theme-bootstrap/);
    assert.match(regularHtml, /data-icon="theme"/);
    assert.match(regularHtml, /data-icon="menu"/);

    const generatedHome = await readFile(join(root, ".site", "astro", "src", "pages", "index.astro"), "utf8");
    assert.doesNotMatch(generatedHome, /sitespec-design-preview|__sitespec_theme|__sitespec_stress/);
    const generatedStress = await readFile(join(root, ".site", "astro", "src", "pages", "sitespec-design-preview", "dark", "stress", "home.astro"), "utf8");
    assert.match(generatedStress, /theme\":\"dark/);
    assert.match(generatedStress, /A much longer heading that deliberately wraps/);
    assert.equal(await exists(join(root, "dist")), false);
  } finally {
    if (dev) await dev.close();
    await rm(temp, { recursive: true, force: true });
  }
});


test("design dev resolves a SiteSpec project and the source-repository example without overriding explicit roots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-design-root-"));
  try {
    const project = join(temp, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "site.yaml"), "specVersion: 7\n", "utf8");
    assert.deepEqual(await resolveDesignLabProjectRoot({ cwd: project }), {
      root: project,
      source: "project"
    });

    const repository = join(temp, "repository");
    const example = join(repository, "examples", "marketing");
    await mkdir(example, { recursive: true });
    await writeFile(join(repository, "package.json"), JSON.stringify({
      name: "sitespec",
      private: true,
      workspaces: ["packages/*", "examples/*"]
    }), "utf8");
    await writeFile(join(example, "site.yaml"), "specVersion: 7\n", "utf8");

    assert.deepEqual(await resolveDesignLabProjectRoot({ cwd: repository }), {
      root: example,
      source: "repository-example"
    });
    assert.deepEqual(await resolveDesignLabProjectRoot({ cwd: repository, root: "." }), {
      root: repository,
      source: "explicit"
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

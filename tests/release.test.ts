import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const packagePaths = ["core", "astro", "template", "cli", "create"];
const publicNames = ["@sitespec/core", "@sitespec/astro", "@sitespec/template", "@sitespec/cli", "@sitespec/create"];

test("Changesets keeps all public packages in one fixed release train", async () => {
  const config = JSON.parse(await readFile(join(root, ".changeset", "config.json"), "utf8")) as {
    access: string;
    baseBranch: string;
    fixed: string[][];
  };
  assert.equal(config.access, "public");
  assert.equal(config.baseBranch, "main");
  assert.deepEqual(config.fixed, [publicNames]);
});

test("public npm packages have release metadata", async () => {
  const versions: string[] = [];
  for (let index = 0; index < packagePaths.length; index++) {
    const pkg = JSON.parse(await readFile(join(root, "packages", packagePaths[index], "package.json"), "utf8")) as {
      name: string;
      version: string;
      license: string;
      publishConfig?: { access?: string };
    };
    assert.equal(pkg.name, publicNames[index]);
    assert.equal(pkg.license, "MIT");
    assert.equal(pkg.publishConfig?.access, "public");
    versions.push(pkg.version);
  }
  assert.equal(new Set(versions).size, 1);
});

test("release workflow separates version and OIDC publish permissions", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /changesets\/action\/select-mode@v2\.1\.1/);
  assert.match(workflow, /changesets\/action\/version@v2\.1\.1/);
  assert.match(workflow, /changesets\/action\/publish@v2\.1\.1/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /NPM_CONFIG_PROVENANCE: "true"/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("packed template preserves the generated-site gitignore source", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-template-pack-"));
  try {
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: join(root, "packages", "template"),
      encoding: "utf8"
    });
    const result = JSON.parse(stdout)[0] as { files: Array<{ path: string }> };
    const files = new Set(result.files.map(file => file.path));
    assert.equal(files.has("template/_gitignore"), true);
    assert.equal(files.has("template/.gitignore"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("Astro integration tests run serially to avoid shared prerender state races", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.match(pkg.scripts?.test ?? "", /--test-concurrency=1/);
});

test("release commands fail fast on unsupported Node runtimes and pin Node 24 for maintainers", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    engines?: { node?: string };
  };
  assert.equal((await readFile(join(root, ".nvmrc"), "utf8")).trim(), "24");
  assert.equal((await readFile(join(root, ".node-version"), "utf8")).trim(), "24");
  assert.equal(pkg.engines?.node, "^22.11.0 || ^24.0.0 || >=26.0.0");
  for (const name of ["changeset", "release:check", "release:version", "release:publish"]) {
    assert.match(pkg.scripts?.[name] ?? "", /verify-release-runtime\.mjs/);
  }
  const preflight = await readFile(join(root, "scripts", "verify-release-runtime.mjs"), "utf8");
  assert.match(preflight, /major === 22 && minor >= 11/);
  assert.match(preflight, /major === 24/);
  assert.match(preflight, /nvm use 24/);
});

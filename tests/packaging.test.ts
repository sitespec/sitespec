import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { initProject } from "../packages/cli/src/init.ts";

const execFileAsync = promisify(execFile);

interface SitePackage {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

test("sitespec init creates a standalone npm site pinned to the local engine contract", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-packaging-init-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as SitePackage;
    const cliPackage = JSON.parse(await readFile(join(process.cwd(), "packages/cli/package.json"), "utf8")) as { version: string };
    assert.equal(pkg.devDependencies["@sitespec/cli"], cliPackage.version);
    assert.equal(pkg.scripts.dev, "sitespec dev");
    assert.equal(pkg.scripts.build, "sitespec build");
    assert.equal(pkg.scripts.validate, "sitespec validate");
    assert.equal(pkg.scripts.preview, "sitespec preview");
    assert.equal(pkg.scripts.site, "sitespec");

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /npm run site -- spec --json/);
    assert.match(agents, /npm run site -- validate --json/);
    assert.match(agents, /npm run build/);
    assert.doesNotMatch(agents, /^sitespec spec --json$/m);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("@sitespec/cli ships a stable executable shim before dist exists", async () => {
  const packageRoot = join(process.cwd(), "packages", "cli");
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    files?: string[];
  };
  assert.deepEqual(pkg.bin, { sitespec: "./bin/sitespec.js" });
  assert.equal(pkg.files?.includes("bin"), true);

  const shimFile = join(packageRoot, "bin", "sitespec.js");
  const shim = await readFile(shimFile, "utf8");
  const mode = (await stat(shimFile)).mode & 0o777;
  assert.match(shim, /^#!\/usr\/bin\/env node/);
  assert.match(shim, /\.\.\/dist\/index\.js/);
  assert.notEqual(mode & 0o111, 0);
});


test("@sitespec/create can scaffold without registry access", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sitespec-create-package-"));
  const root = join(temp, "created-site");
  try {
    const binary = join(process.cwd(), "packages", "create", "dist", "index.js");
    const result = await execFileAsync(process.execPath, [binary, root, "--name", "Created Site", "--no-install", "--no-git"], {
      encoding: "utf8"
    });
    assert.match(result.stdout, /Created Created Site/);

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as SitePackage;
    const createPackage = JSON.parse(await readFile(join(process.cwd(), "packages/create/package.json"), "utf8")) as { version: string };
    assert.equal(pkg.devDependencies["@sitespec/cli"], createPackage.version);
    assert.equal((await readFile(join(root, "site.yaml"), "utf8")).includes("name: \"Created Site\""), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("public packages use one synchronized release train", async () => {
  const packageFiles = [
    "packages/core/package.json",
    "packages/astro/package.json",
    "packages/template/package.json",
    "packages/cli/package.json",
    "packages/create/package.json"
  ];
  const versions = await Promise.all(packageFiles.map(async file => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), file), "utf8")) as { version: string };
    return pkg.version;
  }));
  assert.equal(new Set(versions).size, 1);
});


test("public package names and CLI binary match the SiteSpec naming contract", async () => {
  const expectations = [
    ["packages/core/package.json", "@sitespec/core"],
    ["packages/astro/package.json", "@sitespec/astro"],
    ["packages/template/package.json", "@sitespec/template"],
    ["packages/cli/package.json", "@sitespec/cli"],
    ["packages/create/package.json", "@sitespec/create"]
  ] as const;

  for (const [file, expectedName] of expectations) {
    const pkg = JSON.parse(await readFile(join(process.cwd(), file), "utf8")) as { name: string; bin?: Record<string, string> };
    assert.equal(pkg.name, expectedName);
    if (expectedName === "@sitespec/cli") assert.deepEqual(pkg.bin, { sitespec: "./bin/sitespec.js" });
  }

  const createSource = await readFile(join(process.cwd(), "packages", "create", "src", "index.ts"), "utf8");
  assert.match(createSource, /npm create @sitespec@latest my-site/);
});

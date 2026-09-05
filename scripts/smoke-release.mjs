import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const manifestPath = resolve(root, ".release", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const byName = new Map(manifest.packages.map(pkg => [pkg.name, pkg]));
const requiredNames = ["@sitespec/core", "@sitespec/astro", "@sitespec/template", "@sitespec/cli", "@sitespec/create"];
for (const name of requiredNames) if (!byName.has(name)) throw new Error(`Release manifest is missing ${name}`);

const temp = await mkdtemp(join(tmpdir(), "sitespec-release-smoke-"));
try {
  const harness = join(temp, "harness");
  await writeFile(join(temp, "package.json"), JSON.stringify({
    name: "sitespec-release-smoke-harness",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(requiredNames.map(name => [name, `file:${byName.get(name).path}`]))
  }, null, 2) + "\n");

  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: temp,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });

  const createEntry = join(temp, "node_modules", "@sitespec", "create", "dist", "index.js");
  await execFileAsync(process.execPath, [createEntry, harness, "--name", "Release Smoke", "--no-install", "--no-git"], {
    cwd: temp,
    encoding: "utf8"
  });

  const sitePackagePath = join(harness, "package.json");
  const sitePackage = JSON.parse(await readFile(sitePackagePath, "utf8"));
  if (sitePackage.devDependencies?.["@sitespec/cli"] !== manifest.releaseVersion) {
    throw new Error(`create package generated CLI ${sitePackage.devDependencies?.["@sitespec/cli"]}; expected ${manifest.releaseVersion}`);
  }
  sitePackage.devDependencies = {
    ...sitePackage.devDependencies,
    "@sitespec/core": `file:${byName.get("@sitespec/core").path}`,
    "@sitespec/astro": `file:${byName.get("@sitespec/astro").path}`,
    "@sitespec/template": `file:${byName.get("@sitespec/template").path}`,
    "@sitespec/cli": `file:${byName.get("@sitespec/cli").path}`
  };
  await writeFile(sitePackagePath, JSON.stringify(sitePackage, null, 2) + "\n");

  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: harness,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  await execFileAsync("npm", ["run", "validate"], { cwd: harness, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  await execFileAsync("npm", ["run", "build"], { cwd: harness, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

  const html = await readFile(join(harness, "dist", "index.html"), "utf8");
  if (!html.includes("Release Smoke")) throw new Error("Packed release smoke build did not render the generated site");
  console.log(`Packed release smoke passed for SiteSpec ${manifest.releaseVersion}.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

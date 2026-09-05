import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const outDir = resolve(root, ".release", "packs");
const packages = [
  ["packages/core", "@sitespec/core", ["package.json", "dist/index.js", "dist/index.d.ts"]],
  ["packages/astro", "@sitespec/astro", ["package.json", "dist/index.js", "dist/index.d.ts"]],
  ["packages/template", "@sitespec/template", ["package.json", "dist/index.js", "dist/index.d.ts", "template/_gitignore", "template/site.yaml"]],
  ["packages/cli", "@sitespec/cli", ["package.json", "dist/index.js"]],
  ["packages/create", "@sitespec/create", ["package.json", "dist/index.js"]]
];

await rm(resolve(root, ".release"), { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const manifest = { version: 1, packages: [] };
for (const [dir, expectedName, requiredFiles] of packages) {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", outDir], {
    cwd: resolve(root, dir),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  const result = JSON.parse(stdout)[0];
  if (result.name !== expectedName) throw new Error(`${dir}: packed ${result.name}, expected ${expectedName}`);
  const fileSet = new Set(result.files.map(file => file.path));
  for (const required of requiredFiles) {
    if (!fileSet.has(required)) throw new Error(`${expectedName}: tarball is missing ${required}`);
  }
  for (const file of fileSet) {
    const allowedCoreSchema = expectedName === "@sitespec/core" && file.startsWith("src/schemas/");
    if ((!allowedCoreSchema && file.startsWith("src/")) || file.startsWith("tests/") || file.includes("node_modules/")) {
      throw new Error(`${expectedName}: tarball contains non-runtime file ${file}`);
    }
  }
  manifest.packages.push({
    name: result.name,
    version: result.version,
    filename: result.filename,
    path: join(outDir, result.filename),
    files: result.files.map(file => file.path)
  });
}

const versions = new Set(manifest.packages.map(pkg => pkg.version));
if (versions.size !== 1) throw new Error(`Packed packages are not on one release train: ${[...versions].join(", ")}`);
manifest.releaseVersion = [...versions][0];
await writeFile(resolve(root, ".release", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Packed ${manifest.packages.length} packages for SiteSpec ${manifest.releaseVersion}.`);

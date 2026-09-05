import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packages = [
  ["packages/core", "@sitespec/core"],
  ["packages/astro", "@sitespec/astro"],
  ["packages/template", "@sitespec/template"],
  ["packages/cli", "@sitespec/cli"],
  ["packages/create", "@sitespec/create"]
];

const loaded = [];
for (const [dir, expectedName] of packages) {
  const file = join(root, dir, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8"));
  if (pkg.name !== expectedName) throw new Error(`${file}: expected name ${expectedName}, got ${pkg.name}`);
  if (pkg.private === true) throw new Error(`${expectedName}: public package cannot be private`);
  if (pkg.publishConfig?.access !== "public") throw new Error(`${expectedName}: publishConfig.access must be public`);
  if (pkg.license !== "MIT") throw new Error(`${expectedName}: license must be MIT`);
  if (!pkg.version) throw new Error(`${expectedName}: version is missing`);
  if (!pkg.engines?.node) throw new Error(`${expectedName}: engines.node is missing`);
  loaded.push({ dir, pkg });
}

const versions = new Set(loaded.map(({ pkg }) => pkg.version));
if (versions.size !== 1) {
  throw new Error(`Public packages must share one release version, got: ${[...versions].join(", ")}`);
}
const [version] = versions;

const publicNames = new Set(loaded.map(({ pkg }) => pkg.name));
for (const { pkg } of loaded) {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (!publicNames.has(name)) continue;
      if (range !== version) {
        throw new Error(`${pkg.name}: internal dependency ${name} must be pinned to ${version}, got ${range}`);
      }
    }
  }
}

const cli = loaded.find(({ pkg }) => pkg.name === "@sitespec/cli")?.pkg;
if (JSON.stringify(cli?.bin) !== JSON.stringify({ sitespec: "./dist/index.js" })) {
  throw new Error(`@sitespec/cli: expected binary {\"sitespec\":\"./dist/index.js\"}`);
}
const create = loaded.find(({ pkg }) => pkg.name === "@sitespec/create")?.pkg;
if (JSON.stringify(create?.bin) !== JSON.stringify({ "create-sitespec": "./dist/index.js" })) {
  throw new Error(`@sitespec/create: expected binary {\"create-sitespec\":\"./dist/index.js\"}`);
}

console.log(`Verified 5 public packages at SiteSpec ${version}.`);

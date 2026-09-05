import { access } from "node:fs/promises";
import { constants } from "node:fs";

try {
  await access("package-lock.json", constants.R_OK);
} catch {
  throw new Error("package-lock.json is required for release CI. Run `npm install` with the pinned npm version and commit the lockfile.");
}
console.log("Release lockfile is present.");

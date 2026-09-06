import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SpecVersion } from "@sitespec/core";
import { readProjectSpecVersion } from "./project-spec-version.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ROLES = new Set(["intro", "content", "proof", "conversion", "utility"]);

export interface AddComponentOptions {
  root: string;
  id: string;
  role?: string;
}

export interface AddComponentResult {
  root: string;
  id: string;
  role: string;
  files: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function write(root: string, path: string, content: string, files: string[]): Promise<void> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  files.push(path);
}

function componentManifest(id: string, role: string, specVersion: SpecVersion): string {
  return `specVersion: "${specVersion}"

component:
  id: ${id}
  role: ${role}

description: ${JSON.stringify(`${id} section.`)}

variants:
  - default

themes:
  - default

props:
  type: object
  additionalProperties: false
  properties: {}

runtime:
  javascript: false
`;
}

function componentAstro(id: string): string {
  return `---
interface Props {
  sectionId: string;
  variant: string;
  theme: string;
  props: Record<string, unknown>;
}

const { sectionId, variant, theme, props } = Astro.props;
void props;
---
<section
  id={sectionId}
  data-section={sectionId}
  data-component="${id}"
  data-variant={variant}
  data-theme={theme}
>
  <div class="inner">
    <!-- Declare typed props in component.yaml, then render semantic markup here. -->
  </div>
</section>

<style>
  section {
    padding: var(--space-section) var(--space-page);
    background: var(--color-surface-default);
    color: var(--color-text-default);
  }

  .inner {
    max-width: var(--size-content);
    margin: 0 auto;
  }
</style>
`;
}

export async function addComponent(options: AddComponentOptions): Promise<AddComponentResult> {
  const root = resolve(options.root);
  const id = options.id.trim();
  const role = options.role?.trim() || "content";

  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid component id "${id}". Use lowercase letters, digits, and hyphens; start with a letter.`);
  }
  if (!ROLES.has(role)) {
    throw new Error(`Invalid component role "${role}". Use one of: intro, content, proof, conversion, utility.`);
  }
  if (!(await fileExists(join(root, "site.yaml")))) {
    throw new Error(`site.yaml was not found in ${root}. Run this command from a Site Spec project or pass --root.`);
  }

  const specVersion = await readProjectSpecVersion(root);

  const componentDir = join(root, "components", id);
  try {
    const entries = await readdir(componentDir);
    if (entries.length >= 0) {
      throw new Error(`Component "${id}" already exists at components/${id}.`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const files: string[] = [];
  await write(root, `components/${id}/component.yaml`, componentManifest(id, role, specVersion), files);
  await write(root, `components/${id}/index.astro`, componentAstro(id), files);

  return { root, id, role, files };
}

import { access } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp, { type Metadata } from "sharp";
import type { Diagnostic, ResolvedPage, SpecVersion } from "./types.js";

const LOCAL_IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

interface ImageRecord extends Record<string, unknown> {
  src: string;
  alt?: unknown;
  decorative?: unknown;
  width?: unknown;
  height?: unknown;
  crop?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isImageValue(value: unknown): value is ImageRecord {
  if (!isRecord(value) || typeof value.src !== "string") return false;
  let path = value.src;
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return false;
  }
  const extension = extname(path.split(/[?#]/, 1)[0] ?? "").toLowerCase();
  if (LOCAL_IMAGE_EXTENSIONS.has(extension)) return true;
  return ["alt", "decorative", "width", "height", "sizes", "widths", "formats", "quality", "loading", "decoding", "fetchPriority", "crop"]
    .some(key => key in value);
}

function publicImagePathIsSafe(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("%") || value.includes("\0")) return false;
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 && !parts.some(part => part === "." || part === "..");
}

function cropRatio(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.aspectRatio !== "string") return undefined;
  const match = value.aspectRatio.match(/^([1-9][0-9]{0,3}):([1-9][0-9]{0,3})$/);
  if (!match) return undefined;
  return Number(match[1]) / Number(match[2]);
}

function pageImageContexts(page: ResolvedPage): Array<{ value: unknown; path: string; section?: string }> {
  const contexts: Array<{ value: unknown; path: string; section?: string }> = [];
  for (const section of page.sections) {
    contexts.push({ value: section.props, path: `/sections/${section.id}/props`, section: section.id });
  }
  if (page.content?.entry) contexts.push({ value: page.content.entry, path: "/content/entry" });
  for (const [id, query] of Object.entries(page.content?.queries ?? {})) {
    contexts.push({ value: query.items, path: `/content/queries/${id}/items` });
  }
  return contexts;
}

function collectImages(value: unknown, path: string, out: Array<{ image: ImageRecord; path: string }>): void {
  if (isImageValue(value)) {
    out.push({ image: value, path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectImages(item, `${path}/${index}`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    collectImages(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, out);
  }
}

export async function validateResolvedMedia(
  root: string,
  specVersion: SpecVersion,
  pages: ResolvedPage[]
): Promise<Diagnostic[]> {
  if (specVersion !== "0.5") return [];
  const diagnostics: Diagnostic[] = [];
  const metadataCache = new Map<string, Metadata | Error>();

  for (const page of pages) {
    for (const context of pageImageContexts(page)) {
      const images: Array<{ image: ImageRecord; path: string }> = [];
      collectImages(context.value, context.path, images);
      for (const { image, path } of images) {
        const decorative = image.decorative === true;
        const alt = typeof image.alt === "string" ? image.alt : undefined;
        if (!decorative && (!alt || !alt.trim())) {
          diagnostics.push({
            code: "MEDIA_ALT_MISSING",
            severity: "error",
            page: page.id,
            section: context.section,
            path: `${path}/alt`,
            message: `Image ${JSON.stringify(image.src)} requires non-empty alt text or decorative: true.`
          });
        }
        if (decorative && alt && alt.trim()) {
          diagnostics.push({
            code: "MEDIA_DECORATIVE_ALT_NONEMPTY",
            severity: "warning",
            page: page.id,
            section: context.section,
            path: `${path}/alt`,
            message: `Decorative image ${JSON.stringify(image.src)} should use an empty alt value.`
          });
        }

        if (/^https?:\/\//i.test(image.src)) {
          if (!(typeof image.width === "number" && image.width > 0 && typeof image.height === "number" && image.height > 0)) {
            diagnostics.push({
              code: "MEDIA_REMOTE_DIMENSIONS_REQUIRED",
              severity: "error",
              page: page.id,
              section: context.section,
              path,
              message: `Remote image ${JSON.stringify(image.src)} requires explicit width and height because SiteSpec cannot inspect remote media at build time.`
            });
          }
          continue;
        }

        if (!publicImagePathIsSafe(image.src)) {
          diagnostics.push({
            code: "MEDIA_PATH_INVALID",
            severity: "error",
            page: page.id,
            section: context.section,
            path: `${path}/src`,
            message: `Local image paths must be safe public paths beginning with /; received ${JSON.stringify(image.src)}.`
          });
          continue;
        }

        const sourceFile = join(root, "public", ...image.src.slice(1).split("/"));
        try {
          await access(sourceFile);
        } catch {
          diagnostics.push({
            code: "MEDIA_IMAGE_NOT_FOUND",
            severity: "error",
            page: page.id,
            section: context.section,
            path: `${path}/src`,
            sourceFile: `public${image.src}`,
            message: `Image ${image.src} was not found under public/.`,
            suggestions: [{ action: "create-asset", file: `public${image.src}` }]
          });
          continue;
        }

        let cached = metadataCache.get(sourceFile);
        if (!cached) {
          try {
            cached = await sharp(sourceFile, { animated: true }).metadata();
          } catch (error) {
            cached = error instanceof Error ? error : new Error(String(error));
          }
          metadataCache.set(sourceFile, cached);
        }
        if (cached instanceof Error) {
          diagnostics.push({
            code: "MEDIA_IMAGE_INVALID",
            severity: "error",
            page: page.id,
            section: context.section,
            path: `${path}/src`,
            sourceFile: `public${image.src}`,
            message: `Image ${image.src} could not be decoded: ${cached.message}`
          });
          continue;
        }

        const extension = extname(sourceFile).toLowerCase();
        if (!cached.width || !cached.height) {
          diagnostics.push({
            code: "MEDIA_DIMENSIONS_UNKNOWN",
            severity: "error",
            page: page.id,
            section: context.section,
            path,
            sourceFile: `public${image.src}`,
            message: `Image ${image.src} does not expose usable intrinsic dimensions.`
          });
          continue;
        }

        if (cached.width && cached.height && typeof image.width === "number" && typeof image.height === "number" && !cropRatio(image.crop)) {
          const rotated = [5, 6, 7, 8].includes(cached.orientation ?? 1);
          const naturalWidth = rotated ? cached.height : cached.width;
          const naturalHeight = rotated ? cached.width : cached.height;
          const naturalRatio = naturalWidth / naturalHeight;
          const declaredRatio = image.width / image.height;
          if (Math.abs(naturalRatio - declaredRatio) / naturalRatio > 0.01) {
            diagnostics.push({
              code: "MEDIA_ASPECT_RATIO_MISMATCH",
              severity: "error",
              page: page.id,
              section: context.section,
              path,
              sourceFile: `public${image.src}`,
              message: `Declared ${image.width}x${image.height} dimensions distort the natural ${naturalWidth}x${naturalHeight} aspect ratio. Use crop.aspectRatio for intentional cropping.`,
              expected: `${naturalWidth}:${naturalHeight}`,
              actual: `${image.width}:${image.height}`
            });
          }
        }
      }
    }
  }

  return diagnostics;
}

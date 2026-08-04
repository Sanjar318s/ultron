/**
 * Character reference registry + auto-lookup used to steer local image
 * generation with a reference picture (IPAdapter/FaceID in ComfyUI).
 *
 * Runtime state (both gitignored):
 *   data/character-refs.json — name → { file, mode, aliases, source }
 *   <COMFY_REFS_DIR>          — the images themselves (ComfyUI input/refs/)
 *
 * Nothing here touches Three.js/React — it's a plain server-side store.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type RefMode = "style" | "face";

export interface CharacterRef {
  /** Filename inside the refs dir (e.g. "wei-wuxian.png"). */
  file: string;
  mode: RefMode;
  aliases: string[];
  source: "manual" | "web";
  createdAt: number;
}

const DATA_FILE = path.join(process.cwd(), "data", "character-refs.json");
const REFS_DIR = process.env.COMFY_REFS_DIR || "C:\\ComfyUI\\ComfyUI\\input\\refs";
// Wikimedia requires a descriptive UA; Node's default "node" agent gets throttled.
const WIKI_UA = "UltronOrb/1.0 (local image reference lookup)";

// No in-memory cache on purpose: /api/characters and /api/assistant are
// separate route bundles in Next, so a module-level cache would go stale when
// one route registers a ref the other must see. Lookups are rare anyway.
async function loadRefs(): Promise<Record<string, CharacterRef>> {
  try {
    const raw = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as { refs?: Record<string, CharacterRef> };
    return raw.refs ?? {};
  } catch {
    return {};
  }
}

async function persist(refs: Record<string, CharacterRef>): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.mkdir(REFS_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify({ version: 1, refs }, null, 2));
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "char"
  );
}

function sniffExt(buf: Buffer): "png" | "jpg" | "webp" {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 4).toString("ascii") === "RIFF") return "webp";
  return "png";
}

/** Find a known character by (fuzzy) name/alias mention in free text. Returns
 *  the entry plus the canonical name; prefers the longest matching alias. */
export async function resolveCharacterRef(
  text: string,
): Promise<{ name: string; ref: CharacterRef } | null> {
  const refs = await loadRefs();
  const t = text.toLowerCase();
  let best: { name: string; ref: CharacterRef; len: number } | null = null;
  for (const [name, ref] of Object.entries(refs)) {
    for (const key of [name, ...ref.aliases]) {
      const k = key.toLowerCase();
      if (k && t.includes(k) && (!best || k.length > best.len)) {
        best = { name, ref, len: k.length };
      }
    }
  }
  return best ? { name: best.name, ref: best.ref } : null;
}

/** Register (or update) a character reference from raw image bytes. */
export async function registerCharacterRef(
  name: string,
  bytes: Buffer,
  opts?: { mode?: RefMode; aliases?: string[]; source?: "manual" | "web" },
): Promise<CharacterRef> {
  const refs = await loadRefs();
  const file = `${slug(name)}.${sniffExt(bytes)}`;
  await fs.mkdir(REFS_DIR, { recursive: true });
  await fs.writeFile(path.join(REFS_DIR, file), bytes);
  const ref: CharacterRef = {
    file,
    mode: opts?.mode ?? "style",
    aliases: (opts?.aliases ?? []).map((a) => a.toLowerCase()),
    source: opts?.source ?? "manual",
    createdAt: Date.now(),
  };
  refs[name.toLowerCase()] = ref;
  await persist(refs);
  return ref;
}

export async function listCharacterRefs(): Promise<Record<string, CharacterRef>> {
  return loadRefs();
}

/** Download the first usable image for `query` from Wikimedia (Wikipedia lead
 *  image first, then Commons file search) and register it as a character ref. */
export async function fetchCharacterRefWeb(
  query: string,
  opts?: { mode?: RefMode; name?: string },
): Promise<CharacterRef | null> {
  const url = await findWikiImage(query);
  if (!url) return null;
  const res = await fetch(url, { headers: { "User-Agent": WIKI_UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2048) return null;
  return registerCharacterRef(opts?.name ?? query, buf, {
    mode: opts?.mode ?? "style",
    source: "web",
  });
}

async function findWikiImage(query: string): Promise<string | null> {
  // 1. Wikipedia lead image for the exact title (people / works).
  try {
    const api =
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(query)}` +
      `&prop=pageimages&piprop=thumbnail&pithumbsize=512&format=json&redirects=1`;
    const j = (await (await fetch(api, { headers: { "User-Agent": WIKI_UA }, signal: AbortSignal.timeout(20_000) })).json()) as {
      query?: { pages?: Record<string, { thumbnail?: { source?: string } }> };
    };
    for (const p of Object.values(j?.query?.pages ?? {})) {
      if (p?.thumbnail?.source) return p.thumbnail.source;
    }
  } catch {
    /* fall through to Commons search */
  }
  // 2. Commons file search (anime/manhua official art).
  try {
    const search =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
      `&srnamespace=6&srlimit=10&format=json`;
    const j = (await (await fetch(search, { headers: { "User-Agent": WIKI_UA }, signal: AbortSignal.timeout(20_000) })).json()) as {
      query?: { search?: { title?: string }[] };
    };
    // Raster image extensions only — Commons search often surfaces PDF/SVG/TIFF
    // scans (e.g. library digitizations) that are useless as IPAdapter refs.
    const RASTER_EXT = /\.(jpe?g|png|webp)$/i;
    for (const hit of j?.query?.search ?? []) {
      const title = hit.title;
      if (!title?.startsWith("File:")) continue;
      if (!RASTER_EXT.test(title)) continue;
      if (/cosplay/i.test(title)) continue;
      const info =
        `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}` +
        `&prop=imageinfo&iiprop=url|size&iiurlwidth=512&format=json`;
      const j2 = (await (await fetch(info, { headers: { "User-Agent": WIKI_UA }, signal: AbortSignal.timeout(20_000) })).json()) as {
        query?: { pages?: Record<string, { imageinfo?: { thumburl?: string; url?: string }[] }> };
      };
      for (const p of Object.values(j2?.query?.pages ?? {})) {
        const thumb = p?.imageinfo?.[0]?.thumburl;
        const full = p?.imageinfo?.[0]?.url;
        if (thumb) return thumb;
        if (full) return full;
      }
    }
  } catch {
    /* give up */
  }
  return null;
}

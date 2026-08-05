import { Client } from "@dvxch/yandex-music";

let _client: Client | null = null;

function getClient(): Client {
  const token = process.env.YM_TOKEN;
  if (!token) throw new Error("YM_TOKEN не задан в .env.local");
  if (!_client) _client = new Client({ token });
  return _client;
}

export interface YmTrack {
  id: number | string;
  albumId?: number | string;
  title: string;
  artist: string;
  durationMs: number;
}

/** Cyrillic→Latin transliteration for artist names stored in Latin (Макавелли→Makavelli). */
function transliterateRusLat(s: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return s
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}

export async function searchYandexMusic(query: string): Promise<YmTrack | null> {
  const client = getClient();
  const queries = [query, transliterateRusLat(query), query.replace(/\s+/g, " ").split(" ").slice(0, 2).join(" ")];

  for (const q of [...new Set(queries)]) {
    const result = await client.search(q, false, "track");
    const tracks = (result as any)?.tracks?.results;
    if (!Array.isArray(tracks) || tracks.length === 0) continue;
    const t = tracks[0];
    return {
      id: t.id,
      albumId: t.albums?.[0]?.id,
      title: t.title ?? "Unknown",
      artist: t.artists?.[0]?.name ?? "Unknown",
      durationMs: t.durationMs ?? 0,
    };
  }
  return null;
}

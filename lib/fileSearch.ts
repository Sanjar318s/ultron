/**
 * File search with multilingual matching (ru↔en). Searches common user
 * directories for images/files matching a query. Falls back to Google Images.
 * LOCALHOST-only — runs PowerShell Get-ChildItem on the host.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

export interface FileMatch {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  modified: string;
}

/** Common RU↔EN translation pairs for image/file search. */
const TRANSLATIONS: Record<string, string[]> = {
  "кот": ["cat"], "котик": ["cat"], "кота": ["cat"], "коту": ["cat"],
  "собака": ["dog"], "собаку": ["dog"], "пёс": ["dog"], "щенок": ["puppy"],
  "машина": ["car", "auto", "automobile"], "машину": ["car"], "авто": ["car", "auto"],
  "дом": ["house", "home"], "дома": ["house", "home"], "квартира": ["apartment"],
  "дракон": ["dragon"], "дракона": ["dragon"],
  "рыба": ["fish"], "рыбка": ["fish"],
  "птица": ["bird"], "птичка": ["bird"],
  "цветок": ["flower"], "цветы": ["flowers", "flower"],
  "дерево": ["tree"], "деревья": ["trees"],
  "гора": ["mountain"], "горы": ["mountains"],
  "река": ["river"], "море": ["sea", "ocean"], "океан": ["ocean"],
  "небо": ["sky"], "звезда": ["star"], "звёзды": ["stars"],
  "луна": ["moon"], "солнце": ["sun"],
  "город": ["city"], "здание": ["building"], "мост": ["bridge"],
  "еда": ["food"], "обед": ["lunch"], "ужин": ["dinner"], "завтрак": ["breakfast"],
  "компьютер": ["computer", "pc"], "телефон": ["phone"], "ноутбук": ["laptop"],
  "скриншот": ["screenshot"], "снимок": ["screenshot"],
  "обои": ["wallpaper", "background"],
  "фото": ["photo"], "фотки": ["photos"], "фотография": ["photo"],
  "портрет": ["portrait"], "пейзаж": ["landscape"],
  "аниме": ["anime"], "манга": ["manga"], "маньхуа": ["manhua"],
  "игра": ["game"], "игры": ["games"], "геймплей": ["gameplay"],
  "мем": ["meme"], "мемы": ["memes"],
  "логотип": ["logo"], "аватар": ["avatar"],
  "текст": ["text"], "документ": ["document"], "файл": ["file"],
  "видео": ["video"], "ролик": ["video"],
  "музыка": ["music"], "песня": ["song"],
  "карта": ["map", "card"], "локация": ["location"],
  "погода": ["weather"], "шторм": ["storm"],
  "персонаж": ["character"], "герой": ["hero"],
  "меч": ["sword"], "оружие": ["weapon"],
  "космос": ["space"], "галактика": ["galaxy"],
  "лес": ["forest"], "пустыня": ["desert"], "пляж": ["beach"],
  "ночь": ["night"], "рассвет": ["sunrise"], "закат": ["sunset"],
  "смешной": ["funny"], "красивый": ["beautiful", "pretty"],
  " большой": ["big", "large"], "маленький": ["small", "tiny"],
};

/** Expand a query into search candidates: original + transliterations + translations. */
export function expandQuery(query: string): string[] {
  const q = query.toLowerCase().trim();
  const candidates = new Set<string>([q]);

  // Add translation pairs
  for (const [ru, ens] of Object.entries(TRANSLATIONS)) {
    if (q.includes(ru)) {
      for (const en of ens) candidates.add(en);
    }
  }

  // Simple transliteration (ru→en)
  const translitMap: Record<string, string> = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  };
  const translit = q.replace(/[а-яё]/gi, (ch) => {
    const low = ch.toLowerCase();
    const tr = translitMap[low] ?? low;
    return ch === low ? tr : tr.toUpperCase();
  });
  if (translit !== q) candidates.add(translit);

  return [...candidates];
}

/** Search directories — default locations for user files. */
const SEARCH_DIRS = [
  path.join(os.homedir(), "Pictures"),
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
];

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff"]);

/** Search for files matching the query in common directories. */
export async function searchFiles(query: string, dirs?: string[]): Promise<FileMatch[]> {
  const targets = dirs ?? SEARCH_DIRS;
  const candidates = expandQuery(query);

  // Build PowerShell glob patterns from candidates
  const patterns = candidates.flatMap((c) => [
    `${c}*`,
    `*${c}*`,
    `${c}.jpg`,
    `${c}.png`,
    `${c}.jpeg`,
    `${c}.webp`,
  ]);

  const dirFilter = targets.map((d) => `'${d.replace(/'/g, "''")}'`).join(",");

  // PowerShell: search recursively for matching files
  const ps = `
$ProgressPreference='SilentlyContinue'
$results = @()
$dirs = @(${dirFilter})
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  try {
    $items = Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $n = $_.Name.ToLower()
        $n -match (${patterns.map((p) => `'${p.replace(/'/g, "''")}'`).join(" -or $n -like ")})
      } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 20 Name, FullName, Length, LastWriteTime
    foreach ($item in $items) {
      $results += "$($item.Name)|$($item.FullName)|$($item.Length)|$($item.LastWriteTime)"
    }
  } catch {}
}
if ($results.Count -gt 0) { $results | ForEach-Object { Write-Output $_ } }
`.trim();

  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const out = await new Promise<string>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    let data = "";
    child.stdout.on("data", (d: Buffer) => (data += d.toString()));
    child.on("close", () => resolve(data.trim()));
    child.on("error", () => resolve(""));
    setTimeout(() => { child.kill(); resolve(""); }, 15_000);
  });

  if (!out) return [];

  return out.split("\n").filter(Boolean).map((line) => {
    const [name, filePath, sizeStr, modified] = line.split("|");
    return {
      name: name ?? "",
      path: filePath ?? "",
      size: Number(sizeStr) || 0,
      isDir: false,
      modified: modified ?? "",
    };
  }).filter((m) => m.name && m.path);
}

/** Open a file with the default Windows handler. */
export async function openFile(filePath: string): Promise<boolean> {
  const safe = filePath.replace(/'/g, "''");
  const ps = `Start-Process -FilePath '${safe}' -ErrorAction SilentlyContinue`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
    setTimeout(() => { child.kill(); resolve(false); }, 10_000);
  });
}

/** Open a folder in Windows Explorer. */
export async function openFolder(folderPath: string): Promise<boolean> {
  const safe = folderPath.replace(/'/g, "''");
  const ps = `Start-Process explorer.exe -ArgumentList '${safe}' -ErrorAction SilentlyContinue`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
    setTimeout(() => { child.kill(); resolve(false); }, 10_000);
  });
}

/** Build a Google Images search URL for a query. */
export function googleImagesUrl(query: string): string {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
}

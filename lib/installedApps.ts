import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scans the installed Windows apps (Start Menu shortcuts + registry App Paths)
 * so the voice assistant can launch anything the user has, not just a fixed
 * allowlist. The scan runs in a short PowerShell script that writes JSON to a
 * temp file (UTF-8) — reading the file avoids console encoding mangling.
 */

export interface InstalledApp {
  name: string;
  path: string;
  kind: "shortcut" | "apppath";
}

const CACHE_TTL = 5 * 60 * 1000;
let appsCache: { at: number; apps: InstalledApp[] } | null = null;

/** Lowercase, ё→е, punctuation stripped, whitespace collapsed (for matching). */
export function normForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RU_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Filler words stripped from the spoken name before matching. */
const STOP_WORDS = new Set([
  "приложение", "приложуха", "программу", "программа", "программы", "игру", "игра",
  "игрушку", "пожалуйста", "пж", "будь", "добр", "добрым", "мне", "меня", "сейчас",
  "быстро", "уже", "тогда", "ну", "давай", "от", "запусти", "запустить", "запустите",
  "открой", "открыть", "откройте", "включи", "включить", "включите", "хочу", "надо",
  "нужно", "можешь", "дай", "давайка", "такое", "твое", "своё",
]);

/** Rough ru→en transliteration so «стим» can be compared with «Steam». */
function toLatin(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .split("")
    .map((c) => RU_TO_LATIN[c] ?? c)
    .join("");
}

const LATIN_TO_CYR: Record<string, string> = {
  a: "а", b: "б", c: "с", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и",
  j: "ж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р",
  s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", y: "й", z: "з",
};

/** Rough en→ru transliteration of an app name, for edit-distance matching. */
function toCyrillic(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .split("")
    .map((c) => LATIN_TO_CYR[c] ?? c)
    .join("");
}

/** Soft en→ru variant where c→к and x→к (so «код» matches "code", «клауд» Claude). */
function toCyrillicSoft(raw: string): string {
  const soft: Record<string, string> = { ...LATIN_TO_CYR, c: "к", x: "к" };
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .split("")
    .map((ch) => soft[ch] ?? ch)
    .join("");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Match a spoken name against an app's display name. Compares the original and
 * transliterated forms in both directions (ru→en for «стим»≈Steam, en→ru for
 * «вижуал студио»≈Visual Studio). Returns a score ≥ 45 to count as a match.
 */
export function matchAppScore(query: string, appName: string): number {
  const q = normForMatch(query)
    .split(" ")
    .filter((t) => !STOP_WORDS.has(t))
    .join(" ");
  const n = normForMatch(appName);
  if (!q || !n) return 0;

  const qVars = new Set([q, toLatin(q)]);
  const nVars = new Set([n, toLatin(n), toCyrillic(n), toCyrillicSoft(n)]);
  let best = 0;

  for (const qv of qVars) {
    for (const nv of nVars) {
      if (qv === nv) return 100;
      const lenDiff = Math.abs(qv.length - nv.length);
      if (qv.length >= 3 && lenDiff <= 5 && (nv.includes(qv) || qv.includes(nv))) {
        best = Math.max(best, Math.max(45, 80 - lenDiff * 2));
      }
      const qt = qv.split(" ").filter((t) => t.length >= 2);
      const words = nv.split(" ").filter((w) => w.length >= 2);
      // Strong: identical/prefix/substring («хром»⊂«кхроме», «студио»=studio).
      // Weak: fuzzy edit-distance («гугл»≈«гуи») — counts less so a real
      // substring hit like «хром»→Chrome outranks a coincidental one.
      const tokenStrength = (t: string, w: string): number => {
        if (w === t || w.startsWith(t)) return 1;
        if (t.length >= 3 && (w.includes(t) || t.includes(w))) return 1;
        if (t.length >= 3 && Math.abs(t.length - w.length) <= 2 && levenshtein(t, w) <= 2) return 0.5;
        return 0;
      };
      if (qt.length > 0 && words.length > 0) {
        let strength = 0;
        let matched = 0;
        for (const t of qt) {
          const s = words.reduce((m, w) => Math.max(m, tokenStrength(t, w)), 0);
          if (s > 0) {
            matched += 1;
            strength += s;
          }
        }
        if (matched > 0) {
          const ratio = strength / qt.length;
          best = Math.max(
            best,
            Math.max(45, 55 + Math.round(ratio * 25) - (qt.length - matched) * 6 - Math.min(lenDiff, 4)),
          );
        }
      }
      const dist = levenshtein(qv, nv);
      const near = dist <= 1 || (dist <= 2 && commonPrefixLen(qv, nv) >= 2);
      if (qv.length >= 3 && nv.length >= 3 && lenDiff <= 3 && near) {
        best = Math.max(best, Math.max(45, 60 - dist * 5));
      }
      if (best >= 100) return best;
    }
  }
  return best;
}

/**
 * Best installed-app match for a spoken name, or null.
 *
 * The default threshold is deliberately high (65): only confident matches are
 * auto-launched. Anything weaker (single fuzzy token, short-name coincidences)
 * is treated as «unknown» and handed to the LLM resolver in the client, which
 * maps the spoken name onto the installed list much more reliably than edit
 * distance ever could (e.g. «майнкрафт» → Minecraft, «эпик геймс» → Epic Games
 * Launcher).
 */
export function findBestApp(query: string, apps: InstalledApp[], minScore = 65): InstalledApp | null {
  const q = normForMatch(query);
  if (!q) return null;
  let best: InstalledApp | null = null;
  let bestScore = minScore;
  for (const app of apps) {
    const score = matchAppScore(q, app.name);
    // Ties go to the shorter name: «вижуал студио» → Visual Studio Code, not
    // the longer Visual Studio Installer.
    if (score > bestScore || (score === bestScore && best && app.name.length < best.name.length)) {
      bestScore = score;
      best = app;
    }
  }
  return best;
}

/** Skip uninstallers/helpers/clutter that can't be meaningfully launched. */
export function isReasonableApp(name: string): boolean {
  const n = name.toLowerCase();
  if (!n || n.length > 60) return false;
  if (/uninstall|деинсталл|удал|поддержк|справк|регистрац|обновлен|readme|о программе|лицензи|конфигурац/i.test(n)) return false;
  return true;
}

export function dedupeApps(apps: InstalledApp[]): InstalledApp[] {
  const seen = new Set<string>();
  const out: InstalledApp[] = [];
  for (const a of apps) {
    const key = normForMatch(a.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export async function scanInstalledApps(force = false): Promise<InstalledApp[]> {
  if (!force && appsCache && Date.now() - appsCache.at < CACHE_TTL) return appsCache.apps;

  const script = join(process.cwd(), "scripts", "scan-apps.ps1");
  const dir = await mkdtemp(join(tmpdir(), "ultron-apps-"));
  const outFile = join(dir, "apps.json");

  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-OutFile", outFile],
        { stdio: "ignore", windowsHide: true },
      );
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`apps scan exited ${code}`))));
    });

    const raw = await readFile(outFile, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as { apps?: unknown };
    const apps: InstalledApp[] = Array.isArray(parsed.apps)
      ? (parsed.apps as InstalledApp[]).filter(
          (a) => a && typeof a.name === "string" && typeof a.path === "string",
        )
      : [];
    appsCache = { at: Date.now(), apps };
    return apps;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

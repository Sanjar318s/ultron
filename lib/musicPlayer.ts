import { sendKeys } from "@/lib/desktopInput";
import { focusWindowByTitle, getWindowTitle, launchAndFocus, openViaShell } from "@/lib/launcher";
import { dedupeApps, findBestApp, isReasonableApp, scanInstalledApps } from "@/lib/installedApps";
import { searchYandexMusic } from "@/lib/yandexMusicApi";

/**
 * In-app Yandex Music search & playback (LOCALHOST-only).
 *
 * Flow: API search → launch app → retry deep link to the track page until the
 * window title shows it navigated (works on cold start — dropped sends are
 * simply retried) → focus → Space to start playback → Gemini screenshot
 * verification (retry Space until playing).
 */

export interface MusicPlayResult {
  reply: string;
  used: "app" | "web";
}

const searchUrl = (query: string) =>
  `https://music.yandex.ru/search?text=${encodeURIComponent(query)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const APP_PROC = "Яндекс Музыка";
const HOME_MARKERS = ["собираем музыку", "собираемся", "загрузка", "музыка для вас"];

/** Home/splash titles that mean the app is NOT yet on a track page. */
function isHomeTitle(title: string): boolean {
  return HOME_MARKERS.some((m) => title.toLowerCase().includes(m));
}

async function findMusicApp(): Promise<{ path: string; name: string } | null> {
  const apps = dedupeApps(
    (await scanInstalledApps()).filter((a) => typeof a.name === "string" && isReasonableApp(a.name)),
  );
  const best = findBestApp("яндекс музыка", apps);
  return best ? { path: best.path, name: best.name } : null;
}

function webFallback(query: string, why: string | null): MusicPlayResult {
  openViaShell(searchUrl(query));
  const reason = why ? ` не смог работать с приложением (${why})` : " приложение не установлено";
  return { used: "web", reply: `${reason[0].toUpperCase()}${reason.slice(1)} — открываю поиск в браузере.` };
}

/** Poll until the window shows a track/album page (title contains «слушать/онлайн»). */
async function waitForTrackPage(timeoutMs = 4_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await getWindowTitle(APP_PROC).catch(() => "");
    if (title && !isHomeTitle(title) && /слуша|онлайн/i.test(title)) {
      return title;
    }
    await sleep(400);
  }
  return null;
}

/**
 * Send the deep link repeatedly until the app navigates to the track page.
 * We never guess "when the app is ready" — we detect SUCCESS (title = track
 * page). On a cold start the handler may not be registered yet, so the first
 * sends are dropped; each retry lands on the now-warm app. One of them wins.
 */
async function sendDeepLinkUntilNavigated(deepLink: string): Promise<string | null> {
  for (let attempt = 0; attempt < 14; attempt++) {
    console.log(`[music] deep link (${attempt + 1}/14): ${deepLink}`);
    openViaShell(deepLink);
    const title = await waitForTrackPage();
    if (title) return title;
    await sleep(500);
  }
  return null;
}

/** Ask Gemini whether the screenshot shows a playback indicator (pause / progress). */
async function verifyPlayback(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/screenshot`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const shot = (await res.json().catch(() => null)) as { b64?: string } | null;
    if (!shot?.b64) return false;

    const checkRes = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gemini",
        temperature: 0,
        maxTokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Ты видишь скриншот приложения Яндекс Музыка. Играет ли сейчас музыка? Ответь СТРОГО одним словом: ДА если видишь кнопку паузы/стоп, движущийся прогресс-бар, индикатор воспроизведения, обложку с анимацией звука — или НЕТ если этого нет.",
              },
              { type: "image", mimeType: "image/jpeg", data: shot.b64 },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!checkRes.ok) return false;
    const check = (await checkRes.json().catch(() => null)) as { content?: string } | null;
    return /да/i.test(check?.content ?? "");
  } catch {
    return false;
  }
}

export async function playInYandexMusic(query: string, baseUrl: string): Promise<MusicPlayResult> {
  // 1. Search via API
  let track;
  try {
    track = await searchYandexMusic(query);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return webFallback(query, `ошибка API: ${why.slice(0, 100)}`);
  }
  if (!track) return webFallback(query, "трек не найден");

  // 2. Launch / bring app to front
  const app = await findMusicApp();
  if (!app) return webFallback(query, null);

  const launched = await launchAndFocus(app.path, app.name);
  if (!launched) return webFallback(query, "окно приложения не появилось");

  // 3. Deep link → track page. album+track format is the one that navigates.
  //    Retry until the window actually lands on the track page (works on cold
  //    start too: the first sends are dropped, later ones hit the warm app).
  const deepLink = track.albumId
    ? `yandexmusic://album/${track.albumId}/track/${track.id}`
    : `yandexmusic://track/${track.id}`;

  const navigated = await sendDeepLinkUntilNavigated(deepLink);
  if (!navigated) return webFallback(query, "приложение не перешло на трек");
  console.log(`[music] navigated → «${navigated}»`);

  // 4. Focus the app window (title is now the track name, not «Яндекс Музыка»).
  await focusWindowByTitle("", APP_PROC);
  await sleep(800);

  // 5. Space to start playback; verify with Gemini, retry a few times.
  let playing = false;
  for (let attempt = 0; attempt < 3 && !playing; attempt++) {
    await sendKeys(" ");
    await sleep(1800);
    playing = await verifyPlayback(baseUrl);
    console.log(`[music] playback check ${attempt + 1}: ${playing ? "OK" : "no"}`);
  }

  if (!playing) {
    return webFallback(query, "не удалось начать воспроизведение");
  }

  return { used: "app", reply: `Играет: ${track.artist} — ${track.title}` };
}

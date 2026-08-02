import { NextRequest, NextResponse } from "next/server";

/**
 * Weather lookup for the voice assistant, backed by Open-Meteo — free,
 * keyless, no registration. City → coordinates via Open-Meteo's geocoding
 * API, then current conditions via its forecast API. Returns a normalized
 * Russian-friendly payload the assistant can read out loud.
 */

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** WMO weather codes → short Russian description. */
function describeWeatherCode(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? "ясно" : "ясно, безоблачно";
  if (code <= 2) return "переменная облачность";
  if (code === 3) return "облачно";
  if (code === 45 || code === 48) return "туман";
  if (code >= 51 && code <= 57) return "мелкий дождь";
  if (code >= 61 && code <= 67) return "дождь";
  if (code >= 71 && code <= 77) return "снег";
  if (code >= 80 && code <= 82) return "ливень";
  if (code >= 85 && code <= 86) return "снегопад";
  if (code >= 95) return "гроза";
  return "переменная погода";
}

interface GeoResult {
  name: string;
  country_code: string;
  latitude: number;
  longitude: number;
}

/**
 * City names arrive inflected («в Ташкенте», «в Москве», «по Минску»).
 * Open-Meteo matches prefixes only, so try the raw word first and then
 * common Russian declension stems until one resolves.
 */
function cityCandidates(city: string): string[] {
  const c = city.trim();
  const out: string[] = [c];
  const push = (s: string) => {
    if (s && s.length >= 3 && !out.includes(s)) out.push(s);
  };
  push(c.replace(/е$/, "а")); // Москве → Москва, Уфе → Уфа
  push(c.replace(/е$/, "")); // Ташкенте → Ташкент, Минске → Минск
  push(c.replace(/у$/, "")); // Минску/Ташкенту → …
  push(c.replace(/у$/, "а")); // …
  push(c.replace(/и$/, "")); // …
  push(c.replace(/ой$/, "а")); // Ригой → Рига
  push(c.replace(/ом$/, "")); // …
  return out;
}

async function findPlace(city: string): Promise<GeoResult | null> {
  for (const name of cityCandidates(city)) {
    const geoRes = await fetch(
      `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&language=ru&format=json`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!geoRes.ok) continue;
    const geo = (await geoRes.json()) as { results?: GeoResult[] };
    const place = geo.results?.[0];
    if (place) return place;
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const city = req.nextUrl.searchParams.get("city")?.trim().slice(0, 80);
  if (!city) {
    return NextResponse.json({ error: "missing city" }, { status: 400 });
  }

  try {
    const place = await findPlace(city);
    if (!place) {
      return NextResponse.json({ error: "city not found" }, { status: 404 });
    }

    const fcRes = await fetch(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&timezone=auto&forecast_days=1`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!fcRes.ok) throw new Error(`forecast ${fcRes.status}`);
    const fc = (await fcRes.json()) as {
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        is_day?: number;
        precipitation?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
    };
    const cur = fc.current ?? {};
    const temp = Math.round(cur.temperature_2m ?? 0);

    return NextResponse.json({
      city: place.name,
      country: place.country_code,
      temp,
      feelsLike: Math.round(cur.apparent_temperature ?? temp),
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      windKmh: Math.round(cur.wind_speed_10m ?? 0),
      precipMm: cur.precipitation ?? 0,
      isDay: Boolean(cur.is_day),
      condition: describeWeatherCode(cur.weather_code ?? 0, Boolean(cur.is_day)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

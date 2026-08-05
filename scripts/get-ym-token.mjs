#!/usr/bin/env node
/**
 * Device-flow OAuth for Yandex Music API.
 * Usage: node scripts/get-ym-token.mjs
 */

import { Client } from "@dvxch/yandex-music";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { exec } from "node:child_process";

const ENV_PATH = new URL("../.env.local", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const client = new Client();

console.log("🔑 Device-flow авторизация Яндекс Музыки...\n");

try {
  const token = await client.deviceAuth(async (dc) => {
    console.log("═══════════════════════════════════════════");
    console.log("  1. Откройте эту ссылку:");
    console.log(`     ${dc.verificationUrl}`);
    console.log(`\n  2. Введите код: ${dc.userCode}`);
    console.log("═══════════════════════════════════════════\n");
    try {
      const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
      exec(`${cmd} "${dc.verificationUrl}"`);
    } catch {}
    console.log("⏳ Ожидаю авторизацию (до 3 минут)...");
  }, { timeout: 180 });

  const accessToken = token.accessToken;
  console.log(`\n✅ Токен получен: ${accessToken.slice(0, 12)}...${accessToken.slice(-4)}`);

  const envLine = `YM_TOKEN=${accessToken}`;
  if (existsSync(ENV_PATH)) {
    const existing = readFileSync(ENV_PATH, "utf8");
    if (existing.includes("YM_TOKEN=")) {
      writeFileSync(ENV_PATH, existing.replace(/YM_TOKEN=.*/, envLine), "utf8");
    } else {
      writeFileSync(ENV_PATH, existing.trimEnd() + "\n" + envLine + "\n", "utf8");
    }
  } else {
    writeFileSync(ENV_PATH, envLine + "\n", "utf8");
  }
  console.log(`📝 YM_TOKEN сохранён в ${ENV_PATH}`);
  console.log("🔄 Перезапустите npm run dev для применения.");
} catch (err) {
  console.error(`\n❌ Ошибка: ${err.message}`);
  process.exit(1);
}

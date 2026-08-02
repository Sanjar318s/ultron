import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [url, dest, partsArg] = process.argv.slice(2);
const parts = parseInt(partsArg || '12', 10);
const partsDir = dest + '.parts';
const sizeOf = (n) => `${(n / (1024 * 1024 * 1024)).toFixed(2)}GiB`;

function headSize(url) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', ['-sIL', url], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => {
      const range = out.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
      if (range) return resolve(parseInt(range[1], 10));
      const lens = [...out.matchAll(/content-length:\s*(\d+)/gi)].map((m) => parseInt(m[1], 10));
      if (lens.length) return resolve(Math.max(...lens));
      reject(new Error('no content-length/content-range'));
    });
  });
}

function curlRange(start, end, file) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', [
      '-sL', '--fail', '--retry', '10', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '20', '--max-time', '900',
      '-r', `${start}-${end}`, '-o', file, url,
    ], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`curl ${path.basename(file)} code=${code} ${err.slice(0, 150)}`))
    );
  });
}

const total = await headSize(url);
console.log(`total=${total} (${sizeOf(total)}), parts=${parts}`);
await fs.mkdir(partsDir, { recursive: true });
const chunk = Math.ceil(total / parts);
const jobs = [];
for (let i = 0; i < parts; i++) {
  const start = i * chunk;
  const end = i === parts - 1 ? total - 1 : (i + 1) * chunk - 1;
  jobs.push({ start, end, file: path.join(partsDir, `part${String(i).padStart(2, '0')}`) });
}
const allJobs = jobs.slice();

let done = 0;
const startTime = Date.now();
async function worker() {
  while (jobs.length) {
    const j = jobs.shift();
    for (let attempt = 1; ; attempt++) {
      try {
        const st = await fs.stat(j.file).catch(() => null);
        const want = j.end - j.start + 1;
        if (st && st.size === want) break;
        await curlRange(j.start, j.end, j.file);
        break;
      } catch (e) {
        const st = await fs.stat(j.file).catch(() => null);
        const got = st ? st.size : 0;
        console.log(`retry[${attempt}] ${path.basename(j.file)} ${sizeOf(got)}`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    done++;
    const spd = (done * chunk) / (Date.now() - startTime);
    console.log(`done ${done}/${parts} ~${(spd / 1048576).toFixed(1)}MB/s`);
  }
}

const concurrency = Math.min(parts, 4);
await Promise.all(Array.from({ length: concurrency }, worker));

console.log('concat...');
const out = await fs.open(dest, 'w');
const buf = Buffer.alloc(1 << 20);
for (const j of allJobs) {
  const fd = await fs.open(j.file, 'r');
  let off = 0;
  while (true) {
    const { bytesRead } = await fd.read(buf, 0, buf.length, off);
    if (!bytesRead) break;
    await out.write(buf.subarray(0, bytesRead));
    off += bytesRead;
  }
  await fd.close();
  await fs.unlink(j.file);
}
await out.close();
await fs.rmdir(partsDir).catch(() => {});
console.log(`DONE ${dest} ${sizeOf((await fs.stat(dest)).size)}`);

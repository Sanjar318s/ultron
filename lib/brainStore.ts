import { promises as fs } from "node:fs";
import path from "node:path";
import { AssistantBrain, type BrainIdSet, type BrainSnapshot, snapshotIds } from "@/lib/assistantBrain";

/**
 * Durable brain storage (data/brain.json) with a lossless sync protocol.
 *
 * data/brain.json is the single source of truth shared by both brains — the
 * browser (main brain) and the Telegram bot. Every write funnels through here:
 *   - a per-process promise-queue (mutex) serializes writers, so two concurrent
 *     requests can never corrupt the file or lose each other's update;
 *   - commitBrain merges in only the items the writer has never seen (relative
 *     to the base id-set it last observed), which keeps concurrent learning
 *     lossless without resurrecting items the writer deliberately forgot.
 */

const BRAIN_FILE = path.join(process.cwd(), "data", "brain.json");
const MAX_BYTES = 5 * 1024 * 1024;

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Ids (or fact strings) recently deleted by one writer, with timestamps. A
 * stale writer that still holds such an item must not resurrect it, so commits
 * filter these out for a short TTL. In-memory only — ids are unique per
 * creation, so a legitimate re-learn is never blocked.
 */
const recentDeletes = new Map<string, number>();
const DELETE_TTL_MS = 120_000;

function markDeleted(baseIds: BrainIdSet, incoming: BrainSnapshot): void {
  const now = Date.now();
  for (const id of baseIds.rules) if (!incoming.rules.some((r) => r.id === id)) recentDeletes.set(`r:${id}`, now);
  for (const id of baseIds.notes) if (!incoming.notes.some((n) => n.id === id)) recentDeletes.set(`n:${id}`, now);
  for (const id of baseIds.skills) if (!incoming.skills.some((s) => s.id === id)) recentDeletes.set(`s:${id}`, now);
  for (const f of baseIds.facts) if (!incoming.facts.includes(f)) recentDeletes.set(`f:${f}`, now);
  for (const [k, ts] of recentDeletes) if (now - ts > DELETE_TTL_MS) recentDeletes.delete(k);
}

function filterRecentDeletes(snapshot: BrainSnapshot): BrainSnapshot {
  return {
    ...snapshot,
    rules: snapshot.rules.filter((r) => !recentDeletes.has(`r:${r.id}`)),
    facts: snapshot.facts.filter((f) => !recentDeletes.has(`f:${f}`)),
    skills: snapshot.skills.filter((s) => !recentDeletes.has(`s:${s.id}`)),
    notes: snapshot.notes.filter((n) => !recentDeletes.has(`n:${n.id}`)),
  };
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readSnapshot(): Promise<BrainSnapshot | null> {
  try {
    const raw = await fs.readFile(BRAIN_FILE, "utf-8");
    const parsed = JSON.parse(raw) as BrainSnapshot;
    if (parsed && parsed.version === 1) return parsed;
  } catch {
    // No file / corrupt — treat as empty.
  }
  return null;
}

/** Latest brain state from disk (no writes, no merges). */
export async function loadBrain(): Promise<AssistantBrain> {
  const brain = new AssistantBrain();
  const snapshot = await readSnapshot();
  if (snapshot) brain.hydrate(snapshot);
  return brain;
}

/** Raw snapshot for /api/brain GET. */
export async function readBrainSnapshot(): Promise<BrainSnapshot | null> {
  return readSnapshot();
}

async function writeSnapshot(snapshot: BrainSnapshot): Promise<void> {
  const payload = JSON.stringify(snapshot);
  if (payload.length > MAX_BYTES) {
    throw new Error("brain snapshot too large");
  }
  await fs.mkdir(path.dirname(BRAIN_FILE), { recursive: true });
  await fs.writeFile(BRAIN_FILE, payload, "utf-8");
}

/**
 * Atomically persist `updated` (a writer's full intended state). Under the
 * mutex the current on-disk snapshot is re-read and every item the writer has
 * never seen (not in `base`) is merged in — so a browser pushing while the
 * Telegram bot learns (or vice versa) never loses either side's knowledge.
 * Items the writer saw in `base` but removed from `updated` stay removed.
 *
 * When `base` is null (unknown/legacy writer) every on-disk item the writer
 * doesn't already have is merged in — the conservative union.
 */
export async function commitBrain(updated: AssistantBrain, base: BrainIdSet | null): Promise<void> {
  await enqueue(async () => {
    const disk = await readSnapshot();
    if (!disk) {
      await writeSnapshot(updated.snapshot());
      return;
    }
    const incoming = updated.snapshot();
    const baseIds = base ?? snapshotIds(incoming);
    // Items this writer removed (present in its base, absent now) → tombstone
    // them so a stale OTHER writer can't resurrect them within the TTL.
    markDeleted(baseIds, incoming);
    const merged = new AssistantBrain();
    merged.hydrate(filterRecentDeletes(incoming));

    // Only knowledge that landed on disk after the writer last observed it.
    const delta: BrainSnapshot = {
      version: 1,
      stats: { interactions: 0, learnedTotal: 0, forgotten: 0 },
      rules: disk.rules.filter((r) => !baseIds.rules.includes(r.id)),
      facts: disk.facts.filter((f) => !baseIds.facts.includes(f)),
      pcControl: disk.pcControl,
      skills: disk.skills.filter((s) => !baseIds.skills.includes(s.id)),
      notes: disk.notes.filter((n) => !baseIds.notes.includes(n.id)),
      abilities: disk.abilities,
      abilityAnalyzedAt: disk.abilityAnalyzedAt,
      abilityHash: disk.abilityHash,
    };
    merged.mergeFrom(delta);
    // mergeFrom ORs pcControl in already (delta.pcControl = disk.pcControl).
    // Keep the freshest ability analysis of the two.
    if (disk.abilityAnalyzedAt && (incoming.abilityAnalyzedAt ?? 0) < disk.abilityAnalyzedAt) {
      merged.hydrate({
        ...merged.snapshot(),
        abilities: disk.abilities,
        abilityAnalyzedAt: disk.abilityAnalyzedAt,
        abilityHash: disk.abilityHash,
      });
    }
    await writeSnapshot(merged.snapshot());
  });
}

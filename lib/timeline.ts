/**
 * Per-request phase timeline. Records where time actually goes (key resolve,
 * provider latency, executor rounds, parse, actions) so latency claims are
 * measured, not guessed. Each request gets a Timeline instance; marks land in
 * a module-level ring buffer exposed via /api/timeline and are also printed
 * to the server log as `[timeline] …`.
 */

export interface TimelineMark {
  name: string;
  /** ms since the timeline started. */
  ms: number;
  /** ms since the previous mark. */
  elapsed: number;
}

export interface TimelineEntry {
  id: number;
  label: string;
  startedAt: string;
  marks: TimelineMark[];
  /** Optional per-request context (chatId, preset, winner provider…). */
  extra?: Record<string, unknown>;
}

const RECENT: TimelineEntry[] = [];
const RECENT_CAP = 50;
let nextId = 1;

export class Timeline {
  private readonly start = Date.now();
  private last = Date.now();
  private readonly marks: TimelineMark[] = [];
  private finished = false;

  constructor(
    private readonly label: string,
    private readonly extra?: Record<string, unknown>,
  ) {}

  mark(name: string): void {
    const now = Date.now();
    this.marks.push({ name, ms: now - this.start, elapsed: now - this.last });
    this.last = now;
  }

  /** Finalize + store + log. Safe to call once; later calls are no-ops. */
  finish(extraPatch?: Record<string, unknown>): TimelineEntry | null {
    if (this.finished) return null;
    this.finished = true;
    this.mark("total");
    const entry: TimelineEntry = {
      id: nextId++,
      label: this.label,
      startedAt: new Date(this.start).toISOString(),
      marks: this.marks,
      extra: { ...(this.extra ?? {}), ...(extraPatch ?? {}) },
    };
    RECENT.push(entry);
    if (RECENT.length > RECENT_CAP) RECENT.shift();
    console.log(`[timeline] ${entry.label}: ${formatTimeline(entry)}`);
    return entry;
  }
}

/** «phase 12ms (after prev 4ms) / phase2 …» — compact one-line view. */
export function formatTimeline(entry: TimelineEntry): string {
  return entry.marks
    .map((m) => `${m.name}=${m.ms}ms`)
    .join(" ");
}

export function getRecentTimelines(limit = 20): TimelineEntry[] {
  return RECENT.slice(-limit);
}

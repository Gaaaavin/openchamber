/**
 * FORK-ONLY FILE - not present upstream, so it never conflicts on rebase.
 *
 * Ported from the `opencode-tps` TUI plugin (MIT, github.com/williamcr01/opencode-tps) and
 * JDScript/opencode's web UI port. The window sizes and format thresholds stay identical.
 */

export type TpsSample = {
  /** Estimated tokens that arrived in the interval ending at `at`. */
  tokens: number;
  at: number;
};

export const WINDOW_MS = 5_000;
export const STALE_MS = 1_500;
const MIN_DURATION_MS = 250;
const MAX_TAIL_MS = 1_000;

const encoder = new TextEncoder();

/**
 * UTF-8 bytes over five - the plugin's heuristic, and an estimate rather than a count.
 * Streaming deltas carry text; exact token counts arrive too late for a live meter.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 5);
}

export function currentBurst(samples: readonly TpsSample[], now: number): TpsSample[] {
  const cutoff = now - WINDOW_MS;
  const burst: TpsSample[] = [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample.at < cutoff) break;
    const newer = burst[0];
    if (newer && newer.at - sample.at > STALE_MS) break;
    burst.unshift(sample);
  }
  return burst;
}

export function tokensPerSecond(samples: readonly TpsSample[], now: number): number | undefined {
  const burst = currentBurst(samples, now);
  if (burst.length === 0) return undefined;

  const last = burst[burst.length - 1];
  if (now - last.at > STALE_MS) return undefined;

  const tokens = burst.reduce((sum, sample) => sum + sample.tokens, 0);
  let duration = 0;
  for (let index = 1; index < burst.length; index += 1) duration += burst[index].at - burst[index - 1].at;
  duration += Math.min(now - last.at, MAX_TAIL_MS);
  return (tokens / Math.max(duration, MIN_DURATION_MS)) * 1000;
}

export function formatTps(value: number | undefined, dash = '—'): string {
  if (value === undefined) return dash;
  if (value < 10) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return String(Math.round(value));
}

export function measureGrowth(
  parts: ReadonlyArray<{ id: string; text?: string }>,
  seen: ReadonlyMap<string, number>,
) {
  const next = new Map(seen);
  let tokens = 0;
  for (const part of parts) {
    const text = part.text ?? '';
    const watermark = next.get(part.id);
    if (watermark === undefined) {
      next.set(part.id, text.length);
      continue;
    }
    if (text.length <= watermark) continue;
    tokens += estimateTokens(text.slice(watermark));
    next.set(part.id, text.length);
  }
  return { tokens, seen: next };
}

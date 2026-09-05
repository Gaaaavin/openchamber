/**
 * FORK-ONLY FILE - not present upstream, so it never conflicts on rebase.
 *
 * Ported from the `opencode-tps` TUI plugin (MIT, github.com/williamcr01/opencode-tps) and
 * JDScript/opencode's web UI port. The display window is deliberately longer than the TUI
 * plugin's 5 seconds: the plugin redraws on every delta, while this readout updates once a
 * second, and a 5-second rectangular window with a 0-1 second tail made each tick jump by
 * up to ~20%. The other timing constants and format thresholds stay identical.
 */

export type TpsSample = {
  /** Estimated tokens that arrived in the interval ending at `at`. */
  tokens: number;
  at: number;
};

export const WINDOW_MS = 15_000;
export const STALE_MS = 1_500;
export const SMOOTHING_TAU_MS = 3_000;
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

/**
 * EMA with a real time constant: alpha = 1 - exp(-dt / tau), so an irregular tick cadence
 * does not change the smoothing. `raw === undefined` (burst ended) resets to undefined so
 * the dash appears at once and the next burst starts from its own first reading.
 */
export function smoothRate(
  previous: number | undefined,
  raw: number | undefined,
  dtMs: number,
  tauMs = SMOOTHING_TAU_MS,
): number | undefined {
  if (raw === undefined) return undefined;
  if (previous === undefined) return raw;
  const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / tauMs);
  return previous + (raw - previous) * alpha;
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

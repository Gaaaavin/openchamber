import { describe, expect, it } from 'vitest';
import { findQuietSplitOffset } from './audio.js';

const pcm = (...samples) => Buffer.from(Int16Array.from(samples).buffer);
const options = { windowBytes: 4, threshold: 300, minBytesBeforeSplit: 0 };

describe('findQuietSplitOffset', () => {
  it('returns the first full quiet window end', () => {
    expect(findQuietSplitOffset(pcm(8000, -8000, 0, 0, 0, 0), options)).toBe(8);
  });

  it('returns zero without a quiet window or with only a short quiet tail', () => {
    expect(findQuietSplitOffset(pcm(8000, -8000, 2000, -2000), options)).toBe(0);
    expect(findQuietSplitOffset(pcm(8000, -8000, 0), options)).toBe(0);
  });

  it('uses the prefix and prior segment peaks, not future loud samples', () => {
    expect(findQuietSplitOffset(pcm(8000, -8000, 500, -500), options)).toBe(8);
    expect(findQuietSplitOffset(pcm(500, -500, 8000, -8000), options)).toBe(0);
    expect(findQuietSplitOffset(pcm(500, -500), { ...options, referencePeak: 8000 })).toBe(4);
    expect(findQuietSplitOffset(pcm(800, -800), { ...options, referencePeak: 8000 })).toBe(0);
  });

  it('requires the window end to reach the minimum byte count', () => {
    const buffer = pcm(8000, -8000, 0, 0, 0, 0);
    expect(findQuietSplitOffset(buffer, { ...options, minBytesBeforeSplit: 9 })).toBe(12);
    expect(findQuietSplitOffset(buffer, { ...options, minBytesBeforeSplit: 13 })).toBe(0);
  });

  it('aligns odd window sizes to full PCM16 samples', () => {
    const buffer = pcm(8000, -8000, 0, 0);
    expect(findQuietSplitOffset(buffer, { ...options, windowBytes: 5 })).toBe(8);
    expect(findQuietSplitOffset(Buffer.concat([buffer, Buffer.alloc(1)]), options)).toBe(8);
  });

  it('rejects windows smaller than a sample', () => {
    expect(() => findQuietSplitOffset(pcm(0, 0), { ...options, windowBytes: 1 })).toThrow();
  });
});

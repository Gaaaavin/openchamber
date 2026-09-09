import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';

import { DictationStreamManager } from './stream-manager.js';

const FORMAT = 'audio/pcm;rate=16000;bits=16';

class FakeSttSession extends EventEmitter {
  constructor({ transcriptBySegment = () => 'hello world', segmentHints, deferCommits = false } = {}) {
    super();
    this.requiredSampleRate = 16000;
    this.segmentHints = segmentHints;
    this.deferCommits = deferCommits;
    this.operations = [];
    this.appended = [];
    this.commits = 0;
    this.clears = 0;
    this.closed = false;
    this.segmentCounter = 0;
    this.transcriptBySegment = transcriptBySegment;
  }

  async connect() {}

  appendPcm16(buf) {
    this.appended.push(buf);
    this.operations.push(['append', buf.length]);
  }

  commit() {
    this.operations.push(['commit']);
    this.commits += 1;
    const segmentId = `seg-${this.segmentCounter}`;
    this.segmentCounter += 1;
    if (this.deferCommits) return;
    this.emit('committed', { segmentId, previousSegmentId: null });
    setTimeout(() => {
      this.emit('transcript', {
        segmentId,
        transcript: this.transcriptBySegment(segmentId),
        isFinal: true,
      });
    }, 0);
  }

  clear() {
    this.operations.push(['clear']);
    this.clears += 1;
  }

  close() {
    this.closed = true;
  }
}

function loudChunkBase64(samples = 1600, amplitude = 8000) {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return Buffer.from(arr.buffer).toString('base64');
}

function silentChunkBase64(samples = 1600) {
  return Buffer.from(new Int16Array(samples).buffer).toString('base64');
}

function createManager(session) {
  const messages = [];
  const manager = new DictationStreamManager({
    emit: (msg) => messages.push(msg),
    createSttSession: async () => ({ session }),
  });
  return { manager, messages };
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve(undefined);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('DictationStreamManager', () => {
  it('transcribes ordered chunks and emits final text', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    expect(final.payload.text).toBe('hello world');
    expect(session.commits).toBe(1);
    expect(session.closed).toBe(true);

    const acks = messages.filter((m) => m.type === 'ack');
    expect(acks[acks.length - 1].payload.ackSeq).toBe(1);
  });

  it('reorders out-of-order chunks before appending', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
    expect(session.appended.length).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
    expect(session.appended.length).toBe(2);
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));
  });

  it('clears silence-only tails instead of committing', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64() });
    manager.handleFinish('d1', 0);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    expect(final.payload.text).toBe('');
    expect(session.commits).toBe(0);
    expect(session.clears).toBe(1);
  });

  it('fails fast when finish arrives with no chunks', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleFinish('d1', 3);

    const error = messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error.payload.retryable).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('reports provider readiness errors from createSttSession', async () => {
    const messages = [];
    const manager = new DictationStreamManager({
      emit: (msg) => messages.push(msg),
      createSttSession: async () => ({
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      }),
    });

    await manager.handleStart('d1', FORMAT, {});
    const error = messages.find((m) => m.type === 'error');
    expect(error.payload.reasonCode).toBe('model_download_in_progress');
    expect(error.payload.retryable).toBe(true);
  });

  it('emits partials as segment transcripts arrive', async () => {
    let segment = 0;
    const session = new FakeSttSession({
      transcriptBySegment: () => {
        segment += 1;
        return segment === 1 ? 'first part' : 'second part';
      },
    });
    const { manager, messages } = createManager(session);
    // Force a hard-cap split after ~0.05s of audio so two segments form.
    manager.segmentMaxSeconds = 0.05;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(1600) });
    await waitFor(() => session.commits >= 1);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64(1600) });
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    expect(final.payload.text).toBe('first part second part');
    const partials = messages.filter((m) => m.type === 'partial');
    expect(partials.length).toBeGreaterThan(0);
  });

  it('keeps a short dictation as one segment even across pauses', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: silentChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 2, audioBase64: loudChunkBase64(16000) });

    expect(session.commits).toBe(0);

    manager.handleFinish('d1', 2);
    await waitFor(() => session.commits === 1);
  });

  it('splits at a pause once the segment passes the minimum length', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 3;

    await manager.handleStart('d1', FORMAT, {});
    // 2s of audio: below the minimum, so this pause must not split.
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: silentChunkBase64(16000) });
    expect(session.commits).toBe(0);

    // Past the minimum, the next quiet chunk is a segment boundary.
    manager.handleChunk({ dictationId: 'd1', seq: 2, audioBase64: loudChunkBase64(16000) });
    expect(session.commits).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 3, audioBase64: silentChunkBase64(16000) });
    expect(session.commits).toBe(1);
  });

  it('splits pauseless speech at the hard cap', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMinSeconds = 60;
    manager.segmentMaxSeconds = 2;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(16000) });
    expect(session.commits).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64(16000) });
    expect(session.commits).toBe(1);
  });

  it('clears a silence-only segment at the hard cap instead of committing it', async () => {
    const session = new FakeSttSession();
    const { manager } = createManager(session);
    manager.segmentMaxSeconds = 1;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64(16000) });

    expect(session.commits).toBe(0);
    expect(session.clears).toBe(1);
  });

  it('uses the session model hard cap instead of the manager defaults', async () => {
    const session = new FakeSttSession({ segmentHints: { minSeconds: 2, maxSeconds: 4 } });
    const { manager } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    for (let seq = 0; seq < 4; seq += 1) {
      manager.handleChunk({ dictationId: 'd1', seq, audioBase64: loudChunkBase64(16000) });
      expect(session.commits).toBe(seq === 3 ? 1 : 0);
    }
    manager.cleanupAll();
  });

  it.each([
    undefined,
    { minSeconds: NaN, maxSeconds: 4 },
    { minSeconds: 2, maxSeconds: Infinity },
    { minSeconds: 0, maxSeconds: 4 },
    { minSeconds: 2, maxSeconds: -4 },
    { minSeconds: 5, maxSeconds: 4 },
  ])('keeps 60/90 defaults with absent or invalid hints: %j', async (segmentHints) => {
    const session = new FakeSttSession({ segmentHints });
    const { manager } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    for (let seq = 0; seq < 90; seq += 1) {
      manager.handleChunk({ dictationId: 'd1', seq, audioBase64: loudChunkBase64(16000) });
      expect(session.commits).toBe(seq === 89 ? 1 : 0);
    }
    expect(manager.streams.get('d1').segmentMinBytes).toBe(60 * 32000);
    manager.cleanupAll();
  });

  it.each([0, 500])('splits inside a chunk at quiet peak %i and accounts only for the remainder', async (quietPeak) => {
    const session = new FakeSttSession({ segmentHints: { minSeconds: 2, maxSeconds: 4 } });
    const { manager } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    for (let seq = 0; seq < 2; seq += 1) {
      manager.handleChunk({ dictationId: 'd1', seq, audioBase64: loudChunkBase64(16000) });
    }
    const chunk = Buffer.concat([
      Buffer.from(loudChunkBase64(9600), 'base64'),
      Buffer.from(loudChunkBase64(6400, quietPeak), 'base64'),
    ]);
    manager.handleChunk({ dictationId: 'd1', seq: 2, audioBase64: chunk.toString('base64') });
    expect(session.operations.slice(-3)).toEqual([
      ['append', 25600], ['commit'], ['append', 6400],
    ]);
    expect(Buffer.concat(session.appended.slice(-2))).toEqual(chunk);
    const state = manager.streams.get('d1');
    expect(state.bytesSinceCommit).toBe(6400);
    expect(state.peakSinceCommit).toBe(quietPeak);
    expect(state.lastChunkPeak).toBe(quietPeak);
    // The remainder counts toward the next cap, without carrying the old peak.
    for (let seq = 3; seq < 6; seq += 1) {
      manager.handleChunk({ dictationId: 'd1', seq, audioBase64: loudChunkBase64(16000, 500) });
      expect(session.commits).toBe(1);
    }
    manager.handleChunk({ dictationId: 'd1', seq: 6, audioBase64: loudChunkBase64(12800, 500) });
    expect(session.commits).toBe(2);
    manager.cleanupAll();
  });

  it('does not split a mid-chunk peak above the relative quiet threshold', async () => {
    const session = new FakeSttSession({ segmentHints: { minSeconds: 2, maxSeconds: 4 } });
    const { manager } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(32000) });
    const chunk = Buffer.concat([8000, 8000, 2000, 8000, 8000].map(
      (peak) => Buffer.from(loudChunkBase64(3200, peak), 'base64'),
    ));
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: chunk.toString('base64') });
    expect(session.commits).toBe(0);
    expect(session.appended.at(-1)).toEqual(chunk);
    manager.cleanupAll();
  });

  it('clears a quiet prefix without dropping the loud remainder', async () => {
    const session = new FakeSttSession({ segmentHints: { minSeconds: 2, maxSeconds: 4 } });
    const { manager } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64(28800) });
    const chunk = Buffer.concat([
      Buffer.from(silentChunkBase64(3200), 'base64'),
      Buffer.from(loudChunkBase64(12800), 'base64'),
    ]);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: chunk.toString('base64') });
    expect(session.operations.slice(-3)).toEqual([
      ['append', 6400], ['clear'], ['append', 25600],
    ]);
    expect(manager.streams.get('d1').peakSinceCommit).toBe(8000);
    manager.cleanupAll();
  });

  it('waits for delayed commit acknowledgements and clears the split silence tail', async () => {
    const session = new FakeSttSession({
      segmentHints: { minSeconds: 2, maxSeconds: 4 }, deferCommits: true,
    });
    const { manager, messages } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(32000) });
    const chunk = Buffer.concat([
      Buffer.from(loudChunkBase64(9600), 'base64'),
      Buffer.from(silentChunkBase64(6400), 'base64'),
    ]);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: chunk.toString('base64') });
    expect(manager.streams.get('d1').pendingCommits).toBe(1);
    manager.handleFinish('d1', 1);
    expect(session.clears).toBe(1);
    expect(messages.some((m) => m.type === 'final')).toBe(false);
    session.emit('committed', { segmentId: 'seg-0' });
    expect(messages.some((m) => m.type === 'final')).toBe(false);
    session.emit('transcript', { segmentId: 'seg-0', transcript: 'complete', isFinal: true });
    expect(messages.find((m) => m.type === 'final').payload.text).toBe('complete');
    expect(session.closed).toBe(true);
  });

  it('suppresses quiet-window and hard-cap auto-splits while finish waits for missing chunks', async () => {
    const session = new FakeSttSession({ segmentHints: { minSeconds: 2, maxSeconds: 4 } });
    const { manager, messages } = createManager(session);
    await manager.handleStart('d1', FORMAT);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(32000) });
    manager.handleFinish('d1', 2);
    const chunk = Buffer.concat([
      Buffer.from(loudChunkBase64(9600), 'base64'),
      Buffer.from(silentChunkBase64(6400), 'base64'),
    ]);
    manager.handleChunk({ dictationId: 'd1', seq: 2, audioBase64: loudChunkBase64(16000) });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: chunk.toString('base64') });
    expect(session.operations).toEqual([
      ['append', 64000], ['append', 32000], ['append', 32000], ['commit'],
    ]);
    await waitFor(() => messages.some((m) => m.type === 'final'));
    expect(session.commits).toBe(1);
  });
});

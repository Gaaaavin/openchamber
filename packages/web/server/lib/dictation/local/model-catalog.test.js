import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_TTS_MODEL_CATALOG,
  getLocalSttModelSpec,
  getLocalTtsDefaultSpeaker,
  resolveLocalTtsModelForLanguage,
} from './model-catalog.js';
import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './worker-client.js';

describe('local STT catalog', () => {
  it('defaults to the complete Qwen3-ASR int8 model', () => {
    expect(DEFAULT_LOCAL_STT_MODEL).toBe('qwen3-asr-0.6b-int8');
    const spec = LOCAL_STT_MODEL_CATALOG[DEFAULT_LOCAL_STT_MODEL];
    expect(spec.type).toBe('qwen3_asr');
    expect(spec.segment).toEqual({ minSeconds: 10, maxSeconds: 20 });
    expect(getLocalSttModelSpec(DEFAULT_LOCAL_STT_MODEL).requiredFiles).toEqual([
      'conv_frontend.onnx',
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokenizer',
    ]);
  });

  it('exposes read-only model segmentation hints on worker-backed sessions', () => {
    const client = new DictationWorkerClient();
    for (const modelId of Object.keys(LOCAL_STT_MODEL_CATALOG)) {
      const session = new WorkerBackedTranscriptionSession(client, { modelsDir: '/unused', modelId });
      expect(session.segmentHints).toEqual(
        modelId === DEFAULT_LOCAL_STT_MODEL ? { minSeconds: 10, maxSeconds: 20 } : undefined,
      );
      expect(() => { session.segmentHints = {}; }).toThrow(TypeError);
    }
  });
});

describe('local TTS catalog', () => {
  it('keeps the selected model when it speaks the language', () => {
    expect(resolveLocalTtsModelForLanguage('en', DEFAULT_LOCAL_TTS_MODEL)).toBe(DEFAULT_LOCAL_TTS_MODEL);
    expect(resolveLocalTtsModelForLanguage('zh', 'kokoro-multi-lang-v1_1')).toBe('kokoro-multi-lang-v1_1');
  });

  it('picks a catalog model for a language the selected model lacks', () => {
    expect(resolveLocalTtsModelForLanguage('uk', DEFAULT_LOCAL_TTS_MODEL)).toBe('piper-uk_UA-lada-x_low');
    expect(resolveLocalTtsModelForLanguage('zh', DEFAULT_LOCAL_TTS_MODEL)).toBe('kokoro-multi-lang-v1_1');
  });

  it('returns null for a language no model covers', () => {
    expect(resolveLocalTtsModelForLanguage('xx', DEFAULT_LOCAL_TTS_MODEL)).toBeNull();
  });

  it('gives Chinese a Chinese speaker on the multi-language Kokoro', () => {
    expect(getLocalTtsDefaultSpeaker('kokoro-multi-lang-v1_1', 'zh')).toBe(3);
    expect(getLocalTtsDefaultSpeaker('kokoro-multi-lang-v1_1', 'en')).toBe(0);
    expect(getLocalTtsDefaultSpeaker('piper-uk_UA-lada-x_low', 'uk')).toBeUndefined();
  });

  it('every TTS entry declares its languages and installable files', () => {
    for (const [id, spec] of Object.entries(LOCAL_TTS_MODEL_CATALOG)) {
      expect(spec.languages.length, id).toBeGreaterThan(0);
      expect(spec.archiveUrl, id).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\//);
      const resolved = getLocalSttModelSpec(id);
      expect(resolved.requiredFiles, id).toContain(spec.files.model);
      for (const key of spec.lexicon ?? []) {
        expect(spec.files[key], `${id} lexicon ${key}`).toBeTruthy();
      }
    }
  });
});

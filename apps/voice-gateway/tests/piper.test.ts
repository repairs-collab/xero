import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TemporaryAudioStore } from '../src/speech/audio-store.js';
import type { SpeechSegment } from '../src/speech/formatter.js';
import {
  PiperRenderer,
  type CommandInvocation,
  type CommandRunner
} from '../src/speech/piper.js';

const roots: string[] = [];

const wav = (sampleRate: number, channels = 1): Buffer => {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(0, 40);
  return buffer;
};

const wavWithListChunk = (sampleRate: number, channels = 1): Buffer => {
  const buffer = Buffer.alloc(56);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(48, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('LIST', 36, 'ascii');
  buffer.writeUInt32LE(4, 40);
  buffer.write('INFO', 44, 'ascii');
  buffer.write('data', 48, 'ascii');
  buffer.writeUInt32LE(0, 52);
  return buffer;
};

class FakeRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];
  failPiper = false;
  finalChannels = 1;
  finalListChunk = false;

  async run(invocation: CommandInvocation): Promise<void> {
    this.invocations.push(invocation);
    if (invocation.command === '/opt/piper/bin/piper') {
      if (this.failPiper) throw new Error('synthetic failure');
      const outputIndex = invocation.args.indexOf('-f') + 1;
      await writeFile(invocation.args[outputIndex]!, wav(22_050));
      return;
    }
    if (invocation.command === '/usr/bin/ffmpeg') {
      await writeFile(
        invocation.args.at(-1)!,
        this.finalListChunk
          ? wavWithListChunk(8_000, this.finalChannels)
          : wav(8_000, this.finalChannels)
      );
      return;
    }
    throw new Error('unexpected command');
  }
}

const sha256 = (content: Buffer | string): string =>
  createHash('sha256').update(content).digest('hex');

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'accountpulse-piper-test-'));
  roots.push(root);
  const modelPath = join(root, 'en_GB-alba-medium.onnx');
  const configPath = `${modelPath}.json`;
  const model = Buffer.from('pinned-model');
  const config = Buffer.from('{"sample_rate":22050}');
  await writeFile(modelPath, model);
  await writeFile(configPath, config);
  const store = new TemporaryAudioStore({
    rootDir: join(root, 'audio'),
    clock: { now: () => new Date('2026-10-09T00:00:00.000Z') },
    allowUnsafeTestRoot: true
  });
  const runner = new FakeRunner();
  const renderer = new PiperRenderer({
    piperExecutable: '/opt/piper/bin/piper',
    ffmpegExecutable: '/usr/bin/ffmpeg',
    models: {
      'en_GB-alba-medium': {
        modelPath,
        configPath,
        modelSha256: sha256(model),
        configSha256: sha256(config)
      }
    },
    audioStore: store,
    runner
  });
  return { renderer, runner, store, modelPath, configPath };
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const store = new TemporaryAudioStore({
      rootDir: root,
      clock: { now: () => new Date() },
      allowUnsafeTestRoot: true
    });
    await store.destroyTestRoot();
  }
});

const segments: SpeechSegment[] = [
  {
    kind: 'ACCOUNT_OPENING',
    protected: false,
    text: "Hello O'Brien and Sons. Press 1."
  }
];

describe('PiperRenderer', () => {
  it('uses pinned model paths, stdin, no shell string, and converts to mono 8 kHz WAV', async () => {
    const { renderer, runner, modelPath, configPath } = await setup();
    const rendered = await renderer.render({
      voiceId: 'en_GB-alba-medium',
      segments,
      outputId: 'call-1'
    });

    expect(runner.invocations).toEqual([
      {
        command: '/opt/piper/bin/piper',
        args: ['-m', modelPath, '-c', configPath, '-f', expect.any(String)],
        stdin: "Hello O'Brien and Sons. Press 1."
      },
      {
        command: '/usr/bin/ffmpeg',
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          expect.any(String),
          '-ac',
          '1',
          '-ar',
          '8000',
          '-c:a',
          'pcm_s16le',
          expect.any(String)
        ],
        stdin: ''
      }
    ]);
    expect(rendered).toMatchObject({
      voiceId: 'en_GB-alba-medium',
      sampleRate: 8_000,
      channels: 1,
      format: 'wav'
    });
    expect((await readFile(rendered.path)).readUInt32LE(24)).toBe(8_000);
  });

  it('rejects unknown or checksum-mismatched voice assets before synthesis', async () => {
    const { renderer, runner, modelPath } = await setup();
    await expect(
      renderer.render({ voiceId: 'unknown', segments, outputId: 'call-2' })
    ).rejects.toThrow('VOICE_MODEL_NOT_APPROVED');
    await writeFile(modelPath, 'changed-model');
    await expect(
      renderer.render({
        voiceId: 'en_GB-alba-medium',
        segments,
        outputId: 'call-3'
      })
    ).rejects.toThrow('VOICE_MODEL_CHECKSUM_MISMATCH');
    expect(runner.invocations).toHaveLength(0);
  });

  it('accepts a standards-compliant ancillary chunk before WAV audio data', async () => {
    const { renderer, runner } = await setup();
    runner.finalListChunk = true;

    await expect(
      renderer.render({
        voiceId: 'en_GB-alba-medium',
        segments,
        outputId: 'metadata-chunk-call'
      })
    ).resolves.toMatchObject({ sampleRate: 8_000, channels: 1, format: 'wav' });
  });

  it('purges all temporary audio when synthesis or output validation fails', async () => {
    const first = await setup();
    first.runner.failPiper = true;
    await expect(
      first.renderer.render({
        voiceId: 'en_GB-alba-medium',
        segments,
        outputId: 'failed-call'
      })
    ).rejects.toThrow('VOICE_SYNTHESIS_FAILED');
    await expect(
      access(join(first.store.rootDir, 'failed-call'))
    ).rejects.toThrow();

    const second = await setup();
    second.runner.finalChannels = 2;
    await expect(
      second.renderer.render({
        voiceId: 'en_GB-alba-medium',
        segments,
        outputId: 'invalid-call'
      })
    ).rejects.toThrow('VOICE_WAV_INVALID');
    await expect(
      access(join(second.store.rootDir, 'invalid-call'))
    ).rejects.toThrow();
  });
});

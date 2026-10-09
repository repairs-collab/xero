import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import type { TemporaryAudioStore } from './audio-store.js';
import type { SpeechSegment } from './formatter.js';

export interface CommandInvocation {
  command: string;
  args: readonly string[];
  stdin: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<void>;
}

export interface PiperVoiceModel {
  modelPath: string;
  configPath: string;
  modelSha256: string;
  configSha256: string;
}

export interface RenderedAudio {
  voiceId: string;
  path: string;
  sampleRate: 8000;
  channels: 1;
  format: 'wav';
}

export interface PiperRendererOptions {
  piperExecutable: string;
  ffmpegExecutable: string;
  models: Readonly<Record<string, PiperVoiceModel>>;
  audioStore: TemporaryAudioStore;
  runner?: CommandRunner;
}

export class NodeCommandRunner implements CommandRunner {
  run(invocation: CommandInvocation): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.args], {
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore']
      });
      child.once('error', () => reject(new Error('VOICE_PROCESS_START_FAILED')));
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('VOICE_PROCESS_FAILED'));
      });
      child.stdin.end(invocation.stdin, 'utf8');
    });
  }
}

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('VOICE_MODEL_READ_FAILED');
    hash.update(chunk);
  }
  return hash.digest('hex');
};

const containsDisallowedSpeechControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 8 ||
      (code >= 11 && code <= 12) ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });

const validateWav = async (
  path: string,
  expectedSampleRate?: number
): Promise<{ sampleRate: number; channels: number }> => {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    const riff = Buffer.alloc(12);
    const riffRead = await file.read(riff, 0, riff.length, 0);
    if (
      riffRead.bytesRead !== riff.length ||
      riff.toString('ascii', 0, 4) !== 'RIFF' ||
      riff.toString('ascii', 8, 12) !== 'WAVE' ||
      riff.readUInt32LE(4) + 8 > metadata.size
    ) {
      throw new Error('VOICE_WAV_INVALID');
    }

    let offset = 12;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let dataFound = false;
    while (offset + 8 <= metadata.size) {
      const chunkHeader = Buffer.alloc(8);
      const chunkRead = await file.read(chunkHeader, 0, chunkHeader.length, offset);
      if (chunkRead.bytesRead !== chunkHeader.length) {
        throw new Error('VOICE_WAV_INVALID');
      }
      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const chunkDataOffset = offset + 8;
      const nextOffset = chunkDataOffset + chunkSize + (chunkSize % 2);
      if (nextOffset <= offset || nextOffset > metadata.size) {
        throw new Error('VOICE_WAV_INVALID');
      }

      if (chunkId === 'fmt ' && channels === undefined) {
        if (chunkSize < 16) throw new Error('VOICE_WAV_INVALID');
        const format = Buffer.alloc(16);
        const formatRead = await file.read(format, 0, format.length, chunkDataOffset);
        if (
          formatRead.bytesRead !== format.length ||
          format.readUInt16LE(0) !== 1 ||
          format.readUInt16LE(14) !== 16
        ) {
          throw new Error('VOICE_WAV_INVALID');
        }
        channels = format.readUInt16LE(2);
        sampleRate = format.readUInt32LE(4);
      } else if (chunkId === 'data') {
        dataFound = true;
      }
      offset = nextOffset;
    }

    if (
      channels === undefined ||
      sampleRate === undefined ||
      !dataFound ||
      channels !== 1 ||
      sampleRate < 8000 ||
      sampleRate > 48_000 ||
      (expectedSampleRate !== undefined && sampleRate !== expectedSampleRate)
    ) {
      throw new Error('VOICE_WAV_INVALID');
    }
    return { sampleRate, channels };
  } catch (error) {
    if (error instanceof Error && error.message === 'VOICE_WAV_INVALID') {
      throw error;
    }
    throw new Error('VOICE_WAV_INVALID');
  } finally {
    await file.close();
  }
};

export class PiperRenderer {
  private readonly runner: CommandRunner;

  constructor(private readonly options: PiperRendererOptions) {
    this.runner = options.runner ?? new NodeCommandRunner();
  }

  async render(input: {
    voiceId: string;
    segments: readonly SpeechSegment[];
    outputId: string;
  }): Promise<RenderedAudio> {
    const model = this.options.models[input.voiceId];
    if (model === undefined) throw new Error('VOICE_MODEL_NOT_APPROVED');
    if (
      (await hashFile(model.modelPath)) !== model.modelSha256 ||
      (await hashFile(model.configPath)) !== model.configSha256
    ) {
      throw new Error('VOICE_MODEL_CHECKSUM_MISMATCH');
    }

    const text = input.segments.map((segment) => segment.text).join(' ').trim();
    if (
      text === '' ||
      text.length > 32_000 ||
      containsDisallowedSpeechControl(text)
    ) {
      throw new Error('VOICE_SPEECH_INVALID');
    }

    const paths = await this.options.audioStore.allocate(input.outputId);
    try {
      try {
        await this.runner.run({
          command: this.options.piperExecutable,
          args: [
            '-m',
            model.modelPath,
            '-c',
            model.configPath,
            '-f',
            paths.sourceWavPath
          ],
          stdin: text
        });
      } catch {
        throw new Error('VOICE_SYNTHESIS_FAILED');
      }
      await validateWav(paths.sourceWavPath);
      try {
        await this.runner.run({
          command: this.options.ffmpegExecutable,
          args: [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            paths.sourceWavPath,
            '-ac',
            '1',
            '-ar',
            '8000',
            '-c:a',
            'pcm_s16le',
            paths.asteriskWavPath
          ],
          stdin: ''
        });
      } catch {
        throw new Error('VOICE_CONVERSION_FAILED');
      }
      await validateWav(paths.asteriskWavPath, 8000);
      await unlink(paths.sourceWavPath);
      return {
        voiceId: input.voiceId,
        path: paths.asteriskWavPath,
        sampleRate: 8000,
        channels: 1,
        format: 'wav'
      };
    } catch (error) {
      await this.options.audioStore.purge(input.outputId);
      throw error;
    }
  }
}

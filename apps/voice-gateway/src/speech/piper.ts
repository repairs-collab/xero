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
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const validateWav = async (
  path: string,
  expectedSampleRate?: number
): Promise<{ sampleRate: number; channels: number }> => {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(44);
    const { bytesRead } = await file.read(header, 0, 44, 0);
    const valid =
      bytesRead === 44 &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WAVE' &&
      header.toString('ascii', 12, 16) === 'fmt ' &&
      header.readUInt16LE(20) === 1 &&
      header.readUInt16LE(34) === 16 &&
      header.toString('ascii', 36, 40) === 'data';
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    if (
      !valid ||
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
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
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

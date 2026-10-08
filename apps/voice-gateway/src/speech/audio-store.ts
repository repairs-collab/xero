import {
  lstat,
  mkdir,
  readdir,
  rm,
  stat
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const productionAudioRoot = resolve('/dev/shm/accountpulse-voice');
const maximumCrashRetentionMs = 60 * 60 * 1000;
const outputIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export interface TemporaryAudioPaths {
  callDirectory: string;
  sourceWavPath: string;
  asteriskWavPath: string;
}

export interface TemporaryAudioStoreOptions {
  rootDir?: string;
  clock: { now(): Date };
  allowUnsafeTestRoot?: boolean;
}

export class TemporaryAudioStore {
  readonly rootDir: string;
  private readonly allowUnsafeTestRoot: boolean;

  constructor(private readonly options: TemporaryAudioStoreOptions) {
    this.rootDir = resolve(options.rootDir ?? productionAudioRoot);
    this.allowUnsafeTestRoot = options.allowUnsafeTestRoot === true;
    if (
      !this.allowUnsafeTestRoot &&
      this.rootDir !== productionAudioRoot &&
      !this.rootDir.startsWith(`${productionAudioRoot}${sep}`)
    ) {
      throw new Error('VOICE_AUDIO_ROOT_NOT_TMPFS');
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.purgeExpired(maximumCrashRetentionMs);
  }

  async allocate(outputId: string): Promise<TemporaryAudioPaths> {
    this.assertOutputId(outputId);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const callDirectory = resolve(this.rootDir, outputId);
    this.assertInsideRoot(callDirectory);
    try {
      const existing = await lstat(callDirectory);
      if (existing.isSymbolicLink()) throw new Error('VOICE_AUDIO_PATH_UNSAFE');
      await rm(callDirectory, { recursive: true, force: true });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        // A new output ID has no directory yet.
      } else {
        throw error;
      }
    }
    await mkdir(callDirectory, { mode: 0o700 });
    return {
      callDirectory,
      sourceWavPath: resolve(callDirectory, 'source.wav'),
      asteriskWavPath: resolve(callDirectory, 'asterisk-8khz.wav')
    };
  }

  async purge(outputId: string): Promise<void> {
    this.assertOutputId(outputId);
    const callDirectory = resolve(this.rootDir, outputId);
    this.assertInsideRoot(callDirectory);
    await rm(callDirectory, { recursive: true, force: true });
  }

  async purgeExpired(maxAgeMs: number): Promise<string[]> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error('VOICE_AUDIO_MAX_AGE_INVALID');
    }
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const cutoff = this.options.clock.now().getTime() - maxAgeMs;
    const removed: string[] = [];
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !outputIdPattern.test(entry.name)) continue;
      const directory = resolve(this.rootDir, entry.name);
      this.assertInsideRoot(directory);
      const metadata = await stat(directory);
      if (metadata.mtimeMs <= cutoff) {
        await rm(directory, { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
    return removed.sort();
  }

  async destroyTestRoot(): Promise<void> {
    if (!this.allowUnsafeTestRoot) throw new Error('VOICE_TEST_ROOT_REQUIRED');
    await rm(this.rootDir, { recursive: true, force: true });
  }

  private assertOutputId(outputId: string): void {
    if (!outputIdPattern.test(outputId)) {
      throw new Error('VOICE_AUDIO_ID_INVALID');
    }
  }

  private assertInsideRoot(candidate: string): void {
    if (!candidate.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error('VOICE_AUDIO_PATH_UNSAFE');
    }
  }
}

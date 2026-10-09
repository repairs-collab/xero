import { access, mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TemporaryAudioStore } from '../src/speech/audio-store.js';

const createdRoots: string[] = [];

const testStore = async (now: Date) => {
  const root = await mkdtemp(join(tmpdir(), 'accountpulse-audio-test-'));
  createdRoots.push(root);
  return new TemporaryAudioStore({
    rootDir: root,
    clock: { now: () => new Date(now) },
    allowUnsafeTestRoot: true
  });
};

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    const store = new TemporaryAudioStore({
      rootDir: root,
      clock: { now: () => new Date() },
      allowUnsafeTestRoot: true
    });
    await store.destroyTestRoot();
  }
});

describe('TemporaryAudioStore', () => {
  it('rejects non-tmpfs production paths and path traversal identifiers', async () => {
    expect(
      () =>
        new TemporaryAudioStore({
          rootDir: join(tmpdir(), 'unsafe-production-audio'),
          clock: { now: () => new Date() }
        })
    ).toThrow('VOICE_AUDIO_ROOT_NOT_TMPFS');
    const store = await testStore(new Date('2026-10-09T00:00:00.000Z'));
    await expect(store.allocate('../escape')).rejects.toThrow(
      'VOICE_AUDIO_ID_INVALID'
    );
  });

  it('allocates private per-call paths and purges them on terminal state', async () => {
    const store = await testStore(new Date('2026-10-09T00:00:00.000Z'));
    const paths = await store.allocate('call-1');
    expect(paths.sourceWavPath.startsWith(store.rootDir)).toBe(true);
    expect(paths.asteriskWavPath.startsWith(store.rootDir)).toBe(true);
    await writeFile(paths.sourceWavPath, 'private audio');
    await store.purge('call-1');
    await expect(access(paths.callDirectory)).rejects.toThrow();
  });

  it('purges expired crash remnants while retaining recent audio', async () => {
    const now = new Date('2026-10-09T02:00:00.000Z');
    const store = await testStore(now);
    const oldPaths = await store.allocate('old-call');
    const recentPaths = await store.allocate('recent-call');
    const oldTime = new Date(now.getTime() - 60 * 60 * 1000 - 1);
    await utimes(oldPaths.callDirectory, oldTime, oldTime);
    await utimes(
      recentPaths.callDirectory,
      new Date(now.getTime() - 59 * 60 * 1000),
      new Date(now.getTime() - 59 * 60 * 1000)
    );

    await expect(store.purgeExpired(60 * 60 * 1000)).resolves.toEqual([
      'old-call'
    ]);
    await expect(access(oldPaths.callDirectory)).rejects.toThrow();
    await expect(stat(recentPaths.callDirectory)).resolves.toBeDefined();
  });

  it('performs the one-hour purge during startup initialisation', async () => {
    const now = new Date('2026-10-09T02:00:00.000Z');
    const store = await testStore(now);
    const orphan = join(store.rootDir, 'startup-orphan');
    await mkdir(orphan, { recursive: true });
    const oldTime = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await utimes(orphan, oldTime, oldTime);

    await store.initialize();
    await expect(access(orphan)).rejects.toThrow();
  });
});

import { fixedVoiceCallCopy } from '@bc5000/domain';

export interface FreePreviewVoice {
  name: string;
  lang: string;
  default?: boolean;
}

export interface FreePreviewPlayback {
  script: string;
  voice: FreePreviewVoice | null;
  lang: string | null;
  rate: number;
  pitch: number;
  onEnd: () => void;
  onError: () => void;
}

export interface FreePreviewPlayer {
  voices: readonly FreePreviewVoice[];
  cancel: () => void;
  speak: (input: FreePreviewPlayback) => void;
}

export interface FreeVoicePlaybackGuard {
  begin: () => () => boolean;
  invalidate: () => void;
}

const fictionalInvoiceDetails =
  'Invoice DEMO-1001 has an outstanding amount of 120 Australian dollars and 50 cents. Invoice DEMO-1002 has an outstanding amount of 80 Australian dollars and 5 cents. The total outstanding amount is 200 Australian dollars and 55 cents.';

export const freeVoicePreviewScripts = Object.freeze({
  opening: fixedVoiceCallCopy.opening,
  details: `${fictionalInvoiceDetails} ${fixedVoiceCallCopy.afterDetails}`,
  transfer:
    'This is a browser-only simulation. A live call would now transfer to the main office. No telephone call has been placed.',
  voicemail: fixedVoiceCallCopy.voicemail.replace(
    '[office number]',
    '03 5032 4518'
  )
});

const languageOrder = ['en-au', 'en-nz', 'en-gb'] as const;

export function selectFreePreviewVoice<T extends FreePreviewVoice>(
  voices: readonly T[]
): T | null {
  for (const language of languageOrder) {
    const match = voices.find(
      (voice) => voice.lang.trim().toLowerCase() === language
    );
    if (match !== undefined) return match;
  }

  return (
    voices.find((voice) =>
      voice.lang.trim().toLowerCase().startsWith('en-')
    ) ?? null
  );
}

export function describeFreePreviewVoice(
  voice: FreePreviewVoice | null
): string {
  if (voice === null) {
    return "Australian voice unavailable; using this device's default voice";
  }
  if (voice.lang.trim().toLowerCase() === 'en-au') {
    return `Australian voice: ${voice.name}`;
  }
  return `Australian voice unavailable; using ${voice.name} (${voice.lang})`;
}

export function createFreeVoicePlaybackGuard(): FreeVoicePlaybackGuard {
  let generation = 0;
  return {
    begin: () => {
      const activeGeneration = ++generation;
      return () => activeGeneration === generation;
    },
    invalidate: () => {
      generation += 1;
    }
  };
}

export function playFreeVoicePreviewScript(input: {
  player: FreePreviewPlayer | null;
  script: string;
  onEnd: () => void;
  onError: () => void;
}): boolean {
  if (input.player === null) return false;
  const voice = selectFreePreviewVoice(input.player.voices);
  input.player.cancel();
  input.player.speak({
    script: input.script,
    voice,
    lang: voice?.lang ?? null,
    rate: 0.95,
    pitch: 1,
    onEnd: input.onEnd,
    onError: input.onError
  });
  return true;
}

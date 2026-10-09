'use client';

import { useEffect, useRef, useState } from 'react';

import {
  createFreeVoicePlaybackGuard,
  describeFreePreviewVoice,
  freeVoicePreviewScripts,
  playFreeVoicePreviewScript,
  selectFreePreviewVoice
} from './free-voice-flow.js';

type PreviewStep =
  | 'READY'
  | 'OPENING'
  | 'DETAILS'
  | 'TRANSFER'
  | 'VOICEMAIL'
  | 'ENDED';

const stepLabel: Record<PreviewStep, string> = {
  READY: 'Ready',
  OPENING: 'Opening playing',
  DETAILS: 'Fictional details playing',
  TRANSFER: 'Transfer simulation playing',
  VOICEMAIL: 'Voicemail simulation playing',
  ENDED: 'Preview ended'
};

export function FreeVoiceFlowPreview() {
  const playbackGuard = useRef(createFreeVoicePlaybackGuard());
  const [supported, setSupported] = useState<boolean | null>(null);
  const [voiceLabel, setVoiceLabel] = useState(
    'Checking this device for an Australian voice'
  );
  const [step, setStep] = useState<PreviewStep>('READY');
  const [status, setStatus] = useState('Ready — no call will be placed');

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      setSupported(false);
      setVoiceLabel('Speech preview is not supported by this browser');
      setStatus('Use a current Chrome, Edge, or Safari browser to hear it');
      return;
    }

    const speech = window.speechSynthesis;
    const refreshVoice = () => {
      setVoiceLabel(
        describeFreePreviewVoice(selectFreePreviewVoice(speech.getVoices()))
      );
    };

    setSupported(true);
    refreshVoice();
    speech.addEventListener('voiceschanged', refreshVoice);
    return () => {
      playbackGuard.current.invalidate();
      speech.removeEventListener('voiceschanged', refreshVoice);
      speech.cancel();
    };
  }, []);

  const speak = (script: string, nextStep: PreviewStep) => {
    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      setSupported(false);
      setStatus('Speech preview is not supported by this browser');
      return;
    }

    setStep(nextStep);
    setStatus(stepLabel[nextStep]);
    const speech = window.speechSynthesis;
    const isCurrentPlayback = playbackGuard.current.begin();
    playFreeVoicePreviewScript({
      player: {
        voices: speech.getVoices(),
        cancel: () => speech.cancel(),
        speak: (playback) => {
          const utterance = new SpeechSynthesisUtterance(playback.script);
          if (playback.voice !== null) {
            utterance.voice = playback.voice as SpeechSynthesisVoice;
          }
          if (playback.lang !== null) utterance.lang = playback.lang;
          utterance.rate = playback.rate;
          utterance.pitch = playback.pitch;
          utterance.onend = playback.onEnd;
          utterance.onerror = playback.onError;
          speech.speak(utterance);
        }
      },
      script,
      onEnd: () => {
        if (isCurrentPlayback()) {
          setStatus(`${stepLabel[nextStep]} — finished`);
        }
      },
      onError: () => {
        if (isCurrentPlayback()) {
          setStatus(
            'The browser could not play this sample. Try another voice-enabled browser.'
          );
        }
      }
    });
  };

  const endPreview = () => {
    playbackGuard.current.invalidate();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setStep('ENDED');
    setStatus(stepLabel.ENDED);
  };

  const unavailable = supported === false;
  const inCall = step !== 'READY' && step !== 'ENDED';

  return (
    <section className="panel free-voice-preview">
      <div className="panel__heading free-voice-preview__heading">
        <div>
          <span className="eyebrow">Zero-cost feasibility proof</span>
          <h2>Free browser voice preview</h2>
          <p>
            No customer will be called. No provider account is required, and
            AccountPulse makes no speech-provider or telephone request.
          </p>
        </div>
        <span className="status-chip">{status}</span>
      </div>

      <div className="free-voice-preview__notice">
        <strong>{voiceLabel}</strong>
        <span>
          Your browser or operating system supplies the voice. Only fictional
          invoices are used in this preview.
        </span>
      </div>

      <ol className="free-voice-preview__steps" aria-label="Simulated call flow">
        <li className={step === 'OPENING' ? 'is-active' : ''}>
          <span>1</span>
          <div>
            <strong>Generic opening</strong>
            <small>No account or invoice information is disclosed.</small>
          </div>
        </li>
        <li className={step === 'DETAILS' ? 'is-active' : ''}>
          <span>2</span>
          <div>
            <strong>Protected fictional details</strong>
            <small>DEMO-1001 and DEMO-1002 are heard only after option 1.</small>
          </div>
        </li>
        <li className={step === 'TRANSFER' ? 'is-active' : ''}>
          <span>3</span>
          <div>
            <strong>Office transfer simulation</strong>
            <small>The preview never opens or dials a telephone link.</small>
          </div>
        </li>
      </ol>

      <div className="free-voice-preview__controls">
        <button
          className="button button--primary"
          type="button"
          onClick={() => speak(freeVoicePreviewScripts.opening, 'OPENING')}
          disabled={unavailable}
        >
          Start preview
        </button>
        <button
          className="button"
          type="button"
          onClick={() => speak(freeVoicePreviewScripts.details, 'DETAILS')}
          disabled={unavailable || step !== 'OPENING'}
        >
          Press 1 · Hear fictional invoice details
        </button>
        <button
          className="button"
          type="button"
          onClick={() => speak(freeVoicePreviewScripts.transfer, 'TRANSFER')}
          disabled={
            unavailable || (step !== 'OPENING' && step !== 'DETAILS')
          }
        >
          Press 2 · Simulate office transfer
        </button>
        <button
          className="button"
          type="button"
          onClick={() => speak(freeVoicePreviewScripts.voicemail, 'VOICEMAIL')}
          disabled={unavailable}
        >
          Simulate voicemail
        </button>
        <button
          className="button button--quiet"
          type="button"
          onClick={endPreview}
          disabled={!inCall}
        >
          End preview
        </button>
      </div>
    </section>
  );
}

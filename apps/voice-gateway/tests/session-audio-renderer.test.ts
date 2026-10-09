import { describe, expect, it, vi } from 'vitest';

import type { CreateGatewayCallCommand } from '../src/contracts.js';
import type { SpeechSegment } from '../src/speech/formatter.js';
import { GatewaySessionAudioRenderer } from '../src/speech/session-audio-renderer.js';

type RenderInput = {
  voiceId: string;
  segments: readonly SpeechSegment[];
  outputId: string;
};

const command: CreateGatewayCallCommand = {
  version: 1,
  gatewayCallId: '00000000-0000-4000-8000-000000000501',
  organisationId: '00000000-0000-4000-8000-000000000502',
  voiceCallId: '00000000-0000-4000-8000-000000000503',
  idempotencyKey: 'voice-call:503',
  provider: 'VOIPCLOUD',
  providerUserNumber: '301',
  destinationNumber: '+61400000001',
  callerId: '+61350324518',
  flowVersion: 1,
  ttsVoiceId: 'en_GB-alba-medium',
  callbackUrl: 'https://accountpulse.invalid/api/webhooks/voice-gateway',
  transfer: {
    fallbackNumber: '+61350324518',
    label: 'Mott Appliance Repairs office'
  },
  approvedFacts: {
    accountName: 'Example Customer Pty Ltd',
    combinedAmount: '125.50',
    currency: 'AUD',
    invoices: [{ invoiceNumber: 'INV-1', amountDue: '125.50', dueDate: '2026-10-01' }]
  }
};

describe('GatewaySessionAudioRenderer', () => {
  it('renders the account opening, protected details, and generic voicemail into shared sound paths', async () => {
    const render = vi
      .fn<(input: RenderInput) => Promise<{ path: string }>>()
      .mockImplementation(({ outputId }) =>
        Promise.resolve({
          path: `/dev/shm/accountpulse-voice/${outputId}/asterisk-8khz.wav`
        })
      );
    const purge = vi
      .fn<(outputId: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const renderer = new GatewaySessionAudioRenderer({ render }, { purge });

    await expect(renderer.prepare(command)).resolves.toEqual({
      openingMedia: `sound:accountpulse/${command.gatewayCallId}-opening/asterisk-8khz`,
      detailsMedia: `sound:accountpulse/${command.gatewayCallId}-details/asterisk-8khz`,
      voicemailMedia: `sound:accountpulse/${command.gatewayCallId}-voicemail/asterisk-8khz`
    });
    expect(render).toHaveBeenCalledTimes(3);
    const openingText = render.mock.calls[0]?.[0].segments
      .map((segment) => segment.text)
      .join(' ');
    const detailsText = render.mock.calls[1]?.[0].segments
      .map((segment) => segment.text)
      .join(' ');
    const voicemailText = render.mock.calls[2]?.[0].segments
      .map((segment) => segment.text)
      .join(' ');
    expect(openingText).toContain('Example Customer Pty Ltd');
    expect(openingText).not.toContain('INV-1');
    expect(detailsText).toContain('I N V dash one');
    expect(voicemailText).toBe('This is Mott Appliance Repairs calling. Please call our office on 03 5032 4518 during business hours.');

    await renderer.purge(command.gatewayCallId);
    expect(purge.mock.calls.map((call) => call[0])).toEqual([
      `${command.gatewayCallId}-opening`,
      `${command.gatewayCallId}-details`,
      `${command.gatewayCallId}-voicemail`
    ]);
  });

  it('purges every session file when any render fails', async () => {
    const render = vi
      .fn()
      .mockResolvedValueOnce({ path: 'opening' })
      .mockRejectedValueOnce(new Error('VOICE_SYNTHESIS_FAILED'));
    const purge = vi.fn().mockResolvedValue(undefined);
    const renderer = new GatewaySessionAudioRenderer({ render }, { purge });
    await expect(renderer.prepare(command)).rejects.toThrow('VOICE_SYNTHESIS_FAILED');
    expect(purge).toHaveBeenCalledTimes(3);
  });
});

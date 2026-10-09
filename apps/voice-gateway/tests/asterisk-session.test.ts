import { describe, expect, it, vi } from 'vitest';

import type { GatewayCallEvent } from '../src/call-state.js';
import type { CreateGatewayCallCommand } from '../src/contracts.js';
import {
  AsteriskSessionController,
  type AriClient,
  type AriEvent,
  type SessionAudio,
  type SessionAudioRenderer,
  type SessionClock,
  type VoipcloudCallLauncher
} from '../src/asterisk/session-controller.js';

const command = (overrides: Partial<CreateGatewayCallCommand> = {}): CreateGatewayCallCommand => ({
  version: 1,
  gatewayCallId: '00000000-0000-4000-8000-000000000401',
  organisationId: '00000000-0000-4000-8000-000000000402',
  voiceCallId: '00000000-0000-4000-8000-000000000403',
  idempotencyKey: 'voice-call:403',
  provider: 'VOIPCLOUD',
  providerUserNumber: '301',
  destinationNumber: '+61400000001',
  callerId: '+61350324518',
  flowVersion: 1,
  ttsVoiceId: 'en_GB-alba-medium',
  callbackUrl: 'https://accountpulse.invalid/api/webhooks/voice-gateway',
  transfer: {
    sipUri: 'sip:301@office.invalid',
    fallbackNumber: '+61350324518',
    label: 'Mott Appliance Repairs office'
  },
  approvedFacts: {
    accountName: "O'Brien & Sons Pty Ltd",
    combinedAmount: '125.50',
    currency: 'AUD',
    invoices: [
      { invoiceNumber: 'INV-1001', amountDue: '125.50', dueDate: '2026-10-01' }
    ]
  },
  ...overrides
});

class FakeAri implements AriClient {
  listener: ((event: AriEvent) => void | Promise<void>) | undefined;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  nextChannel = 1;

  subscribe(listener: (event: AriEvent) => void | Promise<void>): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: AriEvent): Promise<void> {
    return Promise.resolve(this.listener?.(event));
  }

  answer(channelId: string): Promise<void> {
    this.calls.push({ method: 'answer', args: [channelId] });
    return Promise.resolve();
  }

  play(channelId: string, media: string, playbackId: string): Promise<void> {
    this.calls.push({ method: 'play', args: [channelId, media, playbackId] });
    return Promise.resolve();
  }

  stopPlayback(playbackId: string): Promise<void> {
    this.calls.push({ method: 'stopPlayback', args: [playbackId] });
    return Promise.resolve();
  }

  createBridge(bridgeId: string, types: readonly string[]): Promise<void> {
    this.calls.push({ method: 'createBridge', args: [bridgeId, types] });
    return Promise.resolve();
  }

  addChannels(bridgeId: string, channelIds: readonly string[]): Promise<void> {
    this.calls.push({ method: 'addChannels', args: [bridgeId, channelIds] });
    return Promise.resolve();
  }

  originate(input: {
    endpoint: string;
    app: string;
    appArgs: string;
    callerId: string;
    timeoutSeconds: number;
  }): Promise<{ channelId: string }> {
    const channelId = `office-${this.nextChannel++}`;
    this.calls.push({ method: 'originate', args: [input, channelId] });
    return Promise.resolve({ channelId });
  }

  hangup(channelId: string): Promise<void> {
    this.calls.push({ method: 'hangup', args: [channelId] });
    return Promise.resolve();
  }

  destroyBridge(bridgeId: string): Promise<void> {
    this.calls.push({ method: 'destroyBridge', args: [bridgeId] });
    return Promise.resolve();
  }
}

class FakeClock implements SessionClock {
  private nextTimer = 1;
  readonly timers = new Map<number, () => void | Promise<void>>();

  now(): Date {
    return new Date('2026-10-09T00:00:00.000Z');
  }

  setTimeout(callback: () => void | Promise<void>): number {
    const id = this.nextTimer++;
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(id: number | NodeJS.Timeout): void {
    if (typeof id === 'number') this.timers.delete(id);
  }

  async fireAll(): Promise<void> {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const callback of pending) await callback();
  }
}

const audio: SessionAudio = {
  openingMedia: 'sound:accountpulse/call/opening',
  detailsMedia: 'sound:accountpulse/call/details',
  voicemailMedia: 'sound:accountpulse/call/voicemail'
};

const setup = (officeQueueExtension = '1003') => {
  const ari = new FakeAri();
  const clock = new FakeClock();
  const events: GatewayCallEvent[] = [];
  const callToNumber = vi
    .fn<VoipcloudCallLauncher['callToNumber']>()
    .mockResolvedValue({ status: 'accepted' });
  const launcher: VoipcloudCallLauncher = {
    callToNumber
  };
  const prepare = vi
    .fn<SessionAudioRenderer['prepare']>()
    .mockResolvedValue(audio);
  const purge = vi
    .fn<SessionAudioRenderer['purge']>()
    .mockResolvedValue(undefined);
  const renderer: SessionAudioRenderer = {
    prepare,
    purge
  };
  const controller = new AsteriskSessionController({
    ari,
    launcher,
    renderer,
    clock,
    officeQueueExtension,
    transferTimeoutSeconds: 25,
    inputTimeoutMs: 10_000,
    emitEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    }
  });
  return {
    ari,
    callToNumber,
    clock,
    controller,
    events,
    launcher,
    prepare,
    purge,
    renderer
  };
};

const startHumanChannel = async (context: ReturnType<typeof setup>) => {
  await context.controller.start(command());
  await context.ari.emit({
    type: 'StasisStart',
    channelId: 'customer-channel',
    args: ['provider-user', '301', 'HUMAN']
  });
};

describe('AsteriskSessionController', () => {
  it('rejects an unsafe office queue extension before accepting calls', () => {
    expect(() => setup('1003@unapproved.invalid')).toThrow(
      'VOICE_OFFICE_QUEUE_EXTENSION_INVALID'
    );
  });

  it('prepares locked audio before dispatch and permits only one active call per user', async () => {
    const context = setup();
    await context.controller.start(command());

    expect(context.prepare).toHaveBeenCalledWith(command());
    expect(context.callToNumber).toHaveBeenCalledWith({
      userNumber: '301',
      numberToCall: '+61400000001',
      callerId: '+61350324518'
    });
    expect(context.events.map((event) => event.type)).toEqual(['PROVIDER_REQUESTED']);
    await expect(
      context.controller.start(command({ gatewayCallId: '00000000-0000-4000-8000-000000000411' }))
    ).rejects.toThrow('GATEWAY_USER_BUSY');
  });

  it('answers only the paired provider user and plays no prompt before the classified channel arrives', async () => {
    const context = setup();
    await context.controller.start(command());
    expect(context.ari.calls).toEqual([]);

    await context.ari.emit({
      type: 'StasisStart',
      channelId: 'unrelated',
      args: ['provider-user', '999', 'HUMAN']
    });
    expect(context.ari.calls).toEqual([{ method: 'hangup', args: ['unrelated'] }]);

    await context.ari.emit({
      type: 'StasisStart',
      channelId: 'customer-channel',
      args: ['provider-user', '301', 'HUMAN']
    });
    expect(context.ari.calls.slice(-2)).toEqual([
      { method: 'answer', args: ['customer-channel'] },
      expect.objectContaining({ method: 'play', args: ['customer-channel', audio.openingMedia, expect.any(String)] })
    ]);
    expect(context.events.map((event) => event.type)).toEqual([
      'PROVIDER_REQUESTED',
      'GATEWAY_LEG_ANSWERED',
      'CUSTOMER_ANSWERED',
      'MENU_PLAYED'
    ]);
  });

  it('reveals protected details only after option 1 and completes after playback', async () => {
    const context = setup();
    await startHumanChannel(context);
    expect(context.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])).toEqual([
      audio.openingMedia
    ]);

    await context.ari.emit({ type: 'ChannelDtmfReceived', channelId: 'customer-channel', digit: '1' });
    expect(context.events.map((event) => event.type)).toContain('IDENTITY_CONFIRMED');
    expect(context.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])).toEqual([
      audio.openingMedia,
      audio.detailsMedia
    ]);

    const detailsPlayback = context.ari.calls.filter((call) => call.method === 'play').at(-1)?.args[2] as string;
    await context.ari.emit({ type: 'PlaybackFinished', playbackId: detailsPlayback });
    expect(context.events.map((event) => event.type).slice(-2)).toEqual(['DETAILS_DELIVERED', 'COMPLETED']);
    expect(context.purge).toHaveBeenCalledWith(command().gatewayCallId);
  });

  it('starts the no-input timeout only after the complete opening menu has played', async () => {
    const context = setup();
    await startHumanChannel(context);

    await context.clock.fireAll();
    expect(
      context.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])
    ).toEqual([audio.openingMedia]);

    const openingPlayback = context.ari.calls.find(
      (call) => call.method === 'play' && call.args[1] === audio.openingMedia
    )?.args[2] as string;
    await context.ari.emit({
      type: 'PlaybackFinished',
      playbackId: openingPlayback
    });
    await context.clock.fireAll();

    expect(
      context.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])
    ).toEqual([audio.openingMedia, audio.voicemailMedia]);
  });

  it('gives a replayed menu its full playback time after invalid input', async () => {
    const context = setup();
    await startHumanChannel(context);
    await context.ari.emit({
      type: 'ChannelDtmfReceived',
      channelId: 'customer-channel',
      digit: '8'
    });

    await context.clock.fireAll();
    expect(
      context.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])
    ).toEqual([audio.openingMedia, audio.openingMedia]);

    const replayPlayback = context.ari.calls
      .filter((call) => call.method === 'play')
      .at(-1)?.args[2] as string;
    await context.ari.emit({
      type: 'PlaybackFinished',
      playbackId: replayPlayback
    });
    await context.clock.fireAll();
    expect(
      context.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])
    ).toEqual([audio.openingMedia, audio.openingMedia, audio.voicemailMedia]);
  });

  it('transfers option 2 to the approved Tab 1 queue and bridges only after answer', async () => {
    const context = setup();
    await startHumanChannel(context);
    await context.ari.emit({ type: 'ChannelDtmfReceived', channelId: 'customer-channel', digit: '2' });

    expect(context.ari.calls.find((call) => call.method === 'originate')?.args[0]).toEqual({
      endpoint: 'PJSIP/1003@voipcloud-outbound',
      app: 'accountpulse-voice',
      appArgs: `office,${command().gatewayCallId}`,
      callerId: '+61350324518',
      timeoutSeconds: 25
    });
    expect(context.ari.calls.some((call) => call.method === 'createBridge')).toBe(false);

    await context.ari.emit({
      type: 'StasisStart',
      channelId: 'office-1',
      args: ['office', command().gatewayCallId]
    });
    expect(context.ari.calls).toContainEqual({
      method: 'createBridge',
      args: [`bridge-${command().gatewayCallId}`, ['mixing', 'dtmf_events', 'proxy_media']]
    });
    expect(context.ari.calls).toContainEqual({
      method: 'addChannels',
      args: [`bridge-${command().gatewayCallId}`, ['customer-channel', 'office-1']]
    });
    expect(context.events.map((event) => event.type)).toContain('TRANSFERRED');
  });

  it('reports an unanswered transfer once and plays callback guidance before ending', async () => {
    const context = setup();
    await startHumanChannel(context);
    await context.ari.emit({ type: 'ChannelDtmfReceived', channelId: 'customer-channel', digit: '2' });
    await context.ari.emit({ type: 'ChannelDestroyed', channelId: 'office-1', cause: 19 });
    await context.ari.emit({ type: 'ChannelDestroyed', channelId: 'office-1', cause: 19 });

    expect(context.events.filter((event) => event.type === 'TRANSFER_UNANSWERED')).toHaveLength(1);
    const callbackPlayback = context.ari.calls
      .filter((call) => call.method === 'play')
      .find((call) => call.args[1] === audio.voicemailMedia);
    expect(callbackPlayback).toBeDefined();
    expect(context.purge).not.toHaveBeenCalled();
    expect(context.ari.calls).not.toContainEqual({
      method: 'hangup',
      args: ['customer-channel']
    });

    await context.ari.emit({
      type: 'PlaybackFinished',
      playbackId: callbackPlayback?.args[2] as string
    });
    expect(context.purge).toHaveBeenCalledTimes(1);
    expect(context.ari.calls).toContainEqual({
      method: 'hangup',
      args: ['customer-channel']
    });
  });

  it('plays only the generic voicemail for machine classification', async () => {
    const context = setup();
    await context.controller.start(command());
    await context.ari.emit({
      type: 'StasisStart',
      channelId: 'voicemail-channel',
      args: ['provider-user', '301', 'MACHINE']
    });
    expect(context.ari.calls.filter((call) => call.method === 'play').at(-1)?.args[1]).toBe(audio.voicemailMedia);
    expect(context.events.map((event) => event.type)).toContain('VOICEMAIL_DETECTED');
    expect(context.events.map((event) => event.type)).not.toContain('IDENTITY_CONFIRMED');
  });

  it('handles wrong number, invalid input, no input, and duplicate terminal events safely', async () => {
    const wrong = setup();
    await startHumanChannel(wrong);
    await wrong.ari.emit({ type: 'ChannelDtmfReceived', channelId: 'customer-channel', digit: '9' });
    await wrong.ari.emit({ type: 'ChannelDtmfReceived', channelId: 'customer-channel', digit: '9' });
    expect(wrong.events.filter((event) => event.type === 'WRONG_NUMBER')).toHaveLength(1);

    const invalid = setup();
    await startHumanChannel(invalid);
    await invalid.ari.emit({ type: 'ChannelDtmfReceived', channelId: 'customer-channel', digit: '8' });
    expect(invalid.ari.calls.filter((call) => call.method === 'play').map((call) => call.args[1])).toEqual([
      audio.openingMedia,
      audio.openingMedia
    ]);

    const timedOut = setup();
    await startHumanChannel(timedOut);
    const timedOutOpeningPlayback = timedOut.ari.calls
      .filter((call) => call.method === 'play')
      .at(-1)?.args[2] as string;
    await timedOut.ari.emit({
      type: 'PlaybackFinished',
      playbackId: timedOutOpeningPlayback
    });
    await timedOut.clock.fireAll();
    expect(timedOut.ari.calls.filter((call) => call.method === 'play').at(-1)?.args[1]).toBe(audio.voicemailMedia);
  });

  it('maps launch uncertainty without redial and purges audio', async () => {
    const context = setup();
    context.callToNumber.mockRejectedValueOnce(
      new Error('VOICE_PROVIDER_UNKNOWN_DISPATCH')
    );
    await context.controller.start(command());
    await context.controller.start(command());

    expect(context.callToNumber).toHaveBeenCalledTimes(1);
    expect(context.events.map((event) => event.type)).toEqual(['UNKNOWN']);
    expect(context.purge).toHaveBeenCalledWith(command().gatewayCallId);
  });
});

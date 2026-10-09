import { describe, expect, it, vi } from 'vitest';

import { AsteriskAriClient, mapAriEvent } from '../src/asterisk/ari-client.js';

describe('mapAriEvent', () => {
  it('maps only the locked event fields used by the controller', () => {
    expect(
      mapAriEvent({
        type: 'StasisStart',
        args: ['provider-user', '301', 'HUMAN'],
        channel: { id: 'channel-1', caller: { number: '+61400111222' } },
        sensitive: 'must-not-escape'
      })
    ).toEqual({
      type: 'StasisStart',
      channelId: 'channel-1',
      args: ['provider-user', '301', 'HUMAN']
    });
    expect(
      mapAriEvent({
        type: 'ChannelDtmfReceived',
        digit: '1',
        channel: { id: 'channel-1' }
      })
    ).toEqual({ type: 'ChannelDtmfReceived', channelId: 'channel-1', digit: '1' });
    expect(mapAriEvent({ type: 'RecordingStarted', recording: { name: 'forbidden' } })).toBeUndefined();
  });
});

describe('AsteriskAriClient REST operations', () => {
  it('uses authenticated private ARI requests with encoded path and query values', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'office-channel' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const client = new AsteriskAriClient({
      baseUrl: 'http://asterisk:8088/ari',
      eventsUrl: 'ws://asterisk:8088/ari/events',
      username: 'gateway',
      password: 'secret',
      app: 'accountpulse-voice',
      request
    });

    await client.play('channel /1', 'sound:accountpulse/call/opening', 'playback /1');
    await expect(
      client.originate({
        endpoint: 'PJSIP/301@office.invalid',
        app: 'accountpulse-voice',
        appArgs: 'office,call-id',
        callerId: '+61350324518',
        timeoutSeconds: 25
      })
    ).resolves.toEqual({ channelId: 'office-channel' });

    const [playUrl, playInit] = request.mock.calls[0] as [string, RequestInit];
    expect(playUrl).toContain('/channels/channel%20%2F1/play/playback%20%2F1?');
    expect(playUrl).toContain('media=sound%3Aaccountpulse%2Fcall%2Fopening');
    expect(playInit.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from('gateway:secret').toString('base64')}`
    });

    const originateUrl = request.mock.calls[1]?.[0] as string;
    expect(originateUrl).toContain('/channels?');
    expect(originateUrl).toContain('endpoint=PJSIP%2F301%40office.invalid');
    expect(originateUrl).toContain('appArgs=office%2Ccall-id');
  });

  it('returns stable errors without credentials or response bodies', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response('secret provider response', { status: 500 })
    );
    const client = new AsteriskAriClient({
      baseUrl: 'http://asterisk:8088/ari',
      eventsUrl: 'ws://asterisk:8088/ari/events',
      username: 'gateway',
      password: 'do-not-leak',
      app: 'accountpulse-voice',
      request
    });
    await expect(client.answer('channel-1')).rejects.toThrow('ASTERISK_ARI_REQUEST_FAILED');
    await expect(client.answer('channel-1')).rejects.not.toThrow('do-not-leak');
    await expect(client.answer('channel-1')).rejects.not.toThrow('secret provider response');
  });
});

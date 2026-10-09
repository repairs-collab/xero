import type { AriClient, AriEvent } from './session-controller.js';

type AriRequest = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>;

interface AriSocket {
  addEventListener(
    type: 'open' | 'error' | 'close' | 'message',
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean }
  ): void;
  close(): void;
}

export interface AsteriskAriClientOptions {
  baseUrl: string;
  eventsUrl: string;
  username: string;
  password: string;
  app: string;
  request?: AriRequest;
  socketFactory?: (url: string) => AriSocket;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const recordId = (value: unknown): string | undefined => {
  const record = asRecord(value);
  return typeof record?.id === 'string' && record.id !== ''
    ? record.id
    : undefined;
};

export const mapAriEvent = (value: unknown): AriEvent | undefined => {
  const event = asRecord(value);
  if (event === undefined || typeof event.type !== 'string') return undefined;
  if (event.type === 'StasisStart') {
    const channelId = recordId(event.channel);
    if (
      channelId === undefined ||
      !Array.isArray(event.args) ||
      !event.args.every((argument) => typeof argument === 'string')
    ) {
      return undefined;
    }
    return {
      type: 'StasisStart',
      channelId,
      args: event.args
    };
  }
  if (
    event.type === 'StasisEnd' ||
    event.type === 'ChannelHangupRequest'
  ) {
    const channelId = recordId(event.channel);
    return channelId === undefined
      ? undefined
      : { type: event.type, channelId };
  }
  if (event.type === 'ChannelDtmfReceived') {
    const channelId = recordId(event.channel);
    return channelId === undefined || typeof event.digit !== 'string'
      ? undefined
      : { type: 'ChannelDtmfReceived', channelId, digit: event.digit };
  }
  if (event.type === 'PlaybackFinished') {
    const playbackId = recordId(event.playback);
    return playbackId === undefined
      ? undefined
      : { type: 'PlaybackFinished', playbackId };
  }
  if (event.type === 'ChannelDestroyed') {
    const channelId = recordId(event.channel);
    if (channelId === undefined) return undefined;
    return {
      type: 'ChannelDestroyed',
      channelId,
      ...(typeof event.cause === 'number' && Number.isFinite(event.cause)
        ? { cause: event.cause }
        : {})
    };
  }
  return undefined;
};

const parseSocketMessage = (data: unknown): unknown => {
  if (typeof data === 'string') return JSON.parse(data) as unknown;
  if (data instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(data).toString('utf8')) as unknown;
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
    ) as unknown;
  }
  throw new Error('ASTERISK_ARI_EVENT_INVALID');
};

const requiredOption = (value: string, code: string): string => {
  if (value.trim() === '') throw new Error(code);
  return value.replace(/\/$/, '');
};

export class AsteriskAriClient implements AriClient {
  private readonly baseUrl: string;
  private readonly eventsUrl: string;
  private readonly request: AriRequest;
  private readonly listeners = new Set<
    (event: AriEvent) => void | Promise<void>
  >();
  private socket: AriSocket | undefined;

  constructor(private readonly options: AsteriskAriClientOptions) {
    this.baseUrl = requiredOption(options.baseUrl, 'ASTERISK_ARI_URL_REQUIRED');
    this.eventsUrl = requiredOption(
      options.eventsUrl,
      'ASTERISK_ARI_EVENTS_URL_REQUIRED'
    );
    requiredOption(options.username, 'ASTERISK_ARI_USERNAME_REQUIRED');
    requiredOption(options.password, 'ASTERISK_ARI_PASSWORD_REQUIRED');
    requiredOption(options.app, 'ASTERISK_ARI_APP_REQUIRED');
    this.request = options.request ?? fetch;
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined) return;
    const url = new URL(this.eventsUrl);
    url.searchParams.set('app', this.options.app);
    url.searchParams.set(
      'api_key',
      `${this.options.username}:${this.options.password}`
    );
    url.searchParams.set('subscribeAll', 'false');
    const socketFactory =
      this.options.socketFactory ??
      ((socketUrl: string): AriSocket => new WebSocket(socketUrl));
    const socket = socketFactory(url.toString());
    this.socket = socket;
    socket.addEventListener('message', (message) => {
      try {
        const event = mapAriEvent(parseSocketMessage(message.data));
        if (event === undefined) return;
        for (const listener of this.listeners) void listener(event);
      } catch {
        // Invalid or unsupported provider events are ignored without logging data.
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = undefined;
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('ASTERISK_ARI_CONNECTION_FAILED')),
        { once: true }
      );
    });
  }

  subscribe(listener: (event: AriEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  answer(channelId: string): Promise<void> {
    return this.voidRequest('POST', `/channels/${this.segment(channelId)}/answer`);
  }

  play(channelId: string, media: string, playbackId: string): Promise<void> {
    return this.voidRequest(
      'POST',
      `/channels/${this.segment(channelId)}/play/${this.segment(playbackId)}`,
      { media }
    );
  }

  stopPlayback(playbackId: string): Promise<void> {
    return this.voidRequest('DELETE', `/playbacks/${this.segment(playbackId)}`);
  }

  createBridge(bridgeId: string, types: readonly string[]): Promise<void> {
    return this.voidRequest('POST', `/bridges/${this.segment(bridgeId)}`, {
      type: types.join(',')
    });
  }

  addChannels(bridgeId: string, channelIds: readonly string[]): Promise<void> {
    return this.voidRequest(
      'POST',
      `/bridges/${this.segment(bridgeId)}/addChannel`,
      { channel: channelIds.join(',') }
    );
  }

  async originate(input: {
    endpoint: string;
    app: string;
    appArgs: string;
    callerId: string;
    timeoutSeconds: number;
  }): Promise<{ channelId: string }> {
    const response = await this.send('POST', '/channels', {
      endpoint: input.endpoint,
      app: input.app,
      appArgs: input.appArgs,
      callerId: input.callerId,
      timeout: String(input.timeoutSeconds)
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('ASTERISK_ARI_RESPONSE_INVALID');
    }
    const channelId = recordId(body);
    if (channelId === undefined) throw new Error('ASTERISK_ARI_RESPONSE_INVALID');
    return { channelId };
  }

  hangup(channelId: string): Promise<void> {
    return this.voidRequest('DELETE', `/channels/${this.segment(channelId)}`);
  }

  destroyBridge(bridgeId: string): Promise<void> {
    return this.voidRequest('DELETE', `/bridges/${this.segment(bridgeId)}`);
  }

  private async voidRequest(
    method: string,
    path: string,
    query?: Readonly<Record<string, string>>
  ): Promise<void> {
    await this.send(method, path, query);
  }

  private async send(
    method: string,
    path: string,
    query?: Readonly<Record<string, string>>
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value);
    }
    let response: Response;
    try {
      response = await this.request(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`
        }
      });
    } catch {
      throw new Error('ASTERISK_ARI_REQUEST_FAILED');
    }
    if (!response.ok) throw new Error('ASTERISK_ARI_REQUEST_FAILED');
    return response;
  }

  private segment(value: string): string {
    if (value === '') throw new Error('ASTERISK_ARI_IDENTIFIER_INVALID');
    return encodeURIComponent(value);
  }
}

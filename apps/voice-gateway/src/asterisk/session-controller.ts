import type { GatewayCallEvent, GatewayCallEventType } from '../call-state.js';
import type { CreateGatewayCallCommand } from '../contracts.js';

export type AriEvent =
  | {
      type: 'StasisStart';
      channelId: string;
      args: readonly string[];
    }
  | {
      type: 'StasisEnd' | 'ChannelHangupRequest';
      channelId: string;
    }
  | {
      type: 'ChannelDtmfReceived';
      channelId: string;
      digit: string;
    }
  | {
      type: 'PlaybackFinished';
      playbackId: string;
    }
  | {
      type: 'ChannelDestroyed';
      channelId: string;
      cause?: number;
    };

export interface AriClient {
  subscribe(listener: (event: AriEvent) => void | Promise<void>): () => void;
  answer(channelId: string): Promise<void>;
  play(channelId: string, media: string, playbackId: string): Promise<void>;
  stopPlayback(playbackId: string): Promise<void>;
  createBridge(bridgeId: string, types: readonly string[]): Promise<void>;
  addChannels(bridgeId: string, channelIds: readonly string[]): Promise<void>;
  originate(input: {
    endpoint: string;
    app: string;
    appArgs: string;
    callerId: string;
    timeoutSeconds: number;
  }): Promise<{ channelId: string }>;
  hangup(channelId: string): Promise<void>;
  destroyBridge(bridgeId: string): Promise<void>;
}

export interface VoipcloudCallLauncher {
  callToNumber(input: {
    userNumber: string;
    numberToCall: string;
    callerId?: string;
  }): Promise<unknown>;
}

export interface SessionAudio {
  openingMedia: string;
  detailsMedia: string;
  voicemailMedia: string;
}

export interface SessionAudioRenderer {
  prepare(command: CreateGatewayCallCommand): Promise<SessionAudio>;
  purge(gatewayCallId: string): Promise<void>;
}

export interface SessionClock {
  now(): Date;
  setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number
  ): number | NodeJS.Timeout;
  clearTimeout(id: number | NodeJS.Timeout): void;
}

interface ControllerDependencies {
  ari: AriClient;
  launcher: VoipcloudCallLauncher;
  renderer: SessionAudioRenderer;
  clock: SessionClock;
  emitEvent(event: GatewayCallEvent): Promise<void>;
  officeQueueExtension: string;
  transferTimeoutSeconds: number;
  inputTimeoutMs: number;
}

type PlaybackKind =
  | 'opening'
  | 'details'
  | 'voicemail'
  | 'transfer-unanswered';

interface ActiveSession {
  command: CreateGatewayCallCommand;
  audio: SessionAudio;
  sequence: number;
  customerChannelId: string | undefined;
  officeChannelId: string | undefined;
  bridgeId: string | undefined;
  playbackId: string | undefined;
  playbackKind: PlaybackKind | undefined;
  inputTimerId: number | NodeJS.Timeout | undefined;
  transferUnansweredPending: boolean;
  terminal: boolean;
  purged: boolean;
  disposed: boolean;
}

const isUnknownDispatch = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'VoipcloudUnknownDispatchError' ||
    error.message === 'VOICE_PROVIDER_UNKNOWN_DISPATCH');

const officeEndpoint = (queueExtension: string): string =>
  `PJSIP/${queueExtension}@voipcloud-outbound`;

const safeOperation = async (operation: () => Promise<void>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Cleanup is best effort and must not repeat or reverse a terminal outcome.
  }
};

export class AsteriskSessionController {
  private readonly sessionsByCall = new Map<string, ActiveSession>();
  private readonly activeByProviderUser = new Map<string, ActiveSession>();
  private readonly unsubscribe: () => void;

  constructor(private readonly dependencies: ControllerDependencies) {
    if (!/^\d{2,8}$/.test(dependencies.officeQueueExtension)) {
      throw new Error('VOICE_OFFICE_QUEUE_EXTENSION_INVALID');
    }
    this.unsubscribe = dependencies.ari.subscribe((event) =>
      this.handleEvent(event)
    );
  }

  async start(command: CreateGatewayCallCommand): Promise<void> {
    if (this.sessionsByCall.has(command.gatewayCallId)) return;
    if (this.activeByProviderUser.has(command.providerUserNumber)) {
      throw new Error('GATEWAY_USER_BUSY');
    }

    let audio: SessionAudio;
    try {
      audio = await this.dependencies.renderer.prepare(command);
    } catch {
      await this.dependencies.renderer.purge(command.gatewayCallId);
      const failed: ActiveSession = {
        command,
        audio: {
          openingMedia: '',
          detailsMedia: '',
          voicemailMedia: ''
        },
        sequence: 0,
        customerChannelId: undefined,
        officeChannelId: undefined,
        bridgeId: undefined,
        playbackId: undefined,
        playbackKind: undefined,
        inputTimerId: undefined,
        transferUnansweredPending: false,
        terminal: false,
        purged: true,
        disposed: true
      };
      this.sessionsByCall.set(command.gatewayCallId, failed);
      await this.emit(failed, 'FAILED', 'VOICE_AUDIO_PREPARATION_FAILED');
      return;
    }

    const session: ActiveSession = {
      command,
      audio,
      sequence: 0,
      customerChannelId: undefined,
      officeChannelId: undefined,
      bridgeId: undefined,
      playbackId: undefined,
      playbackKind: undefined,
      inputTimerId: undefined,
      transferUnansweredPending: false,
      terminal: false,
      purged: false,
      disposed: false
    };
    this.sessionsByCall.set(command.gatewayCallId, session);
    this.activeByProviderUser.set(command.providerUserNumber, session);
    try {
      await this.dependencies.launcher.callToNumber({
        userNumber: command.providerUserNumber,
        numberToCall: command.destinationNumber,
        callerId: command.callerId
      });
      await this.emit(session, 'PROVIDER_REQUESTED');
    } catch (error) {
      await this.finish(
        session,
        isUnknownDispatch(error) ? 'UNKNOWN' : 'FAILED',
        isUnknownDispatch(error)
          ? 'VOICE_PROVIDER_UNKNOWN_DISPATCH'
          : 'VOICE_PROVIDER_REQUEST_FAILED',
        false
      );
    }
  }

  close(): void {
    this.unsubscribe();
  }

  private async handleEvent(event: AriEvent): Promise<void> {
    if (event.type === 'StasisStart') {
      await this.handleStasisStart(event);
      return;
    }
    if (event.type === 'PlaybackFinished') {
      const session = [...this.sessionsByCall.values()].find(
        (candidate) => candidate.playbackId === event.playbackId
      );
      if (session !== undefined) await this.handlePlaybackFinished(session, event.playbackId);
      return;
    }
    const session = [...this.sessionsByCall.values()].find(
      (candidate) =>
        candidate.customerChannelId === event.channelId ||
        candidate.officeChannelId === event.channelId
    );
    if (session === undefined || session.disposed) return;
    if (event.type === 'ChannelDtmfReceived') {
      await this.handleDtmf(session, event.channelId, event.digit);
      return;
    }
    if (event.type === 'ChannelDestroyed') {
      await this.handleChannelDestroyed(session, event.channelId);
      return;
    }
    await this.handleChannelEnded(session, event.channelId);
  }

  private async handleStasisStart(
    event: Extract<AriEvent, { type: 'StasisStart' }>
  ): Promise<void> {
    if (event.args[0] === 'office') {
      const gatewayCallId = event.args[1];
      const session =
        gatewayCallId === undefined
          ? undefined
          : this.sessionsByCall.get(gatewayCallId);
      if (
        session === undefined ||
        session.disposed ||
        session.customerChannelId === undefined ||
        session.officeChannelId !== event.channelId
      ) {
        await safeOperation(() => this.dependencies.ari.hangup(event.channelId));
        return;
      }
      const bridgeId = `bridge-${session.command.gatewayCallId}`;
      session.bridgeId = bridgeId;
      await this.dependencies.ari.answer(event.channelId);
      await this.dependencies.ari.createBridge(bridgeId, [
        'mixing',
        'dtmf_events',
        'proxy_media'
      ]);
      await this.dependencies.ari.addChannels(bridgeId, [
        session.customerChannelId,
        event.channelId
      ]);
      await this.finish(session, 'TRANSFERRED', undefined, false, false);
      return;
    }

    if (event.args[0] !== 'provider-user') {
      await safeOperation(() => this.dependencies.ari.hangup(event.channelId));
      return;
    }
    const providerUserNumber = event.args[1];
    const classification = event.args[2] ?? 'NOTSURE';
    const session =
      providerUserNumber === undefined
        ? undefined
        : this.activeByProviderUser.get(providerUserNumber);
    if (
      session === undefined ||
      session.customerChannelId !== undefined ||
      session.terminal
    ) {
      await safeOperation(() => this.dependencies.ari.hangup(event.channelId));
      return;
    }

    session.customerChannelId = event.channelId;
    await this.dependencies.ari.answer(event.channelId);
    await this.emit(session, 'GATEWAY_LEG_ANSWERED');
    if (classification === 'MACHINE') {
      await this.emit(session, 'VOICEMAIL_DETECTED');
      await this.play(session, 'voicemail');
      return;
    }
    await this.emit(session, 'CUSTOMER_ANSWERED');
    await this.play(session, 'opening');
    await this.emit(session, 'MENU_PLAYED');
  }

  private async handleDtmf(
    session: ActiveSession,
    channelId: string,
    digit: string
  ): Promise<void> {
    if (
      session.terminal ||
      session.transferUnansweredPending ||
      session.customerChannelId !== channelId ||
      session.bridgeId !== undefined
    ) {
      return;
    }
    this.clearInputTimer(session);
    if (session.playbackId !== undefined) {
      await safeOperation(() =>
        this.dependencies.ari.stopPlayback(session.playbackId as string)
      );
      session.playbackId = undefined;
      session.playbackKind = undefined;
    }
    if (digit === '1') {
      await this.emit(session, 'IDENTITY_CONFIRMED');
      await this.play(session, 'details');
      return;
    }
    if (digit === '2') {
      await this.emit(session, 'TRANSFER_REQUESTED');
      try {
        const originated = await this.dependencies.ari.originate({
          endpoint: officeEndpoint(this.dependencies.officeQueueExtension),
          app: 'accountpulse-voice',
          appArgs: `office,${session.command.gatewayCallId}`,
          callerId: session.command.callerId,
          timeoutSeconds: this.dependencies.transferTimeoutSeconds
        });
        session.officeChannelId = originated.channelId;
      } catch {
        await this.handleTransferUnanswered(
          session,
          'VOICE_TRANSFER_FAILED'
        );
      }
      return;
    }
    if (digit === '9') {
      await this.finish(session, 'WRONG_NUMBER', 'VOICE_WRONG_NUMBER');
      return;
    }
    await this.play(session, 'opening');
  }

  private async handlePlaybackFinished(
    session: ActiveSession,
    playbackId: string
  ): Promise<void> {
    if (session.terminal || session.playbackId !== playbackId) return;
    const kind = session.playbackKind;
    session.playbackId = undefined;
    session.playbackKind = undefined;
    if (kind === 'opening') {
      this.armInputTimer(session);
    } else if (kind === 'details') {
      await this.emit(session, 'DETAILS_DELIVERED');
      await this.finish(session, 'COMPLETED');
    } else if (kind === 'transfer-unanswered') {
      await this.completeTerminalSession(session);
    } else if (kind === 'voicemail') {
      await this.finish(session, 'COMPLETED');
    }
  }

  private async handleChannelDestroyed(
    session: ActiveSession,
    channelId: string
  ): Promise<void> {
    if (
      channelId === session.officeChannelId &&
      session.bridgeId === undefined &&
      !session.terminal
    ) {
      await this.handleTransferUnanswered(
        session,
        'VOICE_TRANSFER_UNANSWERED'
      );
      return;
    }
    await this.handleChannelEnded(session, channelId);
  }

  private async handleChannelEnded(
    session: ActiveSession,
    channelId: string
  ): Promise<void> {
    if (session.disposed) return;
    if (!session.terminal && !session.transferUnansweredPending) {
      await this.finish(session, 'FAILED', 'VOICE_CHANNEL_ENDED', false);
    } else if (session.transferUnansweredPending) {
      await this.completeTerminalSession(session, false);
    }
    const otherChannel =
      channelId === session.customerChannelId
        ? session.officeChannelId
        : session.customerChannelId;
    if (otherChannel !== undefined) {
      await safeOperation(() => this.dependencies.ari.hangup(otherChannel));
    }
    if (session.bridgeId !== undefined) {
      await safeOperation(() =>
        this.dependencies.ari.destroyBridge(session.bridgeId as string)
      );
    }
    this.dispose(session);
  }

  private async play(
    session: ActiveSession,
    kind: PlaybackKind
  ): Promise<void> {
    const channelId = session.customerChannelId;
    if (channelId === undefined) throw new Error('VOICE_CUSTOMER_CHANNEL_MISSING');
    const media =
      kind === 'opening'
        ? session.audio.openingMedia
        : kind === 'details'
          ? session.audio.detailsMedia
          : session.audio.voicemailMedia;
    const playbackId = `${session.command.gatewayCallId}-${kind}-${session.sequence + 1}`;
    session.playbackId = playbackId;
    session.playbackKind = kind;
    await this.dependencies.ari.play(channelId, media, playbackId);
  }

  private armInputTimer(session: ActiveSession): void {
    this.clearInputTimer(session);
    session.inputTimerId = this.dependencies.clock.setTimeout(async () => {
      if (session.terminal || session.customerChannelId === undefined) return;
      if (session.playbackId !== undefined) {
        await safeOperation(() =>
          this.dependencies.ari.stopPlayback(session.playbackId as string)
        );
      }
      await this.play(session, 'voicemail');
    }, this.dependencies.inputTimeoutMs);
  }

  private clearInputTimer(session: ActiveSession): void {
    if (session.inputTimerId !== undefined) {
      this.dependencies.clock.clearTimeout(session.inputTimerId);
      session.inputTimerId = undefined;
    }
  }

  private async emit(
    session: ActiveSession,
    type: GatewayCallEventType,
    safeCode?: string
  ): Promise<void> {
    session.sequence += 1;
    await this.dependencies.emitEvent({
      eventId: `${session.command.gatewayCallId}:${session.sequence}`,
      gatewayCallId: session.command.gatewayCallId,
      sequence: session.sequence,
      type,
      ...(safeCode === undefined ? {} : { safeCode }),
      occurredAt: this.dependencies.clock.now().toISOString()
    });
  }

  private async finish(
    session: ActiveSession,
    type: Extract<
      GatewayCallEventType,
      | 'TRANSFERRED'
      | 'TRANSFER_UNANSWERED'
      | 'WRONG_NUMBER'
      | 'COMPLETED'
      | 'FAILED'
      | 'UNKNOWN'
    >,
    safeCode?: string,
    hangup = true,
    dispose = true
  ): Promise<void> {
    if (session.terminal) return;
    await this.emit(session, type, safeCode);
    await this.completeTerminalSession(session, hangup, dispose);
  }

  private async handleTransferUnanswered(
    session: ActiveSession,
    safeCode: string
  ): Promise<void> {
    if (session.terminal || session.transferUnansweredPending) return;
    session.transferUnansweredPending = true;
    await this.emit(session, 'TRANSFER_UNANSWERED', safeCode);
    try {
      await this.play(session, 'transfer-unanswered');
    } catch {
      await this.completeTerminalSession(session);
    }
  }

  private async completeTerminalSession(
    session: ActiveSession,
    hangup = true,
    dispose = true
  ): Promise<void> {
    if (session.terminal) return;
    session.terminal = true;
    this.clearInputTimer(session);
    if (!session.purged) {
      session.purged = true;
      await this.dependencies.renderer.purge(session.command.gatewayCallId);
    }
    if (hangup && session.customerChannelId !== undefined) {
      await safeOperation(() =>
        this.dependencies.ari.hangup(session.customerChannelId as string)
      );
    }
    if (dispose) this.dispose(session);
  }

  private dispose(session: ActiveSession): void {
    if (session.disposed) return;
    session.disposed = true;
    if (
      this.activeByProviderUser.get(session.command.providerUserNumber) ===
      session
    ) {
      this.activeByProviderUser.delete(session.command.providerUserNumber);
    }
  }
}

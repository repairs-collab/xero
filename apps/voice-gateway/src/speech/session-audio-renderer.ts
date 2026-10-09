import type { SessionAudio, SessionAudioRenderer } from '../asterisk/session-controller.js';
import type { CreateGatewayCallCommand } from '../contracts.js';
import {
  formatAccountOpening,
  formatProtectedDetails,
  formatVoicemail,
  type SpeechSegment
} from './formatter.js';

interface SpeechRendererPort {
  render(input: {
    voiceId: string;
    segments: readonly SpeechSegment[];
    outputId: string;
  }): Promise<{ path: string }>;
}

interface AudioStorePort {
  purge(outputId: string): Promise<void>;
}

const outputKinds = ['opening', 'details', 'voicemail'] as const;

const outputId = (
  gatewayCallId: string,
  kind: (typeof outputKinds)[number]
): string => `${gatewayCallId}-${kind}`;

const mediaUri = (
  gatewayCallId: string,
  kind: (typeof outputKinds)[number]
): string =>
  `sound:accountpulse/${outputId(gatewayCallId, kind)}/asterisk-8khz`;

const australianDisplayNumber = (e164: string): string => {
  const match = /^\+61([2-478])(\d{4})(\d{4})$/.exec(e164);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error('VOICE_OFFICE_NUMBER_UNSUPPORTED');
  }
  return `0${match[1]} ${match[2]} ${match[3]}`;
};

export class GatewaySessionAudioRenderer implements SessionAudioRenderer {
  constructor(
    private readonly renderer: SpeechRendererPort,
    private readonly audioStore: AudioStorePort
  ) {}

  async prepare(command: CreateGatewayCallCommand): Promise<SessionAudio> {
    const callId = command.gatewayCallId;
    try {
      await this.renderer.render({
        voiceId: command.ttsVoiceId,
        segments: formatAccountOpening(command.approvedFacts.accountName),
        outputId: outputId(callId, 'opening')
      });
      await this.renderer.render({
        voiceId: command.ttsVoiceId,
        segments: formatProtectedDetails(command.approvedFacts),
        outputId: outputId(callId, 'details')
      });
      await this.renderer.render({
        voiceId: command.ttsVoiceId,
        segments: formatVoicemail(
          australianDisplayNumber(command.transfer.fallbackNumber)
        ),
        outputId: outputId(callId, 'voicemail')
      });
      return {
        openingMedia: mediaUri(callId, 'opening'),
        detailsMedia: mediaUri(callId, 'details'),
        voicemailMedia: mediaUri(callId, 'voicemail')
      };
    } catch (error) {
      await this.purge(callId);
      throw error;
    }
  }

  async purge(gatewayCallId: string): Promise<void> {
    const results = await Promise.allSettled(
      outputKinds.map((kind) =>
        this.audioStore.purge(outputId(gatewayCallId, kind))
      )
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('VOICE_AUDIO_PURGE_FAILED');
    }
  }
}

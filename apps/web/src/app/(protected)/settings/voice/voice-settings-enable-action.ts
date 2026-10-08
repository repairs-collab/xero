export type VoiceSettingsActionErrorCode =
  | 'VOICE_ENABLE_CONFIRMATION_REQUIRED'
  | 'VOICE_SETTINGS_NOT_CONFIGURED'
  | 'VOICE_SETTINGS_NOT_READY';

export type VoiceSettingsActionState =
  | { status: 'idle' }
  | {
      status: 'success';
      message: string;
    }
  | {
      status: 'error';
      code: VoiceSettingsActionErrorCode;
      message: string;
    };

export interface SetVoiceEnabledActionInput {
  organisationId: string;
  enabled: boolean;
  confirmation?: string;
}

interface VoiceSettingsEnabler {
  setEnabled(
    input: SetVoiceEnabledActionInput
  ): Promise<{ enabled: boolean }>;
}

export interface SetVoiceEnabledActionDependencies {
  settings: VoiceSettingsEnabler;
  revalidate(): void | Promise<void>;
}

const errorMessages: Record<VoiceSettingsActionErrorCode, string> = {
  VOICE_ENABLE_CONFIRMATION_REQUIRED:
    'Type ENABLE VOICE CALLS exactly to enable manual voice calls.',
  VOICE_SETTINGS_NOT_CONFIGURED:
    'Save the voice provider settings before enabling manual voice calls.',
  VOICE_SETTINGS_NOT_READY:
    'Complete the connection test and generic flow test before enabling manual voice calls.'
};

const knownErrorCode = (
  error: unknown
): VoiceSettingsActionErrorCode | null => {
  if (!(error instanceof Error)) return null;
  return Object.hasOwn(errorMessages, error.message)
    ? (error.message as VoiceSettingsActionErrorCode)
    : null;
};

export const voiceSettingsInitialActionState: VoiceSettingsActionState = {
  status: 'idle'
};

export async function runSetVoiceEnabledAction(
  dependencies: SetVoiceEnabledActionDependencies,
  input: SetVoiceEnabledActionInput
): Promise<VoiceSettingsActionState> {
  let result: { enabled: boolean };
  try {
    result = await dependencies.settings.setEnabled(input);
  } catch (error) {
    const code = knownErrorCode(error);
    if (code === null) throw error;
    return { status: 'error', code, message: errorMessages[code] };
  }
  await dependencies.revalidate();
  return {
    status: 'success',
    message: `Manual voice calls ${result.enabled ? 'enabled' : 'disabled'}.`
  };
}

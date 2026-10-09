import { createDatabase } from '@bc5000/db';
import { FetchHttpClient } from '@bc5000/integrations/http';
import { VoipcloudClient } from '@bc5000/integrations/voipcloud';

import { AsteriskAriClient } from './asterisk/ari-client.js';
import { AsteriskSessionController } from './asterisk/session-controller.js';
import { createGatewayServer } from './server.js';
import { PostgresGatewaySessionStore } from './session-store.js';
import { TemporaryAudioStore } from './speech/audio-store.js';
import { PiperRenderer } from './speech/piper.js';
import { GatewaySessionAudioRenderer } from './speech/session-audio-renderer.js';

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const database = createDatabase(requiredEnvironment('DATABASE_URL'));
const clock = {
  now: (): Date => new Date(),
  setTimeout: (
    callback: () => void | Promise<void>,
    delayMs: number
  ): NodeJS.Timeout => setTimeout(() => void callback(), delayMs),
  clearTimeout: (timer: number | NodeJS.Timeout): void => clearTimeout(timer)
};
const audioStore = new TemporaryAudioStore({
  clock
});
await audioStore.initialize();

const piper = new PiperRenderer({
  piperExecutable: process.env.PIPER_EXECUTABLE ?? '/opt/piper/bin/piper',
  ffmpegExecutable: process.env.FFMPEG_EXECUTABLE ?? '/usr/bin/ffmpeg',
  models: {
    'en_GB-alba-medium': {
      modelPath:
        process.env.PIPER_MODEL_PATH ??
        '/opt/accountpulse/voices/en_GB-alba-medium/en_GB-alba-medium.onnx',
      configPath:
        process.env.PIPER_CONFIG_PATH ??
        '/opt/accountpulse/voices/en_GB-alba-medium/en_GB-alba-medium.onnx.json',
      modelSha256:
        '401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b',
      configSha256:
        'aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4'
    }
  },
  audioStore
});
const sessionStore = new PostgresGatewaySessionStore(database.db);
const ari = new AsteriskAriClient({
  baseUrl: process.env.ASTERISK_ARI_URL ?? 'http://asterisk:8088/ari',
  eventsUrl:
    process.env.ASTERISK_ARI_EVENTS_URL ?? 'ws://asterisk:8088/ari/events',
  username: requiredEnvironment('ASTERISK_ARI_USERNAME'),
  password: requiredEnvironment('ASTERISK_ARI_PASSWORD'),
  app: 'accountpulse-voice'
});
await ari.connect();
const controller = new AsteriskSessionController({
  ari,
  launcher: new VoipcloudClient({
    http: new FetchHttpClient(),
    apiKey: requiredEnvironment('VOIPCLOUD_API_KEY')
  }),
  renderer: new GatewaySessionAudioRenderer(piper, audioStore),
  clock,
  officeQueueExtension: requiredEnvironment('VOICE_OFFICE_QUEUE_EXTENSION'),
  transferTimeoutSeconds: 25,
  inputTimeoutMs: 12_000,
  emitEvent: async (event) => {
    await sessionStore.applyEvent(event, clock.now());
  }
});

const voiceCallsEnabled = process.env.VOICE_GATEWAY_ACCEPT_CALLS === 'true';

const server = createGatewayServer({
  store: sessionStore,
  signingSecret: requiredEnvironment('VOICE_GATEWAY_SIGNING_SECRET'),
  clock,
  supportedFlowVersion: 1,
  startCall: async (command) => {
    if (!voiceCallsEnabled) throw new Error('GATEWAY_VOICE_DISABLED');
    await controller.start(command);
  }
});

const port = Number(process.env.PORT ?? '3105');
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port');
}

server.listen(port, host);

const shutdown = (): void => {
  controller.close();
  ari.close();
  server.close(() => {
    void database.pool.end().finally(() => process.exit(0));
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

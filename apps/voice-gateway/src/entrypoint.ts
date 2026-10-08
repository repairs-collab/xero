import { createDatabase } from '@bc5000/db';

import { createGatewayServer } from './server.js';
import { PostgresGatewaySessionStore } from './session-store.js';
import { TemporaryAudioStore } from './speech/audio-store.js';

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const database = createDatabase(requiredEnvironment('DATABASE_URL'));
const audioStore = new TemporaryAudioStore({
  clock: { now: () => new Date() }
});
await audioStore.initialize();

const server = createGatewayServer({
  store: new PostgresGatewaySessionStore(database.db),
  signingSecret: requiredEnvironment('VOICE_GATEWAY_SIGNING_SECRET'),
  clock: { now: () => new Date() },
  supportedFlowVersion: 1
});

const port = Number(process.env.PORT ?? '3105');
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port');
}

server.listen(port, host);

const shutdown = (): void => {
  server.close(() => {
    void database.pool.end().finally(() => process.exit(0));
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

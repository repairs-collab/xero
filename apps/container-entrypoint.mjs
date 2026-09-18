import { spawn } from 'node:child_process';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (!process.env.DATABASE_URL) {
  const user = encodeURIComponent(required('DATABASE_USER'));
  const password = encodeURIComponent(required('DATABASE_PASSWORD'));
  const host = required('DATABASE_HOST');
  const port = required('DATABASE_PORT');
  const database = required('DATABASE_NAME');
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

const command = process.argv[2];
if (!command) throw new Error('A container command is required');
const child = spawn(command, process.argv.slice(3), {
  env: process.env,
  stdio: 'inherit'
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

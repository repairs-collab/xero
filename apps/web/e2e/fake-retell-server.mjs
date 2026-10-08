import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 3201;
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  if (
    request.url === '/get-agent/agent_accountpulse?version=1' &&
    request.headers.authorization === 'Bearer fake-retell-private-key'
  ) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: 1, voice_id: 'voice_au' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not_found"}');
});

server.listen(port, host);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

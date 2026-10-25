const http = require('node:http');
const host = process.env.PAA_FAKE_HOST || '127.0.0.1';
const port = Number(process.env.PAA_FAKE_PORT || '8140');
http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end(); return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  let model;
  try { model = JSON.parse(body).model; } catch { response.writeHead(400).end(); return; }
  if (!model || request.headers.authorization !== 'Bearer fake-provider-token') {
    response.writeHead(401).end(); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `provider-response-${model}` }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` + 'data: [DONE]\n\n');
}).listen(port, host, () => console.log(`fake provider on ${host}:${port}`));

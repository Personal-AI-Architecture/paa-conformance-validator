const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { eventsFromSse, runLiveChecks } = require('../lib/live.js');

test('live parser rejects streamed events without the contract discriminator', () => {
  assert.throws(() => eventsFromSse('event: text-delta\ndata: {"content":"hello"}\n\n'), /_event_type/);
  assert.deepEqual(eventsFromSse('event: done\ndata: {"_event_type":"done"}\n\n')[0].event, 'done');
});

test('live runner fails a service that accepts spoofed actor headers', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"conversations":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runLiveChecks({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-token' });
    assert.ok(result.errors.some(error => error.includes('spoofed actor headers denied')));
    assert.ok(result.errors.some(error => error.includes('unauthenticated list denied')));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

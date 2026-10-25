const { randomBytes } = require('node:crypto');

const MESSAGE = { content: [{ type: 'text', text: 'Say hello.' }], metadata: { correlation_id: 'paa-live-check' } };

async function request(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10000), ...options });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eventsFromSse(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event: '))?.slice(7);
    const data = lines.find(line => line.startsWith('data: '))?.slice(6);
    assert(event && data, 'SSE frame lacks event or data');
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error(`SSE ${event} has invalid JSON`); }
    assert(parsed && parsed._event_type === event, `SSE ${event} lacks matching _event_type`);
    return { event, data: parsed };
  });
}

async function runLiveChecks({ baseUrl, apiKey }) {
  const checks = [];
  async function check(name, fn) {
    try { await fn(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  }
  const key = apiKey || randomBytes(24).toString('hex');
  const auth = { 'X-API-Key': key };
  const body = JSON.stringify(MESSAGE);
  await check('unauthenticated list denied', async () => {
    const r = await request(baseUrl, '/conversations');
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('spoofed actor headers denied', async () => {
    const r = await request(baseUrl, '/conversations', { headers: { 'X-Actor-ID': 'owner', 'X-Actor-Permissions': '*' } });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('authentication runs before body parsing', async () => {
    const r = await request(baseUrl, '/conversations/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad-json'
    });
    assert(r.status === 401, `expected 401 before parsing, got ${r.status}`);
  });
  await check('invalid API key denied', async () => {
    const r = await request(baseUrl, '/conversations', { headers: { 'X-API-Key': `${key}-wrong` } });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('API key lists conversations', async () => {
    const r = await request(baseUrl, '/conversations', { headers: auth });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(Array.isArray(JSON.parse(r.text).conversations), 'missing conversations array');
  });
  await check('Bearer token lists conversations', async () => {
    const r = await request(baseUrl, '/conversations', { headers: { Authorization: `Bearer ${key}` } });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });
  await check('oversized request rejected', async () => {
    const r = await request(baseUrl, '/conversations/messages', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] })
    });
    assert(r.status === 413, `expected 413, got ${r.status}`);
  });
  let conversationId;
  let assistantMessageId;
  await check('authenticated message streams canonical events', async () => {
    const r = await request(baseUrl, '/conversations/messages', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body
    });
    assert(r.status === 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
    assert(r.headers.get('content-type')?.includes('text/event-stream'), 'missing SSE content type');
    conversationId = r.headers.get('x-conversation-id');
    assert(conversationId, 'missing X-Conversation-ID');
    const events = eventsFromSse(r.text);
    assert(events.some(x => x.event === 'text-delta'), 'missing text-delta');
    if (process.env.PAA_LIVE_EXPECT_TEXT) {
      const text = events.filter(x => x.event === 'text-delta').map(x => x.data.content ?? '').join('');
      assert(text.includes(process.env.PAA_LIVE_EXPECT_TEXT), 'selected provider response was not streamed');
    }
    const done = events.find(x => x.event === 'done');
    assert(done, 'missing done event');
    assert(done.data.finish_reason && done.data.message_id, 'done lacks finish_reason or message_id');
    assistantMessageId = done.data.message_id;
  });
  if (conversationId) await check('conversation remains readable', async () => {
    const r = await request(baseUrl, `/conversations/${encodeURIComponent(conversationId)}`, { headers: auth });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const data = JSON.parse(r.text);
    assert(data.id === conversationId, 'conversation ID mismatch');
    assert(Array.isArray(data.messages) && data.messages.length >= 2, 'conversation reply not persisted');
    const assistant = data.messages.find(message => message.role === 'assistant' && message.id === assistantMessageId);
    assert(assistant, 'done message_id does not identify the saved assistant reply');
  });
  if (conversationId) await check('existing conversation accepts a second message', async () => {
    const r = await request(baseUrl, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body
    });
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.headers.get('x-conversation-id') === conversationId, 'conversation ID changed');
    const events = eventsFromSse(r.text);
    const done = events.find(x => x.event === 'done');
    assert(done?.data.message_id, 'continuation lacks saved message ID');
    const detail = await request(baseUrl, `/conversations/${encodeURIComponent(conversationId)}`, { headers: auth });
    const messages = JSON.parse(detail.text).messages;
    assert(messages.length >= 4, `expected two turns, got ${messages.length} messages`);
    assert(messages.some(message => message.id === done.data.message_id && message.role === 'assistant'), 'second done ID does not identify saved reply');
  });
  await check('list filters and pagination are honored', async () => {
    const marker = `paa-filter-${randomBytes(8).toString('hex')}`;
    const matching = [];
    for (let index = 0; index < 2; index += 1) {
      const r = await request(baseUrl, '/conversations/messages', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'text', text: `${marker} ${index}` }] })
      });
      assert(r.status === 200, `setup message expected 200, got ${r.status}`);
      matching.push(r.headers.get('x-conversation-id'));
    }
    const filtered = await request(baseUrl, `/conversations?search=${marker}&limit=1&offset=1`, { headers: auth });
    assert(filtered.status === 200, `expected 200, got ${filtered.status}`);
    const data = JSON.parse(filtered.text);
    assert(data.total === 2, `search total expected 2, got ${data.total}`);
    assert(data.conversations.length === 1, `limit expected 1 result, got ${data.conversations.length}`);
    assert(matching.includes(data.conversations[0].id), 'pagination returned an unrelated conversation');
    const future = await request(baseUrl, '/conversations?from=2099-01-01T00%3A00%3A00Z', { headers: auth });
    assert(JSON.parse(future.text).total === 0, 'from timestamp filter was ignored');
    const past = await request(baseUrl, '/conversations?to=1970-01-01T00%3A00%3A00Z', { headers: auth });
    assert(JSON.parse(past.text).total === 0, 'to timestamp filter was ignored');
  });
  return { checks, errors: checks.filter(x => !x.ok).map(x => `${x.name}: ${x.detail}`), conversationId };
}

module.exports = { runLiveChecks, eventsFromSse };

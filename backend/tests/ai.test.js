// AI through the server: who may use it, the model and effort each kind of request gets, streaming, the cost
// recorded, the monthly allowance, and failures. A stand-in for the Anthropic API answers in its streaming format.
// Runs against a real PostgreSQL database (TEST_DATABASE_URL); the schema is rebuilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hotp, timeStep } from '../src/security/totp.js';
import { costOf, echoable } from '../src/ai.js';

const url = process.env.TEST_DATABASE_URL;
const H = { 'x-requested-with': 'lease-manager' };
let app, upstream, keyless, capped;
const jar = {}, ids = {}, seen = [];
let answer = () => ({ blocks: [{ type: 'text', text: 'Hello there' }], stop: 'end_turn' });

/* ---- The stand-in: records each request and streams the planned answer ---- */
function sse(res, model, { blocks, stop, status }) {
    if (status) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20000, output_tokens: 1, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 } } });
    blocks.forEach((b, index) => {
        if (b.type === 'text') {
            ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
            for (const part of b.text.match(/.{1,5}/g)) ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
        } else {
            ev('content_block_start', { index, content_block: { ...b, input: {} } });
            ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        }
        ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2000 } });
    ev('message_stop', {});
    res.end();
}

async function call(who, method, path, body, a = app) {
    const r = await a.inject({ method, url: path, payload: body, headers: { ...H, ...(jar[who] ? { cookie: jar[who] } : {}) } });
    const set = r.headers['set-cookie']; if (set) jar[who] = [].concat(set).map(c => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.body, json: () => JSON.parse(r.body) };
}
/** The server-sent events of a reply, in order. */
const events = text => text.split('\n\n').filter(Boolean).map(p => ({ event: /^event: (.*)$/m.exec(p)[1], data: JSON.parse(/^data: (.*)$/m.exec(p)[1]) }));
async function onboard(who, email, temp) {
    await call(who, 'POST', '/api/auth/login', { email, password: temp });
    const secret = JSON.parse((await call(who, 'POST', '/api/auth/mfa/setup')).body).secret;
    await call(who, 'POST', '/api/auth/mfa/verify', { code: hotp(secret, timeStep()) });
    assert.equal((await call(who, 'POST', '/api/auth/password', { current: temp, next: 'Saffron-Ledger-Ai-27' })).status, 200);
}
const ask = (who, body) => call(who, 'POST', '/api/ai/messages', { messages: [{ role: 'user', content: 'Summarise the leases' }], ...body });

test.before(async () => {
    assert.ok(url, 'Set TEST_DATABASE_URL');
    upstream = http.createServer((req, res) => {
        let raw = ''; req.on('data', d => { raw += d; });
        req.on('end', () => { const b = JSON.parse(raw); seen.push({ body: b, beta: req.headers['anthropic-beta'] || '' }); sse(res, b.model, answer(b)); });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
    const c = new pg.Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    const base = { databaseUrl: url, masterKey: Buffer.alloc(32, 9).toString('base64'), cookieSecure: false, requireMfa: true };
    app = await buildApp(loadConfig({ ...base, anthropicKey: 'test-key', aiMonthlyLimitUsd: 1, aiTotalLimitUsd: 100 }), { logger: false });
    capped = await buildApp(loadConfig({ ...base, anthropicKey: 'test-key', aiMonthlyLimitUsd: 100, aiTotalLimitUsd: 3 }), { logger: false });
    keyless = await buildApp(loadConfig({ ...base, anthropicKey: '' }), { logger: false });
    const { hashPassword } = await import('../src/security/crypto.js');
    ids.co = (await app.pg.query("INSERT INTO companies(code,name,base_currency) VALUES ('ai','Ai Mills','PKR') RETURNING id")).rows[0].id;
    await app.pg.query("INSERT INTO users(company_id,email,name,role,password_hash) VALUES ($1,'boss@ai.test','Boss','superadmin',$2)", [ids.co, await hashPassword('Temp-Boss-Pass-001')]);
    await onboard('boss', 'boss@ai.test', 'Temp-Boss-Pass-001');
    const v = JSON.parse((await call('boss', 'POST', '/api/users', { email: 'view@ai.test', name: 'Viewer', role: 'viewer' })).body);
    await onboard('view', 'view@ai.test', v.temporaryPassword);
    const pr = JSON.parse((await call('boss', 'POST', '/api/users', { email: 'prep@ai.test', name: 'Preparer', role: 'preparer' })).body);
    await onboard('prep', 'prep@ai.test', pr.temporaryPassword);
});
test.after(async () => { await app?.close(); await keyless?.close(); await capped?.close(); upstream?.close(); delete process.env.ANTHROPIC_BASE_URL; });

test('cost: tokens priced per model, cache reads at a tenth, long Haiku prompts at the higher rate', () => {
    const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);
    near(costOf('claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6 }), 0.005 + 0.5);
    near(costOf('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 0.2 + 2.5);
    near(costOf('claude-haiku-5-5', { input_tokens: 200000, output_tokens: 0 }), 0.1, 'over 100K: $0.50 per million');
    near(costOf('some-new-model', { input_tokens: 1e6, output_tokens: 0 }), 4, 'an unknown model is priced high');
    near(costOf('claude-sonnet-5-5', { iterations: [{ model: 'claude-sonnet-5-5', input_tokens: 1e6 }, { model: 'claude-opus-5-5', input_tokens: 1e6 }] }), 6, 'each attempt counts');
});

test('a reply after a hand-over keeps text but not the declined model’s reasoning or tool calls', () => {
    const c = [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }, { type: 'tool_use', id: 't' }, { type: 'fallback', from: {}, to: {} }, { type: 'thinking', thinking: '' }, { type: 'text', text: 'b' }];
    assert.deepEqual(echoable(c).map(b => b.type), ['text', 'thinking', 'text']);
    assert.equal(echoable(c.slice(0, 3)).length, 3, 'unchanged without a hand-over');
});

test('without a key the server says AI is not set up', async () => {
    jar.k = jar.boss;
    assert.equal(JSON.parse((await call('k', 'GET', '/api/ai/status', undefined, keyless)).body).available, false);
    const r = await call('k', 'POST', '/api/ai/messages', { messages: [{ role: 'user', content: 'x' }] }, keyless);
    assert.equal(r.status, 503); assert.equal(r.json().error, 'sampling_disabled');
});

test('only roles with ai.use may ask, and the request is checked', async () => {
    assert.equal((await ask('view')).status, 403);
    assert.equal((await ask('boss', { tier: 'expensive' })).status, 400);
    assert.equal((await call('boss', 'POST', '/api/ai/messages', { messages: [{ role: 'user', content: 'x' }], model: 'claude-opus-5-5' })).status, 400, 'the browser cannot choose the model');
    assert.equal(seen.length, 0);
});

test('routine requests: small model, low effort, streamed, cost recorded', async () => {
    const r = await ask('boss');
    assert.equal(r.status, 200);
    const ev = events(r.body);
    assert.equal(ev.filter(e => e.event === 'text').map(e => e.data.delta).join(''), 'Hello there');
    const done = ev.at(-1);
    assert.equal(done.event, 'done');
    assert.deepEqual([done.data.stop_reason, done.data.content[0].text], ['end_turn', 'Hello there']);
    const sent = seen.at(-1);
    assert.deepEqual([sent.body.model, sent.body.output_config.effort, sent.body.max_tokens], ['claude-haiku-5-5', 'low', 32000]);
    assert.equal(sent.body.fallbacks, undefined, 'Haiku has no server-side hand-over');
    assert.equal(sent.body.cache_control, undefined, 'one-off requests are not cached');
    const row = (await app.pg.query('SELECT * FROM ai_usage WHERE company_id=$1', [ids.co])).rows[0];
    // 20,000 input at $0.10, 10,000 cache reads at $0.01, 2,000 output at $0.50 per million
    assert.equal(Number(row.cost_usd), 0.0031);
    assert.deepEqual([row.model, row.tier, row.input_tokens, row.output_tokens, row.cache_read_tokens], ['claude-haiku-5-5', 'default', 20000, 2000, 10000]);
});

test('advisor turns: mid-size model, medium effort, history cached, hand-over on decline, tool calls returned', async () => {
    answer = () => ({ blocks: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'find_leases', input: { q: 'depot' } }], stop: 'tool_use' });
    const r = await ask('boss', { tier: 'complex', cache: true, system: 'You are an IFRS 16 advisor.', tools: [{ name: 'find_leases', description: 'Search leases', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }] });
    const done = events(r.body).at(-1).data;
    assert.equal(done.stop_reason, 'tool_use');
    assert.deepEqual(done.content[1], { type: 'tool_use', id: 'tu_1', name: 'find_leases', input: { q: 'depot' } });
    const sent = seen.at(-1);
    assert.deepEqual([sent.body.model, sent.body.output_config.effort, sent.body.cache_control.type, sent.body.fallbacks, sent.body.system], ['claude-sonnet-5-5', 'medium', 'ephemeral', 'default', 'You are an IFRS 16 advisor.']);
    assert.match(sent.beta, /server-side-fallback-2026-07-01/);
    answer = () => ({ blocks: [{ type: 'text', text: 'Hello there' }], stop: 'end_turn' });
});

test('upstream failures become codes the web app knows', async () => {
    answer = () => ({ status: 429 });
    const ev = events((await ask('boss')).body);
    assert.deepEqual(ev.at(-1), { event: 'error', data: { code: 'rate_limited' } });
    answer = () => ({ blocks: [{ type: 'text', text: 'Hello there' }], stop: 'end_turn' });
});

test('the monthly allowance stops further requests and the status shows the spending', async () => {
    await app.pg.query("INSERT INTO ai_usage(company_id,tier,model,cost_usd) VALUES ($1,'default','claude-haiku-5-5',1)", [ids.co]);
    const before = seen.length, r = await ask('boss');
    assert.equal(r.status, 429); assert.equal(r.json().error, 'ai_limit'); assert.match(r.json().message, /allowance/);
    assert.equal(seen.length, before, 'nothing was sent');
    const s = JSON.parse((await call('view', 'GET', '/api/ai/status')).body);
    assert.equal(s.available, true); assert.equal(s.limitUsd, 1); assert.ok(s.usedUsd >= 1);
    // Last month's spending does not count
    await app.pg.query("UPDATE ai_usage SET at = date_trunc('month', now()) - interval '1 day' WHERE company_id=$1", [ids.co]);
    assert.equal((await ask('boss')).status, 200);
});

test('the overall allowance, for all companies together, pauses AI for everyone', async () => {
    const other = (await app.pg.query("INSERT INTO companies(code,name,base_currency) VALUES ('other','Other Co','PKR') RETURNING id")).rows[0].id;
    jar.c = jar.boss;
    const cappedAsk = () => call('c', 'POST', '/api/ai/messages', { messages: [{ role: 'user', content: 'x' }] }, capped);
    assert.equal((await cappedAsk()).status, 200, 'under the overall allowance');
    await app.pg.query("INSERT INTO ai_usage(company_id,tier,model,cost_usd) VALUES ($1,'default','claude-haiku-5-5',3)", [other]);
    const before = seen.length, r = await cappedAsk();
    assert.equal(r.status, 429); assert.equal(r.json().error, 'ai_limit'); assert.match(r.json().message, /server/);
    assert.equal(seen.length, before, 'nothing was sent');
    const s = JSON.parse((await call('c', 'GET', '/api/ai/status', undefined, capped)).body);
    assert.equal(s.paused, true);
    assert.ok(s.usedUsd < 1, 'the other company’s spending is not shown');
});

test('allowances default to US$5 each', () => {
    const cfg = loadConfig({ databaseUrl: url, masterKey: Buffer.alloc(32, 9).toString('base64') });
    if (!process.env.AI_MONTHLY_LIMIT_USD) assert.equal(cfg.aiMonthlyLimitUsd, 5);
    if (!process.env.AI_TOTAL_MONTHLY_LIMIT_USD) assert.equal(cfg.aiTotalLimitUsd, 5);
});

test('advisor conversations: saved for the person who had them, replaced on each save, deleted on request', async () => {
    const conv = (turns, over = {}) => ({ title: 'Which leases end this year?', context: 'lease:DP-1', contextLabel: 'DP-1 City depot', turns, ...over });
    const t1 = [{ role: 'user', content: 'Context: lease DP-1...\n\nQuestion: Which leases end this year?', display: 'Which leases end this year?' }, { role: 'assistant', content: 'Two leases end in 2026.' }];
    let r = await call('boss', 'PUT', '/api/ai/conversations/c-one', conv(t1));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual([r.json().id, r.json().turns, r.json().context, r.json().contextLabel], ['c-one', 2, 'lease:DP-1', 'DP-1 City depot']);
    await call('boss', 'PUT', '/api/ai/conversations/c-two', conv(t1, { title: 'Second', context: 'portfolio', contextLabel: 'Portfolio' }));
    // Continuing the first one replaces its saved copy and makes it the most recent
    r = await call('boss', 'PUT', '/api/ai/conversations/c-one', conv([...t1, { role: 'user', content: 'And next year?' }, { role: 'assistant', content: 'One.' }]));
    assert.equal(r.json().turns, 4);
    const list = JSON.parse((await call('boss', 'GET', '/api/ai/conversations')).body);
    assert.deepEqual(list.map(c => [c.id, c.turns]), [['c-one', 4], ['c-two', 2]]);
    const full = JSON.parse((await call('boss', 'GET', '/api/ai/conversations/c-one')).body);
    assert.equal(full.turns[0].display, 'Which leases end this year?'); assert.equal(full.turns[3].content, 'One.');
    // Private: another user in the same company neither lists nor opens it; roles without AI cannot use history
    assert.deepEqual(JSON.parse((await call('prep', 'GET', '/api/ai/conversations')).body), []);
    assert.equal((await call('prep', 'GET', '/api/ai/conversations/c-one')).status, 404);
    await call('prep', 'DELETE', '/api/ai/conversations/c-one');
    assert.equal((await call('boss', 'GET', '/api/ai/conversations/c-one')).status, 200, 'someone else cannot delete it');
    assert.equal((await call('view', 'GET', '/api/ai/conversations')).status, 403);
    // Checked
    assert.equal((await call('boss', 'PUT', '/api/ai/conversations/bad%20id', conv(t1))).status, 400);
    assert.equal((await call('boss', 'PUT', '/api/ai/conversations/c-3', conv([]))).status, 400);
    assert.equal((await call('boss', 'PUT', '/api/ai/conversations/c-3', conv([{ role: 'system', content: 'x' }]))).status, 400);
    // Deleted
    assert.equal((await call('boss', 'DELETE', '/api/ai/conversations/c-one')).status, 200);
    assert.equal((await call('boss', 'GET', '/api/ai/conversations/c-one')).status, 404);
    assert.deepEqual(JSON.parse((await call('boss', 'GET', '/api/ai/conversations')).body).map(c => c.id), ['c-two']);
});

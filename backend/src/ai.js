// AI for the web app, called from the server so the company's Anthropic API key never reaches a browser.
// The browser runs the conversation (the advisor's tools read the leases it already holds) and sends each turn
// here. The server chooses the model and limits, keeps each company's monthly spending allowance, and records
// every request's tokens and cost. Replies stream back as server-sent events: "text" deltas, then "done" or "error".
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { HttpError } from './rbac.js';
import { requireAuth } from './auth.js';

/* Cost first: routine work (contract extraction, change suggestions, summaries) on the small model at low effort;
   the advisor and disclosure narratives on the mid-size model at medium effort. Both can be changed in .env. */
const tiers = cfg => ({
    default: { model: cfg.aiModelDefault, effort: 'low' },
    complex: { model: cfg.aiModelComplex, effort: 'medium' },
});
const MAX_TOKENS = 32000; // a ceiling only: requests are billed for what is produced

// US$ per million tokens [input, output]. Cache reads cost a tenth of input; cache writes a quarter more than input.
const PRICES = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };
const HAIKU_LONG = [0.50, 2.50]; // Claude Haiku 5.5 prompts over 100K tokens
// Models that can hand a declined request to another model on the server (Claude Haiku 5.5 cannot)
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

/** What one response cost, from its usage (each attempt, when a declined request was handed to another model). */
export function costOf(model, usage) {
    const parts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage];
    let total = 0;
    for (const u of parts) {
        const m = u.model || model, inp = u.input_tokens || 0, out = u.output_tokens || 0;
        const read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
        let [pi, po] = PRICES[m] || PRICES['claude-opus-5-5']; // an unknown model is priced high, never low
        if (m === 'claude-haiku-5-5' && inp + read + write > 100000) [pi, po] = HAIKU_LONG;
        total += (inp * pi + read * pi * 0.1 + write * pi * 1.25 + out * po) / 1e6;
    }
    return total;
}

/** The reply as it may be sent back on the next turn: after a hand-over to another model, the declined model's
    reasoning and tool calls from before the switch are left out (and the switch marker itself). */
export function echoable(content) {
    const last = content.map(b => b.type).lastIndexOf('fallback');
    if (last < 0) return content;
    const internal = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
    return content.filter((b, i) => i > last || (i < last && !internal.has(b.type)));
}

const block = z.object({ type: z.string().max(40) }).passthrough(); // content blocks are checked by the API itself
const body = z.object({
    tier: z.enum(['default', 'complex']).default('default'),
    system: z.string().max(20000).optional(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string().min(1).max(600000), z.array(block).min(1).max(200)]) }).strict()).min(1).max(100),
    tools: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), description: z.string().max(4000), input_schema: z.object({ type: z.literal('object') }).passthrough() }).strict()).max(30).default([]),
    cache: z.boolean().default(false),
}).strict();

/* ---- Advisor conversations: each person's own, the most recent KEEP_CONVERSATIONS kept ---- */
const KEEP_CONVERSATIONS = 100;
const convId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const conversation = z.object({
    title: z.string().trim().min(1).max(200),
    context: z.string().max(300).default('portfolio'),
    contextLabel: z.string().max(300).default(''),
    turns: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(400000), display: z.string().max(20000).optional() }).strict()).min(1).max(200),
}).strict();
const iso = t => new Date(t).toISOString();
const summary = r => ({ id: r.id, title: r.title, context: r.context, contextLabel: r.context_label, turns: Number(r.n), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

/** This month's spending: the company's against its allowance, and the whole server's against the overall one
    (other companies' spending is not shown, only whether the overall allowance is used up). */
async function spending(db, cfg, companyId) {
    const r = (await db.query(`SELECT coalesce(sum(cost_usd) FILTER (WHERE company_id=$1), 0) AS used, coalesce(sum(cost_usd), 0) AS total
        FROM ai_usage WHERE at >= date_trunc('month', now())`, [companyId])).rows[0];
    const round = v => Math.round(Number(v) * 10000) / 10000;
    return { usedUsd: round(r.used), limitUsd: cfg.aiMonthlyLimitUsd, paused: Number(r.total) >= cfg.aiTotalLimitUsd };
}

/** An API failure as a code the web app knows (see AI_ERR in the web app), with a message fit to show. */
function aiError(e) {
    if (e instanceof Anthropic.APIUserAbortError) return { code: 'cancelled' };
    if (e instanceof Anthropic.RateLimitError) return { code: 'rate_limited' };
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { code: 'sampling_disabled', message: 'The server’s Anthropic API key was not accepted. Check ANTHROPIC_API_KEY.' };
    if (e instanceof Anthropic.BadRequestError) return /too long|too large|exceed/i.test(e.message) ? { code: 'prompt_too_large' } : { code: 'bad_request', message: 'The AI service did not accept the request.' };
    if (e instanceof Anthropic.APIError) return { code: 'ai_unavailable', message: 'The AI service is busy or unavailable. Try again in a moment.' };
    return { code: 'ai_failed', message: 'The AI request failed. Try again.' };
}

export function aiRoutes(app, cfg) {
    const client = cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
    const TIERS = tiers(cfg);

    app.get('/api/ai/status', { preHandler: requireAuth(cfg, null) }, async (req) => ({ available: !!client, ...(await spending(app.pg, cfg, req.user.company_id)) }));

    const mine = req => [req.user.company_id, req.user.id];
    app.get('/api/ai/conversations', { preHandler: requireAuth(cfg, 'ai.use') }, async (req) =>
        (await app.pg.query('SELECT id, title, context, context_label, jsonb_array_length(turns) AS n, created_at, updated_at FROM ai_conversations WHERE company_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT $3', [...mine(req), KEEP_CONVERSATIONS])).rows.map(summary));
    app.get('/api/ai/conversations/:id', { preHandler: requireAuth(cfg, 'ai.use') }, async (req) => {
        const r = (await app.pg.query('SELECT *, jsonb_array_length(turns) AS n FROM ai_conversations WHERE company_id=$1 AND user_id=$2 AND id=$3', [...mine(req), convId.parse(req.params.id)])).rows[0];
        if (!r) throw new HttpError(404, 'That conversation is no longer saved.', 'not_found');
        return { ...summary(r), turns: r.turns };
    });
    // Saved after each answer: the whole conversation, which replaces the saved copy
    app.put('/api/ai/conversations/:id', { preHandler: requireAuth(cfg, 'ai.use'), bodyLimit: 4 * 1024 * 1024 }, async (req) => {
        const id = convId.parse(req.params.id), b = conversation.parse(req.body);
        const r = (await app.pg.query(`INSERT INTO ai_conversations(company_id,user_id,id,title,context,context_label,turns) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (company_id,user_id,id) DO UPDATE SET title=EXCLUDED.title, context=EXCLUDED.context, context_label=EXCLUDED.context_label, turns=EXCLUDED.turns, updated_at=now()
            RETURNING id, title, context, context_label, jsonb_array_length(turns) AS n, created_at, updated_at`, [...mine(req), id, b.title, b.context, b.contextLabel, JSON.stringify(b.turns)])).rows[0];
        await app.pg.query(`DELETE FROM ai_conversations WHERE company_id=$1 AND user_id=$2 AND id NOT IN
            (SELECT id FROM ai_conversations WHERE company_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT $3)`, [...mine(req), KEEP_CONVERSATIONS]);
        return summary(r);
    });
    app.delete('/api/ai/conversations/:id', { preHandler: requireAuth(cfg, 'ai.use') }, async (req) => {
        await app.pg.query('DELETE FROM ai_conversations WHERE company_id=$1 AND user_id=$2 AND id=$3', [...mine(req), convId.parse(req.params.id)]);
        return { deleted: true };
    });

    // Scanned contracts arrive as page images, so this route takes larger bodies than the rest of the API
    app.post('/api/ai/messages', { preHandler: requireAuth(cfg, 'ai.use'), bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
        if (!client) throw new HttpError(503, 'AI is not set up on this server. Add ANTHROPIC_API_KEY to deploy/.env and restart.', 'sampling_disabled');
        const b = body.parse(req.body);
        const cid = req.user.company_id, spent = await spending(app.pg, cfg, cid);
        if (spent.usedUsd >= spent.limitUsd) throw new HttpError(429, `This company has used its AI allowance for the month (US$${spent.usedUsd.toFixed(2)} of US$${spent.limitUsd.toFixed(2)}). It starts again on the 1st.`, 'ai_limit');
        if (spent.paused) throw new HttpError(429, 'AI is paused until the 1st: this server has used its AI allowance for the month.', 'ai_limit');

        const t = TIERS[b.tier];
        const params = {
            model: t.model, max_tokens: MAX_TOKENS, output_config: { effort: t.effort }, messages: b.messages,
            ...(b.system ? { system: b.system } : {}), ...(b.tools.length ? { tools: b.tools } : {}),
            // Conversations resend their history each turn: cache it, so repeated context costs a tenth
            ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        };
        const ctl = new AbortController();
        reply.raw.on('close', () => { if (!reply.raw.writableFinished) ctl.abort(); }); // the person stopped or left
        const stream = FALLBACK_MODELS.has(t.model)
            ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal: ctl.signal })
            : client.messages.stream(params, { signal: ctl.signal });

        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
        const send = (event, data) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        stream.on('text', delta => send('text', { delta }));
        try {
            const msg = await stream.finalMessage();
            const u = msg.usage || {}, cost = costOf(msg.model || t.model, u);
            await app.pg.query('INSERT INTO ai_usage(company_id,user_id,tier,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [cid, req.user.id, b.tier, msg.model || t.model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, cost]);
            send('done', { content: echoable(msg.content), stop_reason: msg.stop_reason, model: msg.model, costUsd: Math.round(cost * 1e6) / 1e6 });
        } catch (e) {
            const err = aiError(e);
            if (err.code !== 'cancelled') req.log.warn({ err: e.message, status: e.status }, 'AI request failed');
            send('error', err);
        }
        reply.raw.end();
    });
}

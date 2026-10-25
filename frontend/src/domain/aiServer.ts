/* ======================================================================
   AI through the company server (/api/ai). The server holds the Anthropic
   API key, chooses the model and keeps the company's monthly allowance.
   The conversation runs here: when Claude asks for one of the advisor's
   tools, the tool runs in this browser on the leases already loaded and
   its answer goes back on the next turn. Same shape as the Claude
   viewer's sample capability, so the AI features work unchanged.
   ====================================================================== */
import { api, ApiError } from '../api/client';
import { errMessage } from '../utils/format';

export interface AiStatus { available: boolean; usedUsd: number; limitUsd: number; paused: boolean }
export const aiStatus = (): Promise<AiStatus> => api.get<AiStatus>('/ai/status');

type Block = { type: string; [k: string]: unknown };
type Message = { role: 'user' | 'assistant'; content: string | Block[] };
interface Reply { content: Block[]; stop_reason: string | null }

const URL_ = import.meta.env.BASE_URL.replace(/\/$/, '') + '/api/ai/messages';
const MAX_TURNS = 12;
const JSON_RULE = 'Reply with one JSON value only: no words before or after it and no code fences.';
const cancelled = () => ({ code: 'cancelled' });

/** One turn on the server, reading the reply as it streams. */
async function turn(body: unknown, signal: AbortSignal | undefined, onDelta: (d: string) => void): Promise<Reply> {
    let res: Response;
    try {
        res = await fetch(URL_, { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'lease-manager', 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch {
        throw signal?.aborted ? cancelled() : new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
    }
    if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new ApiError(res.status, d.error || 'error', d.message || 'The AI request failed. Try again.');
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', done: Reply | null = null;
    for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch { throw signal?.aborted ? cancelled() : new ApiError(0, 'network', 'The connection to the server was lost.'); }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const part = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(part)?.[1], data = /^data: (.*)$/m.exec(part)?.[1];
            if (!ev || data === undefined) continue;
            const d = JSON.parse(data) as { delta?: string; code?: string; message?: string } & Reply;
            if (ev === 'text') onDelta(d.delta || '');
            else if (ev === 'done') done = d;
            else if (ev === 'error') throw d.code === 'cancelled' ? cancelled() : new ApiError(502, d.code || 'ai_failed', d.message || '');
        }
    }
    if (!done) throw signal?.aborted ? cancelled() : new ApiError(502, 'ai_failed', 'The AI reply was cut off. Try again.');
    if (done.stop_reason === 'refusal') throw { code: 'refused' };
    return done;
}

async function base64(b: Blob): Promise<string> {
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
const imageBlock = async (b: Blob): Promise<Block> => ({ type: 'image', source: { type: 'base64', media_type: b.type || 'image/png', data: await base64(b) } });
const textOf = (content: Block[]) => content.filter(b => b.type === 'text').map(b => String(b.text || '')).join('');

/** Reads a JSON reply, allowing for a stray code fence or words around it. */
function parseJson(text: string): unknown {
    const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(t); } catch { /* look for the value inside */ }
    const start = t.search(/[[{]/), end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* not JSON */ } }
    throw { code: 'invalid_json' };
}

async function run(input: string | SampleMessage[], o: SampleOptions = {}, system?: string): Promise<{ text: string }> {
    const messages: Message[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input.map(m => ({ role: m.role, content: m.content }));
    if (o.images && o.images.length) {
        const last = messages[messages.length - 1];
        last.content = [...await Promise.all(o.images.map(imageBlock)), { type: 'text', text: String(last.content) }];
    }
    const tools = (o.tools || []).map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const byName = new Map((o.tools || []).map(t => [t.name, t]));
    const said: string[] = [];
    for (let n = 0; n < MAX_TURNS; n++) {
        const before = said.length ? said.join('\n\n') + '\n\n' : '';
        let now = '';
        const r = await turn({ tier: o.modelTier === 'complex' ? 'complex' : 'default', ...(system ? { system } : {}), messages, tools, cache: tools.length > 0 || messages.length > 1 },
            o.signal, d => { now += d; if (o.onText) o.onText({ text: before + now }); });
        const text = textOf(r.content);
        if (text) said.push(text);
        const calls = r.content.filter(b => b.type === 'tool_use');
        // Tools run only on a complete request for them (never on a reply cut off at its length limit)
        if (r.stop_reason !== 'tool_use' || !calls.length) return { text: said.join('\n\n') };
        messages.push({ role: 'assistant', content: r.content });
        const results = await Promise.all(calls.map(async (c): Promise<Block> => {
            const tool = byName.get(String(c.name));
            try {
                if (!tool) throw new Error(`There is no tool called ${String(c.name)}.`);
                const out = await tool.execute((c.input || {}) as Record<string, unknown>);
                return { type: 'tool_result', tool_use_id: c.id, content: typeof out === 'string' ? out : JSON.stringify(out ?? null) };
            } catch (e) {
                return { type: 'tool_result', tool_use_id: c.id, content: errMessage(e), is_error: true };
            }
        }));
        messages.push({ role: 'user', content: results });
    }
    throw new ApiError(502, 'ai_failed', 'The advisor took too many steps. Ask a narrower question.');
}

/** The server's AI in the shape of the sample capability. */
export function serverSample(): SampleCapability {
    const s = ((input: string | SampleMessage[], o?: SampleOptions) => run(input, o)) as SampleCapability;
    s.json = async (input, o) => parseJson((await run(input, o, JSON_RULE)).text);
    s.limits = async () => ({ images: { maxPerCall: 8 } });
    return s;
}

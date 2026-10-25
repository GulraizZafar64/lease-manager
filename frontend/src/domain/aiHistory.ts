/* ======================================================================
   The AI advisor's saved conversations, for the person who had them.
   With the company server they are kept there (private to the user);
   otherwise in this browser. Saved after each answer; the most recent
   100 are kept.
   ====================================================================== */
import { api } from '../api/client';
import { Store } from './store';
import { companyKey } from './platform';

export interface SavedTurn { role: 'user' | 'assistant'; content: string; display?: string }
export interface ConversationSummary { id: string; title: string; context: string; contextLabel: string; turns: number; createdAt: string; updatedAt: string }
export interface Conversation extends Omit<ConversationSummary, 'turns' | 'createdAt' | 'updatedAt'> { turns: SavedTurn[]; createdAt?: string; updatedAt?: string }

const KEEP = 100;
const onServer = () => Store.mode === 'api';
const key = () => companyKey('ai.conversations.' + Store.actorId());

function readLocal(): Conversation[] {
    try { const v = JSON.parse(localStorage.getItem(key()) || '[]') as Conversation[]; return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeLocal(list: Conversation[]): void {
    // A browser's storage is small: when it is full, drop the oldest conversations until this one fits
    for (let keep = list.slice(0, KEEP); ; keep = keep.slice(0, -1)) {
        try { localStorage.setItem(key(), JSON.stringify(keep)); return; } catch { if (!keep.length) return; /* unavailable */ }
    }
}
const brief = (c: Conversation): ConversationSummary => ({ id: c.id, title: c.title, context: c.context, contextLabel: c.contextLabel, turns: c.turns.length, createdAt: c.createdAt || '', updatedAt: c.updatedAt || '' });

export const History = {
    /** Where conversations are kept, for the people reading the list. */
    where: (): string => onServer() ? 'Saved on the company server for you only.' : 'Saved in this browser for you only.',
    async list(): Promise<ConversationSummary[]> {
        if (onServer()) return api.get<ConversationSummary[]>('/ai/conversations');
        return readLocal().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).map(brief);
    },
    async get(id: string): Promise<Conversation | null> {
        if (onServer()) return api.get<Conversation>('/ai/conversations/' + encodeURIComponent(id)).catch(() => null);
        return readLocal().find(c => c.id === id) || null;
    },
    async save(c: Conversation): Promise<void> {
        const body = { title: c.title, context: c.context, contextLabel: c.contextLabel, turns: c.turns };
        if (onServer()) { await api.put('/ai/conversations/' + encodeURIComponent(c.id), body); return; }
        const now = new Date().toISOString(), list = readLocal(), old = list.find(x => x.id === c.id);
        writeLocal([{ ...c, createdAt: old?.createdAt || now, updatedAt: now }, ...list.filter(x => x.id !== c.id)]);
    },
    async remove(id: string): Promise<void> {
        if (onServer()) { await api.del('/ai/conversations/' + encodeURIComponent(id)); return; }
        writeLocal(readLocal().filter(c => c.id !== id));
    },
};

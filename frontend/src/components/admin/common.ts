/* Helpers shared by the Administration tabs. */
import { Store } from '../../domain/store';
import { audit } from '../../domain/enterprise';
import { xmlEsc } from '../../domain/erp';
import { toast } from '../../utils/uiStore';
import type { Lease } from '../../types/lease';

export const saveSettingsAudited = async (what: string): Promise<void> => { if (!await Store.saveSettings()) return; audit('settings', what); toast('Saved'); };

/* ---- Encrypted backups: AES-256-GCM, key from the passphrase by PBKDF2 (250,000 iterations) ---- */
export interface EncryptedBackup { format: string; cipher: string; kdf: string; salt: string; iv: string; data: string }
async function deriveKey(pw: string, salt: Uint8Array): Promise<CryptoKey> { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
const b64 = (buf: Uint8Array): string => btoa(String.fromCharCode(...buf)), unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function encryptText(text: string, pw: string): Promise<EncryptedBackup> { const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), key = await deriveKey(pw, salt); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)); let s = ''; const u = new Uint8Array(ct); for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return { format: 'IFRS16-backup', cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256-250000', salt: b64(salt), iv: b64(iv), data: btoa(s) }; }
export async function decryptText(o: Pick<EncryptedBackup, 'salt' | 'iv' | 'data'>, pw: string): Promise<string> { const key = await deriveKey(pw, unb64(o.salt)); const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.data)); return new TextDecoder().decode(pt); }

/* ---- Portfolio exchange: XML ---- */
export function leasesToXML(list: Lease[]): string {
    const node = (k: string, v: unknown): string => v === null || v === undefined || v === '' ? '' : typeof v === 'object' ? (Array.isArray(v) ? `<${k}>${v.map(x => node('item', x)).join('')}</${k}>` : `<${k}>${Object.entries(v as Record<string, unknown>).map(([a, b]) => node(a, b)).join('')}</${k}>`) : `<${k}>${xmlEsc(v)}</${k}>`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Leases generated="${new Date().toISOString()}">${list.map(l => node('Lease', l)).join('\n')}</Leases>`;
}

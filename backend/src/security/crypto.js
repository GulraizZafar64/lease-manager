import crypto from 'node:crypto';

// Passwords: scrypt (memory-hard, built into Node; no native add-ons to compile on-premises).
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const key = await new Promise((res, rej) => crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => e ? rej(e) : res(k)));
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
    const [alg, N, r, p, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const got = await new Promise((res, rej) => crypto.scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
    return crypto.timingSafeEqual(expected, got);
}
// Dummy hash so failed lookups take the same time as real checks (no user enumeration by timing)
let dummy; export async function dummyVerify(pw) { dummy = dummy || await hashPassword('dummy-password-for-timing'); await verifyPassword(pw, dummy); return false; }

export function passwordProblems(pw, minLen, context = []) {
    const p = [];
    if (typeof pw !== 'string' || pw.length < minLen) p.push(`at least ${minLen} characters`);
    if (pw && pw.length > 200) p.push('at most 200 characters');
    if (pw && new Set(pw).size < 6) p.push('more variety of characters');
    const low = String(pw).toLowerCase();
    if (['password', 'qwerty', '123456', 'admin', 'letmein', 'welcome'].some(w => low.includes(w))) p.push('no common words such as "password"');
    if (context.filter(Boolean).some(c => c.length >= 4 && low.includes(String(c).toLowerCase()))) p.push('not containing your name or email');
    return p;
}

// AES-256-GCM for secrets at rest (MFA seeds). Format: v1.iv.tag.ciphertext (base64)
export function encrypt(plain, keyB64) {
    const key = Buffer.from(keyB64, 'base64'), iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
export function decrypt(blob, keyB64) {
    const [v, iv, tag, ct] = String(blob).split('.');
    if (v !== 'v1') throw new Error('Unknown ciphertext version');
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

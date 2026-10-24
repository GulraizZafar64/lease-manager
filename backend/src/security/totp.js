import crypto from 'node:crypto';
// RFC 6238 time-based one-time passwords (Google/Microsoft Authenticator compatible), RFC 4648 base32.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
    let bits = 0, val = 0, out = '';
    for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
}
export function base32Decode(s) {
    const clean = String(s).toUpperCase().replace(/=+$|\s+/g, '');
    let bits = 0, val = 0; const out = [];
    for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('Invalid base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    return Buffer.from(out);
}
export const newSecret = () => base32Encode(crypto.randomBytes(20));
export function hotp(secretB32, counter, digits = 6, algo = 'sha1') {
    const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac(algo, base32Decode(secretB32)).update(buf).digest();
    const o = h[h.length - 1] & 15;
    const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
    return String(code).padStart(digits, '0');
}
export const timeStep = (t = Date.now(), period = 30) => Math.floor(t / 1000 / period);
// Accepts the current step and one either side (clock drift). Returns the matched step, or null.
export function verifyTotp(secretB32, code, { t = Date.now(), window = 1, lastStep = null } = {}) {
    if (!/^\d{6}$/.test(String(code || ''))) return null;
    const now = timeStep(t);
    for (let w = -window; w <= window; w++) {
        const step = now + w;
        if (lastStep !== null && step <= lastStep) continue; // each code usable once
        const a = Buffer.from(hotp(secretB32, step)), b = Buffer.from(String(code));
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step;
    }
    return null;
}
export const otpauthUrl = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

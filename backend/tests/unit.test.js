import test from 'node:test';
import assert from 'node:assert/strict';
import { hotp, base32Encode, verifyTotp, timeStep } from '../src/security/totp.js';
import { hashPassword, verifyPassword, encrypt, decrypt, passwordProblems } from '../src/security/crypto.js';
import VALIDATION from '../src/engine/validation.js';

test('TOTP matches RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']])
        assert.equal(hotp(secret, Math.floor(t / 30), 8), code);
});
test('TOTP rejects reuse of an accepted code', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890')), now = Date.now();
    const code = hotp(secret, timeStep(now));
    const step = verifyTotp(secret, code, { t: now });
    assert.equal(step, timeStep(now));
    assert.equal(verifyTotp(secret, code, { t: now, lastStep: step }), null);
    assert.equal(verifyTotp(secret, '000000x', { t: now }), null);
});
test('passwords hash and verify; wrong password fails', async () => {
    const h = await hashPassword('correct horse battery staple');
    assert.ok(await verifyPassword('correct horse battery staple', h));
    assert.equal(await verifyPassword('Correct horse battery staple', h), false);
    assert.notEqual(h, await hashPassword('correct horse battery staple')); // salted
});
test('password policy', () => {
    assert.ok(passwordProblems('short', 12).length);
    assert.ok(passwordProblems('MyPassword123456', 12).length);
    assert.ok(passwordProblems('ali.hassan.2026!!', 12, ['Ali Hassan', 'ali.hassan']).length);
    assert.equal(passwordProblems('Kite-Ledger-Monsoon-42', 12).length, 0);
});
test('AES-GCM round trip and tamper detection', () => {
    const k = Buffer.alloc(32, 7).toString('base64'), c = encrypt('JBSWY3DPEHPK3PXP', k);
    assert.equal(decrypt(c, k), 'JBSWY3DPEHPK3PXP');
    const parts = c.split('.'); parts[3] = Buffer.from('tampered!').toString('base64');
    assert.throws(() => decrypt(parts.join('.'), k));
});
test('calculation engine reproduces all reference examples', () => {
    const r = VALIDATION.run();
    for (const c of r) assert.ok(c.pass, `${c.id} failed: ${c.rows.filter(x => !x.pass).map(x => x.label).join(', ')}`);
    assert.equal(r.length, 14);
});

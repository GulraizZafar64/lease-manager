// Configuration from environment variables. Fails fast on anything unsafe.
const env = process.env;
function required(name) {
    const v = env[name];
    if (!v) throw new Error(`Missing required setting ${name}. See .env.example.`);
    return v;
}
export function loadConfig(overrides = {}) {
    const cfg = {
        port: Number(env.PORT || 8080),
        host: env.HOST || '0.0.0.0',
        databaseUrl: env.DATABASE_URL,
        // 32-byte key, base64. Encrypts MFA secrets. Generate with: openssl rand -base64 32
        masterKey: env.MASTER_KEY,
        sessionHours: Number(env.SESSION_HOURS || 10),
        idleMinutes: Number(env.SESSION_IDLE_MINUTES || 30),
        cookieSecure: env.COOKIE_SECURE !== 'false',
        trustProxy: env.TRUST_PROXY === 'true',
        maxFailedLogins: Number(env.MAX_FAILED_LOGINS || 5),
        lockMinutes: Number(env.LOCK_MINUTES || 15),
        // Two-step sign-in (authenticator code) for everyone, company users and the platform owner. Only the
        // exact value false switches it off; keys people already set up are kept and used again when it is back on.
        requireMfa: env.REQUIRE_MFA !== 'false',
        passwordMinLength: Number(env.PASSWORD_MIN_LENGTH || 12),
        orgName: env.ORG_NAME || 'Lease Manager',
        logLevel: env.LOG_LEVEL || 'info',
        ...overrides
    };
    if (!cfg.databaseUrl) required('DATABASE_URL');
    if (!cfg.masterKey) required('MASTER_KEY');
    if (Buffer.from(cfg.masterKey, 'base64').length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
    return cfg;
}

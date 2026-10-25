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
        // AI: off unless a key is set. Monthly allowances in US$: for each company, and for the whole server.
        anthropicKey: env.ANTHROPIC_API_KEY || '',
        aiMonthlyLimitUsd: Number(env.AI_MONTHLY_LIMIT_USD || 5),
        aiTotalLimitUsd: Number(env.AI_TOTAL_MONTHLY_LIMIT_USD || 5),
        aiModelDefault: env.AI_MODEL_DEFAULT || 'claude-haiku-5-5',
        aiModelComplex: env.AI_MODEL_COMPLEX || 'claude-sonnet-5-5',
        ...overrides
    };
    if (!cfg.databaseUrl) required('DATABASE_URL');
    if (!cfg.masterKey) required('MASTER_KEY');
    if (Buffer.from(cfg.masterKey, 'base64').length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
    return cfg;
}

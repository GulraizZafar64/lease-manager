import { loadConfig } from './config.js';
import { buildApp } from './app.js';
const cfg = loadConfig();
const app = await buildApp(cfg);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
await app.listen({ port: cfg.port, host: cfg.host });

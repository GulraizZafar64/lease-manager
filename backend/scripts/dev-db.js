// Local development database: a real PostgreSQL 16 server from the embedded-postgres
// package, kept in ./.pgdata and listening on localhost only. Not for production
// (production uses deploy/docker-compose.yml). Stop it with Ctrl+C.
//   npm run db:dev
// Creates two databases on first run: leasedb (development) and leasedb_test (rebuilt by npm test).
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const databaseDir = path.join(root, '.pgdata');
const port = Number(process.env.DEV_DB_PORT || 5433);
const user = 'lease', password = 'lease-dev-only';

const pg = new EmbeddedPostgres({
    databaseDir, port, user, password, persistent: true,
    postgresFlags: ['-c', 'listen_addresses=localhost'],
    onLog: () => {},
    onError: e => console.error(String(e).trim()),
});

const fresh = !existsSync(path.join(databaseDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) { await pg.createDatabase('leasedb'); await pg.createDatabase('leasedb_test'); }

console.log(`PostgreSQL running on localhost:${port}${fresh ? ' (new cluster created)' : ''}
  development: postgres://${user}:${password}@localhost:${port}/leasedb
  tests:       postgres://${user}:${password}@localhost:${port}/leasedb_test
Press Ctrl+C to stop.`);

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30); // keep running until stopped

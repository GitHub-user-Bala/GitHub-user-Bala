import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { resolve } from 'node:path';

async function main() {
  const db = await PGlite.create(resolve('.local-db'));
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 54329, maxConnections: 20 });
  server.addEventListener('error', error => console.error('Local database socket error:', error));
  await server.start();
  console.log('Local PGlite ready on 127.0.0.1:54329. Development only: PostgreSQL WASM, not native concurrency validation.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await db.close();
  };
  process.once('SIGINT', () => void stop().catch(error => { console.error(error); process.exitCode = 1; }));
  process.once('SIGTERM', () => void stop().catch(error => { console.error(error); process.exitCode = 1; }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

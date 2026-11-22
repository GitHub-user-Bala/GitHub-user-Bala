import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { io } from 'socket.io-client';
import { Db } from '../apps/api/src/db';
import { identitySchema, inviteSchema, listSummarySchema, snapshotSchema } from '../packages/contracts/src';

process.env.DATABASE_URL ??= 'postgresql://kart:kart_local@localhost:54329/kart';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'synthetic-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'synthetic-client-secret';

test('PostgreSQL-backed Kart API', async t => {
  const { createApp } = await import('../apps/api/src/main');
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const db = app.get(Db);
  const { Auth } = await import('../apps/api/src/auth');
  const auth = app.get(Auth);
  const users: string[] = [];
  type Session = { cookie: string; csrf: string; id: string };
  async function request(path: string, method = 'GET', body?: unknown, session?: Session,
    extra: Record<string, string> = {}) {
    return fetch(`${base}/api${path}`, {
      method, redirect: 'manual', headers: {
        Origin: process.env.WEB_ORIGIN!, 'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function guest() {
    const response = await request('/auth/guest', 'POST');
    assert.equal(response.status, 201);
    const identity = identitySchema.parse(await response.json());
    users.push(identity.id);
    return { cookie: response.headers.getSetCookie()[0].split(';')[0], csrf: identity.csrfToken, id: identity.id };
  }
  try {
    const owner = await guest(), viewer = await guest(), outsider = await guest();
    const listResponse = await request('/lists', 'POST', { title: `API ${randomUUID()}` }, owner);
    assert.equal(listResponse.status, 201);
    const list = listSummarySchema.parse(await listResponse.json());
    const path = `/lists/${list.id}`;
    let code = '';
    await t.test('Google callback binds state, nonce and PKCE, rejects expiry, rotates guest sessions', async () => {
      const source = await guest();
      const start = await request('/auth/google', 'GET', undefined, source);
      assert.equal(start.status, 302);
      const authorization = new URL(start.headers.get('location')!);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      const pendingCookie = start.headers.getSetCookie().find(value => value.startsWith('kart-oauth='))!.split(';')[0];
      const callbackSession = { ...source, cookie: `${source.cookie}; ${pendingCookie}` };
      const mock = t.mock.method(auth, 'verifyGoogle', async (code: string, verifier: string, nonce: string) => {
        assert.equal(code, 'synthetic-code');
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
        assert.equal(nonce, authorization.searchParams.get('nonce'));
        return { subject: `callback-${source.id}`, name: 'Verified family member' };
      });
      assert.equal((await request('/auth/google/callback?state=wrong&code=synthetic-code', 'GET', undefined, callbackSession)).status, 403);
      const pending = JSON.parse(Buffer.from(pendingCookie.split('=')[1], 'base64url').toString()) as Record<string, unknown>;
      const expiredCookie = `kart-oauth=${Buffer.from(JSON.stringify({ ...pending, issuedAt: 0 })).toString('base64url')}`;
      const callback = `/auth/google/callback?state=${authorization.searchParams.get('state')}&code=synthetic-code`;
      assert.equal((await request(callback, 'GET', undefined, { ...source, cookie: `${source.cookie}; ${expiredCookie}` })).status, 403);
      assert.equal(mock.mock.callCount(), 0);
      const finish = await request(callback, 'GET', undefined, callbackSession);
      assert.equal(finish.status, 302);
      assert.equal(mock.mock.callCount(), 1);
      const cookie = finish.headers.getSetCookie().find(value => value.startsWith('kart='))!.split(';')[0];
      const current = identitySchema.parse(await (await request('/auth/me', 'GET', undefined, { ...source, cookie })).json());
      assert.equal(current.id, source.id);
      assert.equal(current.kind, 'google');
      assert.notEqual(current.csrfToken, source.csrf);
      assert.equal((await request('/auth/me', 'GET', undefined, source)).status, 401);
      mock.mock.restore();
    });
    await t.test('guest sharing blocked; Google owner generates expiring random code', async () => {
      assert.equal((await request(`${path}/invite`, 'POST', {}, owner)).status, 403);
      await db.user.update({ where: { id: owner.id }, data: { kind: 'google', googleSubject: `test-${randomUUID()}` } });
      const response = await request(`${path}/invite`, 'POST', {}, owner);
      assert.equal(response.status, 201);
      const invite = inviteSchema.parse(await response.json());
      assert.match(invite.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
      assert.ok(new Date(invite.expiresAt).getTime() > Date.now() + 6 * 86400_000);
      code = invite.code;
      const stored = await db.listInvite.findFirstOrThrow({ where: { listId: list.id } });
      assert.notEqual(stored.digest, code);
    });
    await t.test('codes grant viewer membership, never edit or cross-list access', async () => {
      assert.equal((await request('/lists/join', 'POST', { code }, viewer)).status, 201);
      const snapshot = snapshotSchema.parse(await (await request(path, 'GET', undefined, viewer)).json());
      assert.equal(snapshot.role, 'viewer');
      assert.deepEqual(snapshot.members, []);
      assert.equal((await request(path, 'GET', undefined, outsider)).status, 404);
      assert.equal((await request(`${path}/items`, 'POST', {
        name: 'Milk', packCount: 2, amount: '500', unit: 'ml',
      }, viewer, { 'Idempotency-Key': randomUUID() })).status, 403);
      assert.equal((await request(path, 'PATCH', { title: 'Hijack' }, viewer)).status, 403);
      assert.equal((await request(`${path}/members/${viewer.id}`, 'PATCH', { role: 'editor' }, owner)).status, 200);
      assert.equal((await request(`${path}/invite`, 'POST', {}, viewer)).status, 403);
    });
    await t.test('realtime room authorization and permission events do not disclose unrelated lists', async () => {
      const { Live } = await import('../apps/api/src/live');
      const sockets = [owner, viewer, outsider].map(session => io(base, {
        transports: ['websocket'], reconnection: false,
        extraHeaders: { Cookie: session.cookie, Origin: process.env.WEB_ORIGIN! },
      }));
      try {
        await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Socket connection timed out.')), 5000);
          socket.once('connect', () => { clearTimeout(timer); resolve(); });
          socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        })));
        assert.deepEqual(await sockets[0].timeout(5000).emitWithAck('subscribe', list.id), { ok: true });
        assert.deepEqual(await sockets[1].timeout(5000).emitWithAck('subscribe', list.id), { ok: true });
        assert.deepEqual(await sockets[2].timeout(5000).emitWithAck('subscribe', list.id), { ok: false });
        const events: unknown[][] = [[], [], []];
        sockets.forEach((socket, index) => {
          socket.on('permissions.changed', value => events[index].push(value));
          socket.on('list.changed', value => events[index].push(value));
        });
        app.get(Live).permissions(list.id);
        app.get(Live).changed(list.id, 100);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(events[0].length, 2);
        assert.equal(events[1].length, 2);
        assert.equal(events[2].length, 0);
        await request(`${path}/members/${viewer.id}`, 'DELETE', undefined, owner);
        assert.deepEqual(await sockets[1].timeout(5000).emitWithAck('subscribe', list.id), { ok: false });
        assert.equal((await request('/lists/join', 'POST', { code }, viewer)).status, 201);
        await request(`${path}/members/${viewer.id}`, 'PATCH', { role: 'editor' }, owner);
      } finally { sockets.forEach(socket => socket.disconnect()); }
    });
    let itemId = '';
    const quantity = { name: 'Milk', packCount: 2, amount: '500', unit: 'ml' };
    await t.test('writes validate input and are idempotent', async () => {
      assert.equal((await request(`${path}/items`, 'POST', { ...quantity, packCount: -1 }, owner,
        { 'Idempotency-Key': randomUUID() })).status, 400);
      const key = randomUUID();
      const response = await request(`${path}/items`, 'POST', quantity, viewer, { 'Idempotency-Key': key });
      assert.equal(response.status, 201);
      const result = await response.json() as { id: string };
      itemId = result.id;
      const retry = await request(`${path}/items`, 'POST', quantity, viewer, { 'Idempotency-Key': key });
      assert.deepEqual(await retry.json(), result);
      assert.equal(await db.listItem.count({ where: { listId: list.id } }), 1);
      assert.equal((await request(`${path}/items`, 'POST', { ...quantity, name: 'Different' }, viewer,
        { 'Idempotency-Key': key })).status, 409);
    });
    await t.test('concurrent stale writes conflict instead of overwriting', async () => {
      const results = await Promise.all(['purchased', 'unavailable'].map(status => request(`${path}/items/${itemId}`, 'PATCH',
        { ...quantity, version: 1, status }, viewer)));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const item = await db.listItem.findUniqueOrThrow({ where: { id: itemId } });
      assert.equal(item.version, 2);
      assert.equal((await request(`${path}/items/${itemId}`, 'DELETE', { version: 1 }, viewer)).status, 409);
      await request(`${path}/items/${itemId}`, 'PATCH', { ...quantity, version: item.version, status: 'unavailable' }, viewer);
    });
    await t.test('replacement selection preserves original and duplicate retries are safe', async () => {
      const alternativeKey = randomUUID();
      const response = await request(`${path}/items/${itemId}/alternatives`, 'POST', { ...quantity, name: 'Oat milk' }, viewer,
        { 'Idempotency-Key': alternativeKey });
      assert.equal(response.status, 201);
      const alternative = await response.json() as { id: string };
      assert.deepEqual(await (await request(`${path}/items/${itemId}/alternatives`, 'POST', { ...quantity, name: 'Oat milk' }, viewer,
        { 'Idempotency-Key': alternativeKey })).json(), alternative);
      const item = await db.listItem.findUniqueOrThrow({ where: { id: itemId } });
      const body = { alternativeId: alternative.id, version: item.version }, key = randomUUID();
      const result = await request(`${path}/items/${itemId}/select`, 'POST', body, viewer, { 'Idempotency-Key': key });
      assert.equal(result.status, 201);
      const replacement = await result.json();
      assert.deepEqual(await (await request(`${path}/items/${itemId}/select`, 'POST', body, viewer,
        { 'Idempotency-Key': key })).json(), replacement);
      assert.equal(await db.listItem.count({ where: { originalItemId: itemId } }), 1);
      assert.equal((await db.listItem.findUniqueOrThrow({ where: { id: itemId } })).status, 'unavailable');
      assert.equal((await request(`${path}/items/${itemId}/select`, 'POST', body, viewer,
        { 'Idempotency-Key': randomUUID() })).status, 409);
      const ownList = listSummarySchema.parse(await (await request('/lists', 'POST', { title: 'Other' }, outsider)).json());
      assert.equal((await request(`/lists/${ownList.id}/items/${itemId}`, 'PATCH',
        { ...quantity, version: item.version, status: 'needed' }, outsider)).status, 404);
    });
    await t.test('invite rotation/expiry stop joins but preserve existing memberships', async () => {
      const response = await request(`${path}/invite`, 'POST', {}, owner);
      const rotated = inviteSchema.parse(await response.json());
      assert.notEqual(rotated.code, code);
      assert.equal((await request('/lists/join', 'POST', { code }, outsider)).status, 400);
      await db.listInvite.updateMany({ where: { listId: list.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await request('/lists/join', 'POST', { code: rotated.code }, outsider)).status, 400);
      assert.equal((await request(path, 'GET', undefined, viewer)).status, 200);
      await request(`${path}/invite`, 'DELETE', undefined, owner);
      assert.equal((await request(path, 'GET', undefined, viewer)).status, 200);
    });
    await t.test('guest upgrade transfers private ownership without escalating existing Google memberships', async () => {
      const source = await guest(), destination = await guest();
      const subject = `merge-${randomUUID()}`;
      await db.user.update({ where: { id: destination.id }, data: { kind: 'google', googleSubject: subject } });
      await db.listMember.createMany({ data: [
        { listId: list.id, userId: source.id, role: 'editor' },
        { listId: list.id, userId: destination.id, role: 'viewer' },
      ] });
      const privateList = listSummarySchema.parse(await (await request('/lists', 'POST', { title: 'Private guest list' }, source)).json());
      const result = await auth.mergeGoogle(await auth.lookup(source.cookie.split('=')[1]), subject, 'Existing Google user');
      assert.equal(result.id, destination.id);
      assert.equal(await db.user.count({ where: { id: source.id } }), 0);
      assert.equal((await db.shoppingList.findUniqueOrThrow({ where: { id: privateList.id } })).ownerId, destination.id);
      assert.equal((await db.listMember.findUniqueOrThrow({ where: { listId_userId: { listId: list.id, userId: destination.id } } })).role, 'viewer');
      assert.equal((await request('/auth/me', 'GET', undefined, source)).status, 401);
      const fresh = await guest();
      const upgraded = await auth.mergeGoogle(await auth.lookup(fresh.cookie.split('=')[1]), `new-${randomUUID()}`, 'New Google user');
      assert.equal(upgraded.id, fresh.id);
      assert.equal(upgraded.kind, 'google');
      assert.equal(await db.session.count({ where: { userId: fresh.id } }), 0);
    });
    await t.test('alternative edits are versioned and item deletion is persisted', async () => {
      const item = await db.listItem.findUniqueOrThrow({ where: { id: itemId } });
      const alternative = await db.itemAlternative.findFirstOrThrow({ where: { itemId } });
      const change = { ...quantity, name: 'Almond milk', version: item.version };
      assert.equal((await request(`${path}/items/${itemId}/alternatives/${alternative.id}`, 'PATCH', change, owner)).status, 200);
      assert.equal((await request(`${path}/items/${itemId}/alternatives/${alternative.id}`, 'PATCH', change, owner)).status, 409);
      const response = await request(`${path}/items`, 'POST', { ...quantity, name: 'Delete me' }, owner, { 'Idempotency-Key': randomUUID() });
      const temporary = await response.json() as { id: string };
      assert.equal((await request(`${path}/items/${temporary.id}`, 'DELETE', { version: 1 }, owner)).status, 200);
      assert.equal(await db.listItem.count({ where: { id: temporary.id } }), 0);
      const snapshot = snapshotSchema.parse(await (await request(path, 'GET', undefined, owner)).json());
      assert.equal(snapshot.items.find(item => item.id === itemId)?.alternatives[0].name, 'Almond milk');
    });
    await t.test('origin, CSRF, revocation, expired sessions and account deletion are enforced', async () => {
      assert.equal((await request(path, 'PATCH', { title: 'No' }, owner, { Origin: 'https://evil.invalid' })).status, 403);
      assert.equal((await request(path, 'PATCH', { title: 'No' }, owner, { 'X-CSRF-Token': 'wrong' })).status, 403);
      await request(`${path}/members/${viewer.id}`, 'DELETE', undefined, owner);
      assert.equal((await request(path, 'GET', undefined, viewer)).status, 404);
      assert.equal((await request(`${path}/items/${itemId}`, 'DELETE', { version: 3 }, viewer)).status, 404);
      await db.session.updateMany({ where: { userId: outsider.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await request('/auth/me', 'GET', undefined, outsider)).status, 401);
      assert.equal((await request('/auth/account', 'DELETE', { confirmation: 'no' }, owner)).status, 400);
      assert.equal((await request('/auth/account', 'DELETE', { confirmation: 'DELETE' }, owner)).status, 200);
      assert.equal(await db.shoppingList.count({ where: { id: list.id } }), 0);
      assert.equal((await request('/auth/me', 'GET', undefined, owner)).status, 401);
      assert.equal((await request('/auth/logout', 'POST', undefined, viewer)).status, 201);
      assert.equal((await request('/auth/me', 'GET', undefined, viewer)).status, 401);
    });
  } finally {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  }
});

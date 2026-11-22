const origin = process.env.SMOKE_ORIGIN;
if (!origin) throw new Error('Set SMOKE_ORIGIN to your HTTPS staging origin.');
const target = new URL(origin);
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) {
  throw new Error('Smoke checks require HTTPS except for a loopback development server.');
}
const health = await fetch(new URL('/api/health', origin));
if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Database readiness failed.');
const page = await fetch(new URL('/', origin));
if (!page.ok || !(await page.text()).includes('Kart - shop together')) throw new Error('Web shell failed.');
if (!page.headers.get('content-security-policy')) throw new Error('CSP header missing.');
const privateResponse = await fetch(new URL('/api/lists', origin));
if (privateResponse.status !== 401) throw new Error('Unauthenticated list access was not denied.');
console.log('Staging smoke passed: database, web shell, CSP, and authentication.');

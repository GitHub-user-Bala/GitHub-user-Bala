import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { Db } from './db';
import { config, cookieName, googleEnabled } from './config';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const cookieOptions = {
  httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/',
};
export type Principal = Awaited<ReturnType<Auth['lookup']>>;
export type AuthRequest = Request & { principal?: Principal };
const equal = (a: string, b: string) => {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};

@Injectable()
export class Auth {
  private readonly oauth = new OAuth2Client(
    config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, `${config.WEB_ORIGIN}/api/auth/google/callback`,
  );
  constructor(@Inject(Db) private readonly db: Db) {}

  async lookup(token: unknown) {
    if (typeof token !== 'string' || token.length > 100) throw new UnauthorizedException('Please sign in.');
    const session = await this.db.session.findUnique({
      where: { digest: digest(token) }, include: { user: true },
    });
    if (!session || session.expiresAt <= new Date()) throw new UnauthorizedException('Session expired. Please sign in.');
    return session;
  }

  identity(session: Principal) {
    return {
      id: session.userId, kind: session.user.kind, name: session.user.name,
      csrfToken: session.csrf, googleEnabled,
    };
  }

  async issue(userId: string, res: Response) {
    const token = secret();
    const expiresAt = new Date(Date.now() + 7 * 86400_000);
    const session = await this.db.session.create({
      data: { userId, digest: digest(token), csrf: secret(), expiresAt }, include: { user: true },
    });
    res.cookie(cookieName, token, { ...cookieOptions, expires: expiresAt });
    return this.identity(session);
  }

  async guest(req: Request, res: Response) {
    if (req.cookies?.[cookieName]) {
      try { return this.identity(await this.lookup(req.cookies[cookieName])); }
      catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    }
    const user = await this.db.user.create({ data: {} });
    return this.issue(user.id, res);
  }

  async startGoogle(req: Request, res: Response) {
    if (!googleEnabled) throw new ServiceUnavailableException('Google login is not configured. Guest mode is available.');
    const state = secret();
    const nonce = secret();
    const verifier = secret();
    let guestSession = '';
    if (req.cookies?.[cookieName]) {
      try { guestSession = (await this.lookup(req.cookies[cookieName])).id; }
      catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    }
    const data = Buffer.from(JSON.stringify({ state, nonce, verifier, guestSession, issuedAt: Date.now() })).toString('base64url');
    res.cookie(`${cookieName}-oauth`, data, { ...cookieOptions, maxAge: 10 * 60_000 });
    res.redirect(this.oauth.generateAuthUrl({
      scope: ['openid', 'email', 'profile'], state, access_type: 'online',
      code_challenge: digestBase64(verifier), code_challenge_method: CodeChallengeMethod.S256, nonce,
    }));
  }

  async finishGoogle(req: Request, res: Response) {
    const raw: unknown = req.cookies?.[`${cookieName}-oauth`];
    res.clearCookie(`${cookieName}-oauth`, cookieOptions);
    if (!googleEnabled || typeof raw !== 'string' || raw.length > 2048) {
      throw new ForbiddenException('Login expired. Start Google login again.');
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(raw, 'base64url').toString()); }
    catch { throw new ForbiddenException('Invalid login state.'); }
    const parsed = z.object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      guestSession: z.string().uuid().or(z.literal('')),
      issuedAt: z.number().int(),
    }).strict().safeParse(decoded);
    if (!parsed.success || parsed.data.issuedAt < Date.now() - 10 * 60_000 || parsed.data.issuedAt > Date.now()) {
      throw new ForbiddenException('Login expired. Start Google login again.');
    }
    const pending = parsed.data;
    if (typeof req.query.state !== 'string' || !equal(pending.state, req.query.state)
      || typeof req.query.code !== 'string') throw new ForbiddenException('Google login was cancelled or invalid.');
    const google = await this.verifyGoogle(req.query.code, pending.verifier, pending.nonce);
    const currentToken = req.cookies?.[cookieName];
    let guest: Principal | undefined;
    if (typeof currentToken === 'string') {
      try {
        const current = await this.lookup(currentToken);
        if (current.id === pending.guestSession && current.user.kind === 'guest') guest = current;
      } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    }
    const user = await this.mergeGoogle(guest, google.subject, google.name);
    await this.issue(user.id, res);
    return { previousUserId: guest?.userId, userId: user.id };
  }

  async verifyGoogle(code: string, verifier: string, nonce: string) {
    const { tokens } = await this.oauth.getToken({ code, codeVerifier: verifier });
    if (!tokens.id_token) throw new ForbiddenException('Google did not return an identity.');
    const ticket = await this.oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || payload.nonce !== nonce || !payload.email_verified) {
      throw new ForbiddenException('Google identity could not be verified.');
    }
    return { subject: payload.sub, name: payload.name?.slice(0, 100) || 'Family member' };
  }

  async mergeGoogle(guest: Principal | undefined, googleSubject: string, name: string) {
    return this.db.$transaction(async tx => {
      const existing = await tx.user.findUnique({ where: { googleSubject } });
      if (guest && existing && guest.userId !== existing.id) {
        await tx.shoppingList.updateMany({ where: { ownerId: guest.userId }, data: { ownerId: existing.id } });
        const memberships = await tx.listMember.findMany({ where: { userId: guest.userId } });
        for (const membership of memberships) {
          const list = await tx.shoppingList.findUniqueOrThrow({ where: { id: membership.listId } });
          if (list.ownerId !== existing.id) {
            await tx.listMember.upsert({
              where: { listId_userId: { listId: membership.listId, userId: existing.id } },
              create: { listId: membership.listId, userId: existing.id, role: 'viewer' },
              update: {},
            });
          }
        }
        await tx.user.delete({ where: { id: guest.userId } });
        return existing;
      }
      if (guest && !existing) {
        await tx.session.deleteMany({ where: { userId: guest.userId } });
        return tx.user.update({ where: { id: guest.userId }, data: { kind: 'google', googleSubject, name } });
      }
      return existing ?? tx.user.create({ data: { kind: 'google', googleSubject, name } });
    }, { isolationLevel: 'Serializable' });
  }
}

function digestBase64(value: string) { return createHash('sha256').update(value).digest('base64url'); }

@Injectable()
export class AccessGuard implements CanActivate {
  private readonly buckets = new Map<string, { count: number; reset: number }>();
  constructor(@Inject(Auth) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const path = req.path;
    if (path === '/api/health') return true;
    const now = Date.now();
    if (this.buckets.size > 10000) {
      for (const [key, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(key);
      if (this.buckets.size > 10000) throw new ServiceUnavailableException('Server busy. Try again shortly.');
    }
    const authRoute = path.startsWith('/api/auth/') || path === '/api/lists/join';
    const key = `${req.ip}:${authRoute ? 'auth' : 'api'}`;
    const bucket = this.buckets.get(key);
    const limit = authRoute ? 30 : 240;
    if (bucket && bucket.reset > now) {
      if (++bucket.count > limit) {
        const { HttpException } = await import('@nestjs/common');
        throw new HttpException('Too many requests. Please wait a minute.', 429);
      }
    } else this.buckets.set(key, { count: 1, reset: now + 60_000 });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.WEB_ORIGIN) {
      throw new ForbiddenException('Request origin is not allowed.');
    }
    if (path === '/api/auth/guest' && req.method === 'POST') return true;
    if ((path === '/api/auth/google' || path === '/api/auth/google/callback') && req.method === 'GET') return true;
    req.principal = await this.auth.lookup(req.cookies?.[cookieName]);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = req.get('x-csrf-token');
      if (!token || !equal(token, req.principal.csrf)) throw new ForbiddenException('Invalid request token. Refresh and retry.');
    }
    return true;
  }
}

import { HttpException, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
import { Auth, type Principal } from './auth';
import { Lists } from './lists';
import { config, cookieName } from './config';

@Injectable()
export class Live implements OnModuleDestroy {
  private io?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(Live.name);
  constructor(@Inject(Auth) private readonly auth: Auth, @Inject(Lists) private readonly lists: Lists) {}

  attach(server: HttpServer) {
    this.io = new Server(server, {
      cors: { origin: config.WEB_ORIGIN, credentials: true },
      allowRequest: (req, callback) => callback(null, req.headers.origin === config.WEB_ORIGIN
        || (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin')),
      maxHttpBufferSize: 4096,
    });
    this.io.use(async (socket, next) => {
      try {
        const token = this.token(socket);
        const principal = await this.auth.lookup(token);
        socket.data.principal = principal;
        next();
      } catch (error) {
        this.logUnexpected(error);
        next(new Error('Please sign in again.'));
      }
    });
    this.io.on('connection', socket => {
      let attempts = 0;
      let windowStart = Date.now();
      socket.on('subscribe', async (value: unknown, ack: unknown) => {
        const reply = typeof ack === 'function' ? ack : () => undefined;
        const id = z.string().uuid().safeParse(value);
        if (Date.now() - windowStart >= 60_000) { attempts = 0; windowStart = Date.now(); }
        attempts++;
        if (!id.success || attempts > 60) {
          reply({ ok: false }); return;
        }
        try {
          const principal = await this.auth.lookup(this.token(socket));
          await this.lists.roleForSocket(id.data, principal.userId);
          for (const room of socket.rooms) if (room.startsWith('list:')) await socket.leave(room);
          await socket.join(`list:${id.data}`);
          socket.data.principal = principal;
          reply({ ok: true });
        } catch (error) { this.logUnexpected(error); reply({ ok: false }); }
      });
    });
    this.timer = setInterval(() => {
      void this.recheck().catch(error => this.logger.error('Socket authorization refresh failed', error instanceof Error ? error.name : 'unknown'));
    }, 30_000);
    this.timer.unref();
  }

  private token(socket: Socket) {
    const cookies = socket.handshake.headers.cookie?.split(';').map(v => v.trim()) ?? [];
    return cookies.find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  }

  private logUnexpected(error: unknown) {
    if (!(error instanceof HttpException) || error.getStatus() >= 500) {
      this.logger.error(JSON.stringify({ event: 'socket_authorization_failed', error: error instanceof Error ? error.name : 'unknown' }));
    }
  }

  private async recheck() {
    for (const socket of this.io?.sockets.sockets.values() ?? []) {
      try { await this.auth.lookup(this.token(socket)); }
      catch (error) {
        this.logUnexpected(error);
        socket.emit('session.revoked');
        socket.disconnect(true);
      }
    }
  }

  changed(listId: string, revision: number) {
    this.io?.to(`list:${listId}`).emit('list.changed', { listId, revision });
  }

  permissions(listId: string, userId?: string, removed = false) {
    for (const socket of this.io?.sockets.sockets.values() ?? []) {
      const principal = socket.data.principal as Principal | undefined;
      if (userId ? principal?.userId === userId : socket.rooms.has(`list:${listId}`)) {
        if (removed) void socket.leave(`list:${listId}`);
        socket.emit('permissions.changed', { listId });
      }
    }
  }

  revokeUser(userId: string) {
    for (const socket of this.io?.sockets.sockets.values() ?? []) {
      if ((socket.data.principal as Principal | undefined)?.userId === userId) {
        socket.emit('session.revoked'); socket.disconnect(true);
      }
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.io?.close();
  }
}

import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { json, static as staticFiles } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ZodError } from 'zod';
import * as Sentry from '@sentry/node';
import { config } from './config';
import { Db } from './db';
import { Auth, AccessGuard } from './auth';
import { Lists } from './lists';
import { Live } from './live';
import { KartController } from './controller';

if (config.SENTRY_DSN) Sentry.init({
  dsn: config.SENTRY_DSN, sendDefaultPii: false,
  beforeSend(event) {
    delete event.request; delete event.user; delete event.breadcrumbs;
    delete event.extra; delete event.contexts;
    event.message = 'Kart server error';
    if (event.exception?.values) for (const value of event.exception.values) value.value = 'Internal server error';
    return event;
  },
});
@Catch()
class Errors implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500, message = 'Server error. Please try again.';
    if (error instanceof ZodError) {
      status = 400; message = error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join('; ');
    } else if (error instanceof HttpException) {
      status = error.getStatus(); message = error.message;
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      status = 409; message = 'Concurrent update. Refresh and retry.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      status = 404; message = 'Record not found or removed.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      status = 409; message = 'This record already exists. Refresh and retry.';
    }
    if (status >= 500) {
      this.logger.error(JSON.stringify({ event: 'request_failed', status, error: error instanceof Error ? error.name : 'unknown' }));
      Sentry.captureException(error);
    }
    res.status(status).json({ message, code: status === 409 ? 'CONFLICT' : undefined });
  }
}
@Module({ controllers: [KartController], providers: [Db, Auth, AccessGuard, Lists, Live] })
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
  app.use(json({ limit: '16kb' }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    const start = Date.now();
    res.on('finish', () => {
      if (req.path !== '/api/health') Logger.log(JSON.stringify({
        event: 'http', method: req.method, status: res.statusCode, durationMs: Date.now() - start,
      }), 'HTTP');
    });
    next();
  });
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true, allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'] });
  const webDirectory = resolve(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(webDirectory)) {
    app.use(staticFiles(webDirectory, { index: false }));
    app.use((req: Request, res: Response, next: () => void) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')
        && !req.path.includes('.')) res.sendFile(resolve(webDirectory, 'index.html'));
      else next();
    });
  }
  app.useGlobalFilters(new Errors());
  app.enableShutdownHooks();
  await app.get(Db).$connect();
  app.get(Live).attach(app.getHttpServer());
  return app;
}

if (require.main === module) {
  void createApp().then(app => app.listen(config.PORT, '0.0.0.0')).catch(error => {
    Logger.error(error instanceof Error ? error.name : 'Startup failure', 'Startup');
    process.exitCode = 1;
  });
}

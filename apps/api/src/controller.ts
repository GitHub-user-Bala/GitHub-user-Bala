import {
  Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  alternativeSelectSchema, alternativeWriteSchema, codeSchema, itemWriteSchema, memberSchema,
  quantitySchema, titleSchema, versionSchema,
} from '@kart/contracts';
import { Auth, AccessGuard, cookieOptions, type AuthRequest } from './auth';
import { cookieName, config } from './config';
import { Db } from './db';
import { Lists } from './lists';
import { Live } from './live';

const uuid = (value: string) => z.string().uuid().parse(value);
function principal(req: AuthRequest) {
  if (!req.principal) throw new BadRequestException('Missing authenticated session.');
  return req.principal;
}
@Controller('api')
@UseGuards(AccessGuard)
export class KartController {
  constructor(
    @Inject(Auth) private readonly auth: Auth,
    @Inject(Db) private readonly db: Db,
    @Inject(Lists) private readonly lists: Lists,
    @Inject(Live) private readonly live: Live,
  ) {}

  @Get('health')
  async health() { await this.db.$queryRaw`SELECT 1`; return { status: 'ok' }; }

  @Post('auth/guest')
  guest(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) { return this.auth.guest(req, res); }

  @Get('auth/me')
  me(@Req() req: AuthRequest) { return this.auth.identity(principal(req)); }

  @Get('auth/google')
  google(@Req() req: AuthRequest, @Res() res: Response) { return this.auth.startGoogle(req, res); }

  @Get('auth/google/callback')
  async callback(@Req() req: AuthRequest, @Res() res: Response) {
    const result = await this.auth.finishGoogle(req, res);
    if (result.previousUserId) this.live.revokeUser(result.previousUserId);
    res.redirect(config.WEB_ORIGIN);
  }

  @Post('auth/logout')
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    const session = principal(req);
    await this.db.session.delete({ where: { id: session.id } });
    this.live.revokeUser(session.userId);
    res.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  }

  @Delete('auth/account')
  async deleteAccount(@Req() req: AuthRequest, @Body() input: unknown, @Res({ passthrough: true }) res: Response) {
    z.object({ confirmation: z.literal('DELETE') }).strict().parse(input);
    const session = principal(req);
    const owned = await this.db.shoppingList.findMany({ where: { ownerId: session.userId }, select: { id: true } });
    await this.db.user.delete({ where: { id: session.userId } });
    for (const list of owned) this.live.permissions(list.id, undefined, true);
    this.live.revokeUser(session.userId);
    res.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  }

  @Get('lists')
  all(@Req() req: AuthRequest) { return this.lists.all(principal(req).userId); }

  @Post('lists')
  create(@Req() req: AuthRequest, @Body() input: unknown) {
    return this.lists.create(principal(req).userId, titleSchema.parse(input).title);
  }

  @Post('lists/join')
  async join(@Req() req: AuthRequest, @Body() input: unknown) {
    const result = await this.lists.join(codeSchema.parse(input).code, principal(req).userId);
    this.live.permissions(result.id);
    return result;
  }

  @Get('lists/:listId')
  snapshot(@Req() req: AuthRequest, @Param('listId') id: string) {
    return this.lists.snapshot(uuid(id), principal(req).userId);
  }

  @Get('lists/:listId/revision')
  async revision(@Req() req: AuthRequest, @Param('listId') raw: string) {
    const id = uuid(raw);
    await this.lists.roleForSocket(id, principal(req).userId);
    const list = await this.db.shoppingList.findUniqueOrThrow({ where: { id } });
    return { revision: list.revision };
  }

  @Patch('lists/:listId')
  async title(@Req() req: AuthRequest, @Param('listId') raw: string, @Body() input: unknown) {
    const id = uuid(raw), data = titleSchema.parse(input);
    const change = await this.lists.mutate(id, principal(req), 'owner', tx =>
      tx.shoppingList.update({ where: { id }, data }));
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Delete('lists/:listId')
  async deleteList(@Req() req: AuthRequest, @Param('listId') raw: string) {
    const id = uuid(raw);
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ShoppingList" WHERE id = ${id}::uuid FOR UPDATE`;
      if (await this.lists.role(tx, id, principal(req).userId) !== 'owner') {
        const { ForbiddenException } = await import('@nestjs/common');
        throw new ForbiddenException('Only the owner can delete a list.');
      }
      await tx.shoppingList.delete({ where: { id } });
    });
    this.live.permissions(id, undefined, true);
    return { ok: true };
  }

  @Post('lists/:listId/invite')
  async invite(@Req() req: AuthRequest, @Param('listId') raw: string) {
    const id = uuid(raw), session = principal(req);
    const change = await this.lists.mutate(id, session, 'owner', tx => this.lists.invite(tx, id, session));
    this.live.changed(id, change.revision);
    return change.result;
  }

  @Delete('lists/:listId/invite')
  async revokeInvite(@Req() req: AuthRequest, @Param('listId') raw: string) {
    const id = uuid(raw);
    const change = await this.lists.mutate(id, principal(req), 'owner', tx =>
      tx.listInvite.deleteMany({ where: { listId: id } }));
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Patch('lists/:listId/members/:userId')
  async permission(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('userId') user: string,
    @Body() input: unknown) {
    const id = uuid(raw), userId = uuid(user), data = memberSchema.parse(input);
    const change = await this.lists.mutate(id, principal(req), 'owner', async tx => {
      const count = await tx.listMember.updateMany({ where: { listId: id, userId }, data });
      if (!count.count) throw new NotFoundException('Member not found.');
    });
    this.live.permissions(id, userId);
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Delete('lists/:listId/members/:userId')
  async removeMember(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('userId') user: string) {
    const id = uuid(raw), userId = uuid(user);
    const change = await this.lists.mutate(id, principal(req), 'owner', tx =>
      tx.listMember.deleteMany({ where: { listId: id, userId } }));
    this.live.permissions(id, userId, true);
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Post('lists/:listId/items')
  async addItem(@Req() req: AuthRequest, @Param('listId') raw: string, @Body() input: unknown) {
    const id = uuid(raw), data = quantitySchema.parse(input), session = principal(req);
    const key = z.string().uuid().parse(req.get('idempotency-key'));
    const change = await this.lists.mutate(id, session, 'editor', tx => this.lists.createItem(tx, id, session, data, key));
    this.live.changed(id, change.revision);
    return change.result;
  }

  @Patch('lists/:listId/items/:itemId')
  async editItem(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('itemId') item: string,
    @Body() input: unknown) {
    const id = uuid(raw), itemId = uuid(item), { version, ...data } = itemWriteSchema.parse(input);
    const session = principal(req);
    const change = await this.lists.mutate(id, session, 'editor', async tx => {
      await this.lists.item(tx, id, itemId, version);
      return tx.listItem.update({ where: { id: itemId }, data: { ...data, lastActorId: session.userId, version: { increment: 1 } } });
    });
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Delete('lists/:listId/items/:itemId')
  async removeItem(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('itemId') item: string,
    @Body() input: unknown) {
    const id = uuid(raw), itemId = uuid(item), { version } = versionSchema.parse(input);
    const change = await this.lists.mutate(id, principal(req), 'editor', async tx => {
      await this.lists.item(tx, id, itemId, version);
      await tx.listItem.delete({ where: { id: itemId } });
    });
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Post('lists/:listId/items/:itemId/alternatives')
  async addAlternative(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('itemId') item: string,
    @Body() input: unknown) {
    const id = uuid(raw), itemId = uuid(item), data = quantitySchema.parse(input);
    const session = principal(req), key = z.string().uuid().parse(req.get('idempotency-key'));
    const change = await this.lists.mutate(id, session, 'editor', tx =>
      this.lists.addAlternative(tx, id, itemId, data, session, key));
    this.live.changed(id, change.revision);
    return { id: change.result.id };
  }

  @Patch('lists/:listId/items/:itemId/alternatives/:alternativeId')
  async editAlternative(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('itemId') item: string,
    @Param('alternativeId') alternative: string, @Body() input: unknown) {
    const id = uuid(raw), itemId = uuid(item), alternativeId = uuid(alternative);
    const { version, ...data } = alternativeWriteSchema.parse(input);
    const session = principal(req);
    const change = await this.lists.mutate(id, session, 'editor', async tx => {
      await this.lists.item(tx, id, itemId, version);
      const updated = await tx.itemAlternative.updateMany({ where: { id: alternativeId, itemId }, data });
      if (!updated.count) throw new NotFoundException('Alternative not found.');
      await tx.listItem.update({ where: { id: itemId }, data: { version: { increment: 1 }, lastActorId: session.userId } });
    });
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Delete('lists/:listId/items/:itemId/alternatives/:alternativeId')
  async removeAlternative(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('itemId') item: string,
    @Param('alternativeId') alternative: string) {
    const id = uuid(raw), itemId = uuid(item), alternativeId = uuid(alternative);
    const change = await this.lists.mutate(id, principal(req), 'editor', async tx => {
      await this.lists.item(tx, id, itemId);
      const deleted = await tx.itemAlternative.deleteMany({ where: { id: alternativeId, itemId } });
      if (!deleted.count) throw new NotFoundException('Alternative not found.');
      await tx.listItem.update({ where: { id: itemId }, data: { version: { increment: 1 }, lastActorId: principal(req).userId } });
    });
    this.live.changed(id, change.revision);
    return { ok: true };
  }

  @Post('lists/:listId/items/:itemId/select')
  async select(@Req() req: AuthRequest, @Param('listId') raw: string, @Param('itemId') item: string,
    @Body() input: unknown) {
    const id = uuid(raw), itemId = uuid(item), { alternativeId, version } = alternativeSelectSchema.parse(input);
    const session = principal(req), key = z.string().uuid().parse(req.get('idempotency-key'));
    const change = await this.lists.mutate(id, session, 'editor', tx =>
      this.lists.select(tx, id, session, itemId, alternativeId, version, key));
    this.live.changed(id, change.revision);
    return change.result;
  }
}

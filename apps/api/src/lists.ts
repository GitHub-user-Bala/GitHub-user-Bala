import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import type { Quantity, Role } from '@kart/contracts';
import { Db } from './db';
import { digest, type Principal } from './auth';

type Tx = Prisma.TransactionClient;
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
@Injectable()
export class Lists {
  constructor(@Inject(Db) private readonly db: Db) {}

  async roleForSocket(listId: string, userId: string) { return this.role(this.db, listId, userId); }

  async role(tx: Tx, listId: string, userId: string): Promise<Role> {
    const list = await tx.shoppingList.findUnique({ where: { id: listId } });
    if (!list) throw new NotFoundException('List not found or access removed.');
    if (list.ownerId === userId) return 'owner';
    const member = await tx.listMember.findUnique({ where: { listId_userId: { listId, userId } } });
    if (!member) throw new NotFoundException('List not found or access removed.');
    return member.role === 'editor' ? 'editor' : 'viewer';
  }

  async all(userId: string) {
    const lists = await this.db.shoppingList.findMany({
      where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      include: { members: { where: { userId } } }, orderBy: { createdAt: 'asc' },
    });
    return lists.map(list => ({
      id: list.id, title: list.title, revision: list.revision,
      role: list.ownerId === userId ? 'owner' : list.members[0].role,
    }));
  }

  async create(userId: string, title: string) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      if (await tx.shoppingList.count({ where: { ownerId: userId } }) >= 20) {
        throw new BadRequestException('Pilot limit: 20 owned lists. Remove an unused list first.');
      }
      const list = await tx.shoppingList.create({ data: { ownerId: userId, title } });
      return { id: list.id, title: list.title, revision: list.revision, role: 'owner' };
    });
  }

  async snapshot(listId: string, userId: string) {
    return this.db.$transaction(async tx => {
      const role = await this.role(tx, listId, userId);
      const list = await tx.shoppingList.findUniqueOrThrow({
        where: { id: listId }, include: {
          items: { orderBy: { createdAt: 'asc' }, include: { alternatives: true } },
          members: { where: role === 'owner' ? {} : { userId: '00000000-0000-0000-0000-000000000000' }, include: { user: true } },
        },
      });
      return {
        id: list.id, title: list.title, revision: list.revision, role,
        items: list.items.map(item => ({
          id: item.id, name: item.name, packCount: item.packCount, amount: item.amount?.toString() ?? null,
          unit: item.unit, status: item.status, version: item.version, originalItemId: item.originalItemId,
          alternatives: item.alternatives.map(a => ({
            id: a.id, name: a.name, packCount: a.packCount, amount: a.amount?.toString() ?? null, unit: a.unit,
          })),
        })),
        members: list.members.map(member => ({ userId: member.userId, name: member.user.name, role: member.role })),
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async mutate<T>(listId: string, principal: Principal, minimum: 'editor' | 'owner',
    fn: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ShoppingList" WHERE id = ${listId}::uuid FOR UPDATE`;
      const role = await this.role(tx, listId, principal.userId);
      if (role === 'viewer' || (minimum === 'owner' && role !== 'owner')) {
        throw new ForbiddenException(minimum === 'owner' ? 'Only the owner can do this.' : 'Ask the owner for edit access.');
      }
      const result = await fn(tx);
      const list = await tx.shoppingList.update({ where: { id: listId }, data: { revision: { increment: 1 } } });
      return { result, revision: list.revision };
    });
  }

  async item(tx: Tx, listId: string, itemId: string, version?: number) {
    const item = await tx.listItem.findFirst({ where: { id: itemId, listId } });
    if (!item) throw new NotFoundException('Item was removed. Refresh the list.');
    if (version !== undefined && item.version !== version) {
      throw new ConflictException('Someone changed this item. Your list has been refreshed; review and try again.');
    }
    return item;
  }

  async createItem(tx: Tx, listId: string, principal: Principal, data: Quantity, key: string,
    originalItemId?: string) {
    const fingerprint = digest(JSON.stringify({ data, originalItemId: originalItemId ?? null }));
    const existing = await tx.writeKey.findUnique({ where: { listId_key: { listId, key } } });
    if (existing) {
      if (existing.actorId !== principal.userId || existing.fingerprint !== fingerprint) {
        throw new ConflictException('This retry key was already used for a different action.');
      }
      return { id: existing.itemId };
    }
    if (await tx.listItem.count({ where: { listId } }) >= 500) {
      throw new BadRequestException('Pilot limit: 500 items per list.');
    }
    const item = await tx.listItem.create({
      data: { ...data, listId, lastActorId: principal.userId, originalItemId },
    });
    await tx.writeKey.create({ data: { listId, key, fingerprint, actorId: principal.userId, itemId: item.id } });
    return { id: item.id };
  }

  async select(tx: Tx, listId: string, principal: Principal, itemId: string, alternativeId: string,
    version: number, key: string) {
    const item = await this.item(tx, listId, itemId);
    const alternative = await tx.itemAlternative.findFirst({ where: { id: alternativeId, itemId } });
    if (!alternative) throw new NotFoundException('Alternative not found.');
    const data = {
      name: alternative.name, packCount: alternative.packCount,
      amount: alternative.amount?.toString() ?? null, unit: alternative.unit as Quantity['unit'],
    };
    const retry = await tx.writeKey.findUnique({ where: { listId_key: { listId, key } } });
    if (!retry) {
      if (item.version !== version) throw new ConflictException('Item changed. Refresh and retry.');
      if (item.status !== 'unavailable') throw new BadRequestException('Mark the original unavailable first.');
      if (await tx.listItem.findUnique({ where: { originalItemId: itemId } })) {
        throw new ConflictException('A replacement already exists. Remove it before choosing another.');
      }
    }
    return this.createItem(tx, listId, principal, data, key, itemId);
  }

  async addAlternative(tx: Tx, listId: string, itemId: string, data: Quantity, principal: Principal, key: string) {
    await this.item(tx, listId, itemId);
    const fingerprint = digest(JSON.stringify({ kind: 'alternative', itemId, data }));
    const retry = await tx.writeKey.findUnique({ where: { listId_key: { listId, key } } });
    if (retry) {
      if (retry.fingerprint !== fingerprint || retry.actorId !== principal.userId) {
        throw new ConflictException('This retry key was already used for a different action.');
      }
      return { id: retry.itemId };
    }
    if (await tx.itemAlternative.count({ where: { itemId } }) >= 10) throw new BadRequestException('Limit: 10 alternatives per item.');
    const alternative = await tx.itemAlternative.create({ data: { ...data, itemId } });
    await tx.listItem.update({ where: { id: itemId }, data: { version: { increment: 1 }, lastActorId: principal.userId } });
    await tx.writeKey.create({ data: { listId, key, fingerprint, actorId: principal.userId, itemId: alternative.id } });
    return { id: alternative.id };
  }

  async invite(tx: Tx, listId: string, principal: Principal) {
    if (principal.user.kind !== 'google') throw new ForbiddenException('Sign in with Google before sharing your list.');
    await tx.listInvite.deleteMany({ where: { listId } });
    const code = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const expiresAt = new Date(Date.now() + 7 * 86400_000);
    await tx.listInvite.create({ data: { listId, digest: digest(code), expiresAt } });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async join(code: string, userId: string) {
    return this.db.$transaction(async tx => {
      const invite = await tx.listInvite.findUnique({ where: { digest: digest(code) } });
      if (!invite) throw new BadRequestException('Code is invalid or expired.');
      await tx.$queryRaw`SELECT id FROM "ShoppingList" WHERE id = ${invite.listId}::uuid FOR UPDATE`;
      const current = await tx.listInvite.findUnique({ where: { id: invite.id } });
      if (!current || current.revoked || current.expiresAt <= new Date()) {
        throw new BadRequestException('Code is invalid or expired.');
      }
      const list = await tx.shoppingList.findUniqueOrThrow({ where: { id: invite.listId } });
      if (list.ownerId !== userId) {
        const member = await tx.listMember.findUnique({ where: { listId_userId: { listId: list.id, userId } } });
        if (!member) {
          if (await tx.listMember.count({ where: { listId: list.id } }) >= 30) {
            throw new BadRequestException('Pilot limit: 30 members per list.');
          }
          await tx.listMember.create({ data: { listId: list.id, userId } });
          await tx.shoppingList.update({ where: { id: list.id }, data: { revision: { increment: 1 } } });
        }
      }
      return { id: list.id, title: list.title, revision: list.revision, role: await this.role(tx, list.id, userId) };
    });
  }
}

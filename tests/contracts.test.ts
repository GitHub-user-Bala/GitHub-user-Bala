import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeSchema, itemWriteSchema, quantitySchema } from '../packages/contracts/src';

test('quantity validates exact amounts, compatible optional fields, and bounded counts', () => {
  assert.deepEqual(quantitySchema.parse({ name: ' Milk ', packCount: 2, amount: '500', unit: 'ml' }),
    { name: 'Milk', packCount: 2, amount: '500', unit: 'ml' });
  for (const data of [
    { name: '', packCount: 1, amount: null, unit: null },
    { name: 'Milk', packCount: 0, amount: null, unit: null },
    { name: 'Milk', packCount: 1.5, amount: null, unit: null },
    { name: 'Milk', packCount: 1, amount: '0', unit: 'ml' },
    { name: 'Milk', packCount: 1, amount: '2', unit: null },
    { name: 'Milk', packCount: 1, amount: null, unit: 'ml' },
    { name: 'Milk', packCount: 1, amount: '2.1234', unit: 'ml' },
    { name: 'Milk', packCount: 1, amount: '-1', unit: 'ml' },
    { name: 'Milk', packCount: 1, amount: '1e3', unit: 'ml' },
    { name: 'Milk', packCount: 1, amount: '2', unit: 'unknown' },
    { name: 'Milk', packCount: 1, amount: null, unit: null, ownerId: 'injected' },
  ]) assert.equal(quantitySchema.safeParse(data).success, false, JSON.stringify(data));
});
test('status updates require a positive version and a valid state', () => {
  const item = { name: 'Eggs', packCount: 1, amount: null, unit: null, status: 'needed', version: 1 };
  assert.equal(itemWriteSchema.safeParse(item).success, true);
  assert.equal(itemWriteSchema.safeParse({ ...item, version: 0 }).success, false);
  assert.equal(itemWriteSchema.safeParse({ ...item, status: 'deleted' }).success, false);
});
test('codes normalize case but reject short or ambiguous input', () => {
  assert.equal(codeSchema.parse({ code: ' abcdefghjkmn ' }).code, 'ABCDEFGHJKMN');
  assert.equal(codeSchema.safeParse({ code: '123456789012' }).success, false);
});

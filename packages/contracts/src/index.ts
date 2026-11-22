import { z } from 'zod';

export const units = ['g', 'kg', 'ml', 'l', 'piece'] as const;
export const statuses = ['needed', 'purchased', 'unavailable'] as const;
export const roleSchema = z.enum(['owner', 'editor', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
const fields = {
  name: z.string().trim().min(1).max(120),
  packCount: z.number().int().min(1).max(999),
  amount: z.string().regex(/^\d{1,6}(\.\d{1,3})?$/).refine(v => Number(v) > 0).nullable(),
  unit: z.enum(units).nullable(),
};
export const quantitySchema = z.object(fields).strict().refine(
  v => (v.amount === null) === (v.unit === null),
  { message: 'Amount and unit must be provided together.', path: ['amount'] },
);
export type Quantity = z.infer<typeof quantitySchema>;
export const itemWriteSchema = z.object({
  ...fields,
  status: z.enum(statuses),
  version: z.number().int().positive(),
}).strict().refine(v => (v.amount === null) === (v.unit === null), {
  message: 'Amount and unit must be provided together.', path: ['amount'],
});
export const versionSchema = z.object({ version: z.number().int().positive() }).strict();
export const alternativeWriteSchema = z.object({
  ...fields, version: z.number().int().positive(),
}).strict().refine(v => (v.amount === null) === (v.unit === null), {
  message: 'Amount and unit must be provided together.', path: ['amount'],
});
export const titleSchema = z.object({ title: z.string().trim().min(1).max(100) }).strict();
export const codeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/),
}).strict();
export const memberSchema = z.object({ role: z.enum(['editor', 'viewer']) }).strict();
export const alternativeSelectSchema = z.object({
  alternativeId: z.string().uuid(),
  version: z.number().int().positive(),
}).strict();
export const identitySchema = z.object({
  id: z.string().uuid(), kind: z.enum(['guest', 'google']),
  name: z.string(), csrfToken: z.string(), googleEnabled: z.boolean(),
});
export type Identity = z.infer<typeof identitySchema>;
export const alternativeSchema = z.object({ id: z.string().uuid(), ...fields });
export const itemSchema = z.object({
  id: z.string().uuid(), ...fields, status: z.enum(statuses), version: z.number(),
  originalItemId: z.string().uuid().nullable(),
  alternatives: z.array(alternativeSchema),
});
export type Item = z.infer<typeof itemSchema>;
export type Alternative = z.infer<typeof alternativeSchema>;
export const listSummarySchema = z.object({
  id: z.string().uuid(), title: z.string(), revision: z.number(), role: roleSchema,
});
export type ListSummary = z.infer<typeof listSummarySchema>;
export const snapshotSchema = listSummarySchema.extend({
  items: z.array(itemSchema),
  members: z.array(z.object({
    userId: z.string().uuid(), name: z.string(), role: z.enum(['editor', 'viewer']),
  })),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const inviteSchema = z.object({ code: z.string(), expiresAt: z.string() });
export const changeSchema = z.object({ listId: z.string().uuid(), revision: z.number().int() });
export const errorSchema = z.object({ message: z.string(), code: z.string().optional() });

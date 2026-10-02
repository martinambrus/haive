import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';
import { createFakeDb } from '../src/testing/fake-db.js';

const ID = '00000000-0000-4000-8000-0000000000b1';
const NAMED = /fake db: repositories was not given to createFakeDb/;

describe('the fake database and a table it was not given', () => {
  const given = () => createFakeDb({ tasks: schema.tasks });
  const t = schema.repositories;

  it.each([
    ['a select', () => Promise.resolve(given().db.select().from(t))],
    [
      'a select with a condition',
      () => Promise.resolve(given().db.select().from(t).where(eq(t.id, ID))),
    ],
    [
      'an update',
      () => Promise.resolve(given().db.update(t).set({ name: 'x' }).where(eq(t.id, ID))),
    ],
    ['an insert', () => Promise.resolve(given().db.insert(t).values({ id: ID }))],
    ['a delete', () => Promise.resolve(given().db.delete(t).where(eq(t.id, ID)))],
    ['a test-side insert', () => Promise.resolve().then(() => given().insert(t, { id: ID }))],
    ['a test-side read', () => Promise.resolve().then(() => given().rows(t))],
  ])('names the table for %s', async (_what, statement) => {
    await expect(statement()).rejects.toThrow(NAMED);
  });
});

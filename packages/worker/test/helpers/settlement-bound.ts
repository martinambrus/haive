import type { Database } from '@haive/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/** Record production SQL; never install a timeout on the caller's behalf. */
export function recordSettlementBounds(db: Database) {
  const sections: string[][] = [];
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction')
        return (fn: (tx: Database) => Promise<unknown>) =>
          target.transaction(async (tx) => {
            const statements: string[] = [];
            sections.push(statements);
            return fn(
              new Proxy(tx, {
                get(handle, key) {
                  if (key === 'execute')
                    return (query: SQL) => {
                      statements.push(new PgDialect().sqlToQuery(query).sql);
                      return handle.execute(query);
                    };
                  if (key === 'select')
                    return (...args: Parameters<Database['select']>) => {
                      statements.push('select');
                      const selection = handle.select(...args);
                      const from = selection.from.bind(selection);
                      selection.from = ((table) => {
                        const query = from(table);
                        if (typeof query.for === 'function') {
                          const lock = query.for.bind(query);
                          query.for = ((...args) => {
                            statements.push(`for ${args[0]}`);
                            return lock(...args);
                          }) as typeof query.for;
                        }
                        return query;
                      }) as typeof selection.from;
                      return selection;
                    };
                  const value = Reflect.get(handle, key);
                  return typeof value === 'function' ? value.bind(handle) : value;
                },
              }) as unknown as Database,
            );
          });
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, sections };
}

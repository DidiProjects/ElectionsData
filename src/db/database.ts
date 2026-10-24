import pg from 'pg';

export type SqlParam = string | number | boolean | null | readonly (string | number | null)[];

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
}

export interface Database extends Queryable {
  /** Runs `work` inside BEGIN/COMMIT on one connection; rolls back if it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const asQueryable = (client: pg.Pool | pg.PoolClient): Queryable => ({
  async query<T extends Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []) {
    const result = await client.query<T>(sql, params as unknown[]);
    return result.rows;
  },
});

export function createDatabase(options: { connectionString: string; searchPath?: string; max?: number }): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 4,
    // Lets tests isolate themselves in a throwaway schema.
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  const base = asQueryable(pool);

  return {
    query: base.query,
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(asQueryable(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

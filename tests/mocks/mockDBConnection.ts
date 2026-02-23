/**
 * Mock Zotero.DBConnection backed by better-sqlite3.
 *
 * This gives us real SQLite semantics for testing the SQL in BeaverDB
 * without needing a running Zotero instance.
 *
 * The API surface mimics the subset of Zotero.DBConnection that BeaverDB uses:
 *   - queryAsync(sql, params?, options?)
 *   - executeTransaction(fn)
 *   - test()
 *   - closeDatabase()
 */

import Database from 'better-sqlite3';

export class MockDBConnection {
    private db: Database.Database;

    constructor() {
        // In-memory database — fast and disposable
        this.db = new Database(':memory:');
        // Enable WAL mode to mimic Zotero's default
        this.db.pragma('journal_mode = WAL');
    }

    /**
     * Mimics Zotero.DBConnection.queryAsync.
     *
     * Supports both the direct-return pattern (rows as array of objects)
     * and the onRow callback pattern used in some BeaverDB methods.
     */
    async queryAsync(
        sql: string,
        params: any[] = [],
        options?: { onRow?: (row: any) => void }
    ): Promise<any[]> {
        const trimmed = sql.trim().toUpperCase();

        if (trimmed.startsWith('SELECT')) {
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params);

            if (options?.onRow) {
                // Simulate Zotero's onRow callback with getResultByIndex
                for (const row of rows) {
                    const values = Object.values(row);
                    const proxy = {
                        getResultByIndex(i: number) {
                            return values[i];
                        },
                    };
                    options.onRow(proxy);
                }
                return [];
            }

            return rows;
        }

        // INSERT, UPDATE, DELETE, CREATE, DROP, etc.
        const stmt = this.db.prepare(sql);
        stmt.run(...params);
        return [];
    }

    /**
     * Mimics Zotero.DBConnection.executeTransaction.
     * Wraps fn in a real SQLite transaction.
     */
    async executeTransaction(fn: () => Promise<void>): Promise<void> {
        this.db.exec('BEGIN');
        try {
            await fn();
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Mimics Zotero.DBConnection.test — no-op for in-memory DB. */
    async test(): Promise<void> {
        // No-op
    }

    /** Close the database. */
    async closeDatabase(): Promise<void> {
        this.db.close();
    }

    /** Helper: get the raw better-sqlite3 instance for assertions. */
    getRawDB(): Database.Database {
        return this.db;
    }
}

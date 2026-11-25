/**
 * Mock Zotero.DBConnection backed by Node's built-in SQLite (`node:sqlite`).
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

import { DatabaseSync } from 'node:sqlite';
import { parseQueryAndParams } from './zoteroQueryParams';

export class MockDBConnection {
    private db: DatabaseSync;

    constructor(filename = ':memory:') {
        this.db = new DatabaseSync(filename);
        // Enable WAL mode to mimic Zotero's default
        this.db.exec('PRAGMA journal_mode = WAL');
    }

    /**
     * Mimics Zotero.DBConnection.queryAsync.
     *
     * Supports both the direct-return pattern (rows as array of objects)
     * and the onRow callback pattern used in some BeaverDB methods.
     */
    async queryAsync(
        sqlIn: string,
        paramsIn: any[] = [],
        options?: { onRow?: (row: any) => void }
    ): Promise<any[]> {
        // Zotero splices NULL parameters into the SQL rather than binding them,
        // and gets the placeholder position wrong for anything but `= ?`/`, ?`/
        // `( ?`. Reproduce that here so tests exercise the statement production
        // actually runs. See zoteroQueryParams.ts.
        const [sql, params] = parseQueryAndParams(sqlIn, paramsIn);
        // Firefox's Sqlite.sys.mjs, under Zotero.DBConnection, refuses a LIKE
        // whose pattern is not a bound parameter.
        if (/\bLIKE\s+(?![?:@$])/i.test(sql)) {
            throw new Error('Please enter a LIKE clause with bindings');
        }

        // all() also runs statements that return no rows (INSERT, UPDATE,
        // CREATE, `PRAGMA foreign_keys = ON`), which then yield an empty array.
        const rows = this.db.prepare(sql).all(...params);

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

    /** Transactions run one at a time, like Zotero's. */
    private transactionQueue: Promise<void> = Promise.resolve();

    /**
     * Mimics Zotero.DBConnection.executeTransaction.
     * Wraps fn in a real SQLite transaction; a call made while another
     * transaction is open waits for it to finish.
     */
    executeTransaction(fn: () => Promise<void>): Promise<void> {
        const run = async () => {
            this.db.exec('BEGIN');
            try {
                await fn();
                this.db.exec('COMMIT');
            } catch (err) {
                this.db.exec('ROLLBACK');
                throw err;
            }
        };
        const result = this.transactionQueue.then(run);
        this.transactionQueue = result.catch(() => undefined);
        return result;
    }

    /** Mimics Zotero.DBConnection.test — no-op for in-memory DB. */
    async test(): Promise<void> {
        // No-op
    }

    /** Close the database. */
    async closeDatabase(_permanent?: boolean): Promise<void> {
        this.db.close();
    }

    /** Helper: get the raw `DatabaseSync` handle for assertions. */
    getRawDB(): DatabaseSync {
        return this.db;
    }
}

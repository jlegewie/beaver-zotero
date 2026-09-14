/** Durable attachment membership and current outcomes for one processing run. */
export interface ProcessingProgress {
    runId: number;
    startedAt: number;
    finishedAt: number | null;
    total: number;
    pending: number;
    succeeded: number;
    problems: number;
    removed: number;
    discovering: boolean;
    /** Attachments admitted during the most recent discovery pass. */
    discovered: number;
    /** Registered-lane queue counts read with the attachment outcomes. */
    queue?: { available: number; deferred: number; attachments: number };
}

export interface ProcessingProgressScope {
    accountId: string;
    libraryIds: number[];
    hasOcrAccess: boolean;
    hasSearchIndexAccess: boolean;
}

type Query = (
    sql: string,
    params?: readonly unknown[],
    options?: { onRow?: (row: any) => void },
) => Promise<any[]>;

/**
 * Admission is recorded in the same statement as the work, even if a file
 * finishes before the next status read. Only the current run is retained.
 * SQL views give admission, pending counts and completion one definition.
 */
export class ProcessingProgressStore {
    constructor(private query: Query) {}

    async init(): Promise<void> {
        await this.query(`CREATE TABLE IF NOT EXISTS processing_progress_run (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            account_id TEXT NOT NULL DEFAULT '',
            run_id INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER NOT NULL DEFAULT 0,
            finished_at INTEGER,
            ocr INTEGER NOT NULL DEFAULT 0,
            upsert INTEGER NOT NULL DEFAULT 0
        )`);
        await this.query(
            `INSERT OR IGNORE INTO processing_progress_run(singleton) VALUES (1)`,
        );
        await this.query(
            `CREATE TABLE IF NOT EXISTS processing_progress_libraries (library_id INTEGER PRIMARY KEY)`,
        );
        await this
            .query(`CREATE TABLE IF NOT EXISTS processing_progress_members (
            library_id INTEGER NOT NULL, zotero_key TEXT NOT NULL,
            PRIMARY KEY (library_id, zotero_key)
        )`);
        // Scope is restored by the account owner before any status is exposed.
        await this.query("DELETE FROM processing_progress_libraries");
        await this.query(`CREATE VIEW IF NOT EXISTS processing_progress_jobs AS
            SELECT j.* FROM background_jobs j
            JOIN processing_progress_libraries l USING (library_id)
            CROSS JOIN processing_progress_run r
            WHERE j.job_type = 'document_extract'
                OR (j.job_type = 'document_ocr' AND r.ocr = 1)
                OR (j.job_type = 'fulltext_upsert' AND r.upsert = 1)`);
        await this
            .query(`CREATE VIEW IF NOT EXISTS processing_progress_stages AS
            SELECT s.*, CASE
                WHEN s.extract_status IS NULL THEN 'document_extract'
                WHEN s.extract_status = 'done' AND s.ocr_status = 'needed' AND r.ocr = 1 THEN 'document_ocr'
                WHEN s.extract_status = 'done' AND s.structured_document_hash IS NOT NULL
                    AND (s.ocr_status IS NULL OR s.ocr_status IN ('na', 'done'))
                    AND s.upsert_status IS NULL AND r.upsert = 1 THEN 'fulltext_upsert'
                END AS pending_stage,
                CASE WHEN s.extract_status IN ('failed', 'skipped')
                    OR s.ocr_status = 'failed'
                    OR (s.ocr_status = 'needed' AND r.ocr = 0)
                    OR (s.upsert_status = 'failed' AND r.upsert = 1)
                    THEN 1 ELSE 0 END AS problem
            FROM attachment_processing_state s
            JOIN processing_progress_libraries l USING (library_id)
            CROSS JOIN processing_progress_run r`);
        await this
            .query(`CREATE VIEW IF NOT EXISTS processing_progress_pending AS
            SELECT library_id, zotero_key FROM processing_progress_jobs
            UNION
            SELECT s.library_id, s.zotero_key FROM processing_progress_stages s
            WHERE s.pending_stage IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM background_jobs_dead d
                WHERE d.library_id = s.library_id AND d.zotero_key = s.zotero_key
                    AND d.job_type = s.pending_stage
            )`);
        // Use a staging view so both startup seeding and write triggers use
        // precisely the same admission operation.
        await this.query(`CREATE VIEW IF NOT EXISTS processing_progress_admit AS
            SELECT library_id, zotero_key FROM processing_progress_members`);
        await this
            .query(`CREATE TRIGGER IF NOT EXISTS processing_progress_admit_ref
            INSTEAD OF INSERT ON processing_progress_admit BEGIN
                DELETE FROM processing_progress_members
                    WHERE (SELECT finished_at FROM processing_progress_run) IS NOT NULL;
                UPDATE processing_progress_run SET run_id = run_id + 1,
                    started_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000, finished_at = NULL
                    WHERE run_id = 0 OR finished_at IS NOT NULL;
                INSERT OR IGNORE INTO processing_progress_members(library_id, zotero_key)
                    VALUES (NEW.library_id, NEW.zotero_key);
            END`);
        for (const table of [
            "attachment_processing_state",
            "background_jobs",
        ]) {
            for (const action of ["INSERT", "UPDATE"]) {
                await this
                    .query(`CREATE TRIGGER IF NOT EXISTS processing_progress_${table}_${action.toLowerCase()}
                    AFTER ${action} ON ${table}
                    WHEN EXISTS (SELECT 1 FROM processing_progress_pending p
                        WHERE p.library_id = NEW.library_id AND p.zotero_key = NEW.zotero_key)
                    BEGIN
                        INSERT INTO processing_progress_admit(library_id, zotero_key)
                            VALUES (NEW.library_id, NEW.zotero_key);
                    END`);
            }
        }
    }

    async configure(scope: ProcessingProgressScope): Promise<void> {
        // Authentication can be temporarily unknown during startup or refresh.
        // Disable admission without destroying the last authenticated run.
        if (!scope.accountId) {
            await this.query("DELETE FROM processing_progress_libraries");
            return;
        }
        // An account replacement must not inherit another account's run.
        await this.query(
            `DELETE FROM processing_progress_members
            WHERE (SELECT account_id FROM processing_progress_run) != ?`,
            [scope.accountId],
        );
        await this.query(
            `UPDATE processing_progress_run SET
            run_id = CASE WHEN account_id = ? THEN run_id ELSE 0 END,
            started_at = CASE WHEN account_id = ? THEN started_at ELSE 0 END,
            finished_at = CASE WHEN account_id = ? THEN finished_at ELSE NULL END,
            account_id = ?, ocr = ?, upsert = ?`,
            [
                scope.accountId,
                scope.accountId,
                scope.accountId,
                scope.accountId,
                scope.hasOcrAccess ? 1 : 0,
                scope.hasSearchIndexAccess ? 1 : 0,
            ],
        );
        await this.query("DELETE FROM processing_progress_libraries");
        for (const id of scope.libraryIds) {
            await this.query(
                "INSERT INTO processing_progress_libraries(library_id) VALUES (?)",
                [id],
            );
        }
        await this
            .query(`INSERT INTO processing_progress_admit(library_id, zotero_key)
            SELECT library_id, zotero_key FROM processing_progress_pending`);
    }

    async read(
        discovering: boolean,
        inFlight: number,
        libraryId?: number,
        jobTypes?: string[],
    ): Promise<ProcessingProgress> {
        const result = await this.snapshot(discovering, libraryId, jobTypes);
        if (
            !discovering &&
            inFlight === 0 &&
            libraryId === undefined &&
            result.runId > 0 &&
            result.pending === 0 &&
            result.finishedAt === null
        ) {
            await this.query(
                `UPDATE processing_progress_run SET finished_at = ?
                WHERE run_id = ? AND finished_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM processing_progress_pending)`,
                [Date.now(), result.runId],
            );
            return this.snapshot(discovering, libraryId, jobTypes);
        }
        return result;
    }

    private async snapshot(
        discovering: boolean,
        libraryId?: number,
        jobTypes?: string[],
    ): Promise<ProcessingProgress> {
        let result!: ProcessingProgress;
        const types =
            jobTypes === undefined
                ? "1"
                : jobTypes.length === 0
                  ? "0"
                  : `job_type IN (${jobTypes.map(() => "?").join(", ")})`;
        await this.query(
            `SELECT r.run_id, r.started_at, r.finished_at,
                COUNT(m.zotero_key),
                COALESCE(SUM(CASE WHEN p.zotero_key IS NOT NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN p.zotero_key IS NULL AND s.zotero_key IS NOT NULL
                    AND s.problem = 0 AND s.pending_stage IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN p.zotero_key IS NULL AND (
                    (s.zotero_key IS NOT NULL AND (s.problem = 1 OR s.pending_stage IS NOT NULL))
                    OR (s.zotero_key IS NULL AND d.zotero_key IS NOT NULL)) THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN p.zotero_key IS NULL AND s.zotero_key IS NULL
                    AND d.zotero_key IS NULL AND m.zotero_key IS NOT NULL THEN 1 ELSE 0 END), 0),
                q.available, q.pending - q.available, q.attachments
            FROM processing_progress_run r
            LEFT JOIN processing_progress_members m ON ${libraryId === undefined ? "1" : "m.library_id = ?"}
            LEFT JOIN processing_progress_pending p USING (library_id, zotero_key)
            LEFT JOIN processing_progress_stages s USING (library_id, zotero_key)
            LEFT JOIN (
                SELECT DISTINCT d.library_id, d.zotero_key FROM background_jobs_dead d
                JOIN processing_progress_libraries l USING (library_id)
                CROSS JOIN processing_progress_run r
                WHERE d.job_type = 'document_extract'
                    OR (d.job_type = 'document_ocr' AND r.ocr = 1)
                    OR (d.job_type = 'fulltext_upsert' AND r.upsert = 1)
            ) d USING (library_id, zotero_key)
            CROSS JOIN (
                SELECT COUNT(*) AS pending,
                    COALESCE(SUM(CASE WHEN available_at <= ? THEN 1 ELSE 0 END), 0) AS available,
                    COUNT(DISTINCT library_id || '/' || zotero_key) AS attachments
                FROM processing_progress_jobs WHERE ${types}
                    ${libraryId === undefined ? "" : "AND library_id = ?"}
            ) q
            GROUP BY r.singleton`,
            [
                ...(libraryId === undefined ? [] : [libraryId]),
                Date.now(),
                ...(jobTypes ?? []),
                ...(libraryId === undefined ? [] : [libraryId]),
            ],
            {
                onRow: (row) => {
                    result = {
                        runId: Number(row.getResultByIndex(0)),
                        startedAt: Number(row.getResultByIndex(1)),
                        finishedAt: row.getResultByIndex(2) ?? null,
                        total: Number(row.getResultByIndex(3)),
                        pending: Number(row.getResultByIndex(4)),
                        succeeded: Number(row.getResultByIndex(5)),
                        problems: Number(row.getResultByIndex(6)),
                        removed: Number(row.getResultByIndex(7)),
                        discovering,
                        discovered: 0,
                        queue: {
                            available: Number(row.getResultByIndex(8)),
                            deferred: Number(row.getResultByIndex(9)),
                            attachments: Number(row.getResultByIndex(10)),
                        },
                    };
                },
            },
        );
        return result;
    }
}

/**
 * Read access to Zotero's own full-text index.
 *
 * - Zotero 10+ keeps an FTS5 index (`ftindex.fulltextContent`, plus a CJK 2-gram
 *   table) in an attached database. It is ranked with `bm25()`. These tables are
 *   internal, so they are probed before use and any failure falls back to the
 *   word-index path.
 * - Zotero 7–9 (and the fallback) run one public `Zotero.Search`
 *   `fulltextContent` condition per term and rank attachments by the summed IDF
 *   of the terms they contain.
 *
 * Everything here only reads. Scope is always a list of attachment item IDs the
 * caller has already limited to searchable libraries.
 */

import type { ZoteroFulltextEngine, ZoteroFulltextLibraryState } from '@beaver/agent-core/protocol/agentProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { processableAttachmentSql, processableKindFromStoredFields } from '../../utils/attachmentFiles';
import { withDeadline } from './deadline';
import { ftsExpression, type QueryTerm } from './text';

export type ContentKind = 'pdf' | 'epub' | 'snapshot';

/** One PDF, EPUB or snapshot attachment in the search scope. */
export interface ScopeAttachment {
    itemID: number;
    libraryID: number;
    key: string;
    contentKind: ContentKind;
    /** Zotero has indexed some of its text. */
    indexed: boolean;
    /** Zotero stopped at its page or character limit. */
    partial: boolean;
    /** MD5 of the file as Zotero last synced it; identifies copies of one file across libraries. */
    storageHash: string | null;
}

/** `fulltextItems.synced` value for an item whose file or cache was missing at sync (Zotero.Fulltext.SYNC_STATE_MISSING). */
const SYNC_STATE_MISSING = 4;
/** Fused rank constant, as in reciprocal-rank fusion elsewhere in Beaver. */
const RRF_K = 60;
/** On the word-index path, a term in more than this share of the scope adds time but no ranking signal. */
const MAX_TERM_SHARE = 0.3;

let engineCache: { engine: ZoteroFulltextEngine; at: number } | null = null;
const ENGINE_CACHE_MS = 60_000;

async function tableExists(schema: 'main' | 'ftindex', name: string): Promise<boolean> {
    try {
        const count = await Zotero.DB.valueQueryAsync(
            `SELECT COUNT(*) FROM ${schema}.sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
            [name],
        );
        return Number(count) > 0;
    } catch {
        return false;
    }
}

/** Which index this Zotero offers. Cached briefly; the answer only changes across Zotero upgrades. */
export async function detectEngine(): Promise<ZoteroFulltextEngine> {
    if (engineCache && Date.now() - engineCache.at < ENGINE_CACHE_MS) return engineCache.engine;
    let engine: ZoteroFulltextEngine = 'none';
    try {
        const version = Number(await Zotero.DB.valueQueryAsync('PRAGMA ftindex.user_version'));
        if (version > 0 && await tableExists('ftindex', 'fulltextContent')) engine = 'fts5';
    } catch {
        // No attached ftindex database: Zotero 7–9.
    }
    if (engine === 'none' && await tableExists('main', 'fulltextItems')) engine = 'word_index';
    engineCache = { engine, at: Date.now() };
    return engine;
}

/** Test hook: forget the cached engine. */
export function resetEngineCache(): void {
    engineCache = null;
}

/** Which attachments a search may consider: libraries, optionally narrowed to item IDs. */
export interface SearchScope {
    libraryIds: number[];
    /** Item IDs from filters or explicit attachments; undefined means whole libraries. */
    itemIDs?: readonly number[];
}

/**
 * SQL conditions (and their parameters) selecting the scope's PDF, EPUB and
 * snapshot attachments that are not in the trash. `I` is `items`, `IA` is
 * `itemAttachments`.
 */
function scopeConditions(scope: SearchScope): { sql: string; params: unknown[] } {
    const ids = scope.itemIDs ? [...new Set(scope.itemIDs)].filter(Number.isInteger) : null;
    return {
        sql: `I.libraryID IN (${scope.libraryIds.map(() => '?').join(',')})
           ${ids ? `AND I.itemID IN (${ids.join(',') || 'NULL'})` : ''}
           AND IA.linkMode != ?
           AND ${processableAttachmentSql('IA.contentType', 'IA.path')}
           AND NOT EXISTS (SELECT 1 FROM deletedItems D WHERE D.itemID = I.itemID)
           AND NOT EXISTS (SELECT 1 FROM deletedItems D WHERE D.itemID = IA.parentItemID)`,
        params: [...scope.libraryIds, Zotero.Attachments.LINK_MODE_LINKED_URL],
    };
}

/**
 * Joins and 0/1 expressions for an attachment's state in Zotero's index, for
 * queries over the scope (`I` is `items`).
 *
 * Progress is counted the way Zotero's own index statistics count it: in pages
 * when Zotero recorded pages (PDFs), otherwise in characters. A row whose file
 * was missing at sync, or that has nothing indexed yet (queued or unavailable),
 * holds no searchable text. `fts5` counts an attachment as indexed only once it
 * is in Zotero's FTS5 content index: after an upgrade to Zotero 10, Zotero
 * rebuilds that index in the background from text it had already extracted,
 * and until then the attachment cannot be found.
 */
function indexStateSql(engine: ZoteroFulltextEngine): { joins: string; indexed: string; partial: string } {
    const fts5 = engine === 'fts5';
    const done = 'COALESCE(FI.indexedPages, FI.indexedChars, 0)';
    const total = 'COALESCE(CASE WHEN FI.indexedPages IS NOT NULL THEN FI.totalPages ELSE FI.totalChars END, 0)';
    const indexed = `(FI.itemID IS NOT NULL${fts5 ? ' AND S.itemID IS NOT NULL' : ''}`
        + ` AND COALESCE(FI.synced, 0) != ${SYNC_STATE_MISSING} AND ${done} > 0)`;
    return {
        joins: `LEFT JOIN fulltextItems FI ON FI.itemID = I.itemID
                ${fts5 ? 'LEFT JOIN ftindex.fulltextIndexState S ON S.itemID = I.itemID' : ''}`,
        indexed,
        partial: `(${indexed} AND ${done} < ${total})`,
    };
}

/** PDF, EPUB and snapshot attachments in scope, with Zotero's index state. */
export async function listScopeAttachments(scope: SearchScope, engine: ZoteroFulltextEngine): Promise<ScopeAttachment[]> {
    if (!scope.libraryIds.length || (scope.itemIDs && !scope.itemIDs.length)) return [];
    const conditions = scopeConditions(scope);
    const state = indexStateSql(engine);
    const rows: ScopeAttachment[] = [];
    await Zotero.DB.queryAsync(
        `SELECT I.itemID, I.libraryID, I.key, IA.contentType, IA.path,
                ${state.indexed}, ${state.partial}, IA.storageHash
         FROM items I
         JOIN itemAttachments IA ON IA.itemID = I.itemID
         ${state.joins}
         WHERE ${conditions.sql}`,
        conditions.params,
        {
            onRow: (row: any) => {
                const contentKind = processableKindFromStoredFields(row.getResultByIndex(3), row.getResultByIndex(4));
                if (!contentKind) return;
                rows.push({
                    itemID: row.getResultByIndex(0),
                    libraryID: row.getResultByIndex(1),
                    key: row.getResultByIndex(2),
                    contentKind: contentKind as ContentKind,
                    indexed: !!row.getResultByIndex(5),
                    partial: !!row.getResultByIndex(6),
                    storageHash: row.getResultByIndex(7) || null,
                });
            },
        },
    );
    return rows;
}

/** Index coverage of one library's PDF, EPUB and snapshot attachments. */
export type LibraryCoverage = Omit<ZoteroFulltextLibraryState, 'library_ref'>;

/** Coverage per library, counted in one aggregate query; libraries without attachments are absent. */
export async function countLibraryCoverage(libraryIds: number[], engine: ZoteroFulltextEngine): Promise<Map<number, LibraryCoverage>> {
    const counts = new Map<number, LibraryCoverage>();
    if (!libraryIds.length) return counts;
    const conditions = scopeConditions({ libraryIds });
    const state = indexStateSql(engine);
    await Zotero.DB.queryAsync(
        `SELECT I.libraryID, COUNT(*), SUM(${state.indexed}), SUM(${state.partial})
         FROM items I
         JOIN itemAttachments IA ON IA.itemID = I.itemID
         ${state.joins}
         WHERE ${conditions.sql}
         GROUP BY I.libraryID`,
        conditions.params,
        {
            onRow: (row: any) => {
                counts.set(row.getResultByIndex(0), {
                    total: Number(row.getResultByIndex(1)) || 0,
                    indexed: Number(row.getResultByIndex(2)) || 0,
                    partial: Number(row.getResultByIndex(3)) || 0,
                });
            },
        },
    );
    return counts;
}

/** Rank the scope's attachments by FTS5 BM25 against one content table, best first. */
async function rankFts5Table(table: 'fulltextContent' | 'fulltextContentCJK', expression: string, scope: SearchScope, limit: number): Promise<number[]> {
    if (!expression) return [];
    // MATCH runs unconstrained and the scope is applied afterwards: constraining
    // rowids inside the FTS query makes FTS5 evaluate row by row.
    const conditions = scopeConditions(scope);
    const ranked: number[] = [];
    await Zotero.DB.queryAsync(
        `WITH m AS MATERIALIZED (
             SELECT rowid AS id, bm25(${table}) AS score FROM ftindex.${table} WHERE ${table} MATCH ?
         )
         SELECT m.id FROM m
         JOIN items I ON I.itemID = m.id
         JOIN itemAttachments IA ON IA.itemID = m.id
         WHERE ${conditions.sql}
         ORDER BY m.score LIMIT ?`,
        [expression, ...conditions.params, limit],
        { onRow: (row: any) => { ranked.push(row.getResultByIndex(0)); } },
    );
    return ranked;
}

function fuse(lists: number[][], limit: number): number[] {
    const nonEmpty = lists.filter((list) => list.length);
    if (nonEmpty.length <= 1) return (nonEmpty[0] ?? []).slice(0, limit);
    const scores = new Map<number, number>();
    for (const list of nonEmpty) {
        list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([id]) => id);
}

/** Zotero 10+: BM25 over the word table, fused with the CJK table when the query has CJK terms. */
export async function rankWithFts5(terms: readonly QueryTerm[], scope: SearchScope, limit: number): Promise<number[]> {
    // A single CJK character has no 2-gram in Zotero's CJK table
    const usable = terms.filter((term) => !term.cjk || Array.from(term.text).length > 1);
    const [words, cjk] = await Promise.all([
        rankFts5Table('fulltextContent', ftsExpression(usable, false), scope, limit),
        rankFts5Table('fulltextContentCJK', ftsExpression(usable, true), scope, limit),
    ]);
    return fuse([words, cjk], limit);
}

/** Item IDs whose indexed content contains `text`, through Zotero's public search. */
async function searchContent(libraryID: number, text: string): Promise<number[]> {
    const search = new Zotero.Search();
    search.addCondition('libraryID', 'is', String(libraryID));
    search.addCondition('fulltextContent', 'contains', text);
    return await search.search();
}

/**
 * Zotero 7–9: one `fulltextContent` search per term and library, scoring each
 * attachment by the summed IDF of the terms it contains. Terms found in a large
 * share of the scope are skipped unless nothing else is left.
 */
export interface WordIndexRanking {
    ranked: number[];
    /** Some term searches failed or were cut off by the deadline. */
    incomplete: boolean;
    timedOut: boolean;
}

export async function rankWithWordIndex(
    terms: readonly QueryTerm[],
    scope: readonly ScopeAttachment[],
    limit: number,
    deadline: number,
): Promise<WordIndexRanking> {
    const scopeIDs = new Set(scope.map((attachment) => attachment.itemID));
    const libraries = [...new Set(scope.map((attachment) => attachment.libraryID))];
    const indexedCount = Math.max(1, scope.filter((attachment) => attachment.indexed).length);
    const hitsPerTerm: number[][] = [];
    let failed = false;
    let timedOut = false;
    for (const term of terms) {
        if (Date.now() > deadline) {
            timedOut = true;
            break;
        }
        const hits = new Set<number>();
        for (const libraryID of libraries) {
            if (Date.now() >= deadline) {
                timedOut = true;
                break;
            }
            try {
                // A slow search is abandoned at the deadline; its result is ignored
                const ids = await withDeadline(searchContent(libraryID, term.original), deadline);
                if (ids === 'timeout') {
                    timedOut = true;
                    break;
                }
                for (const id of ids) {
                    if (scopeIDs.has(id)) hits.add(id);
                }
            } catch (error) {
                failed = true;
                logger(`zoteroFulltext: word-index search failed for a term: ${error}`, 2);
            }
        }
        hitsPerTerm.push([...hits]);
    }
    const common = (hits: number[]) => hits.length > MAX_TERM_SHARE * indexedCount;
    const informative = hitsPerTerm.filter((hits) => hits.length && !common(hits));
    const used = informative.length ? informative : hitsPerTerm.filter((hits) => hits.length);
    const scores = new Map<number, number>();
    for (const hits of used) {
        const idf = Math.log(1 + (indexedCount - hits.length + 0.5) / (hits.length + 0.5));
        for (const id of hits) scores.set(id, (scores.get(id) ?? 0) + idf);
    }
    return {
        ranked: [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([id]) => id),
        incomplete: failed || timedOut,
        timedOut,
    };
}

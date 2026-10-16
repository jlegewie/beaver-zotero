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

import type { ZoteroFulltextEngine } from '@beaver/agent-core/protocol/agentProtocol';
import { logger } from '@beaver/agent-core/platform/logger';
import { processableAttachmentSql, processableKindFromStoredFields } from '../../utils/attachmentFiles';
import { ftsExpression, htmlToText, type QueryTerm } from './text';

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
    indexedPages: number | null;
    totalPages: number | null;
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
 * PDF, EPUB and snapshot attachments in scope, with Zotero's index state.
 *
 * `fts5` counts an attachment as indexed only once it is in Zotero's FTS5
 * content index: after an upgrade to Zotero 10, Zotero rebuilds that index in
 * the background from text it had already extracted, and until then the
 * attachment cannot be found.
 */
export async function listScopeAttachments(scope: SearchScope, engine: ZoteroFulltextEngine): Promise<ScopeAttachment[]> {
    if (!scope.libraryIds.length || (scope.itemIDs && !scope.itemIDs.length)) return [];
    const fts5 = engine === 'fts5';
    const conditions = scopeConditions(scope);
    const rows: ScopeAttachment[] = [];
    await Zotero.DB.queryAsync(
        `SELECT I.itemID, I.libraryID, I.key, IA.contentType, IA.path,
                FI.itemID IS NOT NULL, FI.indexedPages, FI.totalPages, FI.indexedChars, FI.totalChars,
                ${fts5 ? 'S.itemID IS NOT NULL' : '1'}, IA.storageHash, FI.synced
         FROM items I
         JOIN itemAttachments IA ON IA.itemID = I.itemID
         LEFT JOIN fulltextItems FI ON FI.itemID = I.itemID
         ${fts5 ? 'LEFT JOIN ftindex.fulltextIndexState S ON S.itemID = I.itemID' : ''}
         WHERE ${conditions.sql}`,
        conditions.params,
        {
            onRow: (row: any) => {
                const contentKind = processableKindFromStoredFields(row.getResultByIndex(3), row.getResultByIndex(4));
                if (!contentKind) return;
                const indexedPages = row.getResultByIndex(6);
                const totalPages = row.getResultByIndex(7);
                const indexedChars = row.getResultByIndex(8);
                const totalChars = row.getResultByIndex(9);
                // Same rule as Zotero.Fulltext.getIndexedState: pages for PDFs, characters
                // otherwise. A row whose file was missing at sync, or that has nothing
                // indexed yet (queued or unavailable), holds no searchable text.
                const usePages = contentKind === 'pdf' && indexedPages != null;
                const done = Number(usePages ? indexedPages : indexedChars) || 0;
                const total = Number(usePages ? totalPages : totalChars) || 0;
                const indexed = !!row.getResultByIndex(5)
                    && !!row.getResultByIndex(10)
                    && row.getResultByIndex(12) !== SYNC_STATE_MISSING
                    && done > 0;
                const partial = indexed && done < total;
                rows.push({
                    itemID: row.getResultByIndex(0),
                    libraryID: row.getResultByIndex(1),
                    key: row.getResultByIndex(2),
                    contentKind: contentKind as ContentKind,
                    indexed,
                    partial,
                    indexedPages: indexedPages ?? null,
                    totalPages: totalPages ?? null,
                    storageHash: row.getResultByIndex(11) || null,
                });
            },
        },
    );
    return rows;
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
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                timedOut = true;
                break;
            }
            try {
                // A slow search is abandoned at the deadline; its result is ignored
                const search = searchContent(libraryID, term.original);
                search.catch(() => undefined);
                let timer: ReturnType<typeof setTimeout> | undefined;
                const ids = await Promise.race([
                    search,
                    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
                ]).finally(() => clearTimeout(timer));
                if (!ids) {
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

/**
 * Text Zotero extracted for an attachment (`.zotero-ft-cache`), with form feeds
 * between PDF pages. Null when Zotero has no cache file for it.
 */
export async function readZoteroCacheText(item: Zotero.Item): Promise<string | null> {
    try {
        const file = Zotero.Fulltext.getItemCacheFile(item);
        const path = file?.path;
        if (!path || !(await IOUtils.exists(path))) return null;
        const text = await Zotero.File.getContentsAsync(path);
        return typeof text === 'string' && text.trim() ? text : null;
    } catch (error) {
        logger(`zoteroFulltext: could not read Zotero's text for ${item.libraryID}/${item.key}: ${error}`, 2);
        return null;
    }
}

/** Snapshot files above this size are not read for passages. */
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

/**
 * Visible text of a snapshot's own file. Zotero writes no text cache for some
 * snapshot types (XHTML), although it indexes them.
 */
export async function readSnapshotFileText(item: Zotero.Item): Promise<string | null> {
    try {
        const path = await item.getFilePathAsync();
        if (!path) return null;
        const info = await IOUtils.stat(path);
        if ((info.size ?? 0) > MAX_SNAPSHOT_BYTES) return null;
        const html = await Zotero.File.getContentsAsync(path);
        const text = typeof html === 'string' ? htmlToText(html) : '';
        return text.trim() ? text : null;
    } catch (error) {
        logger(`zoteroFulltext: could not read snapshot ${item.libraryID}/${item.key}: ${error}`, 2);
        return null;
    }
}

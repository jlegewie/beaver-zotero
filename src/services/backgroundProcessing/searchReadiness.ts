import type { SearchReadinessSummary } from '@beaver/agent-core/protocol/agentProtocol';
import type { AttachmentProcessingStateRecord } from '../database';
import type { AttachmentChange } from './reconciler';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import type { IndexRequirements } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { logger } from '@beaver/agent-core/platform/logger';

const DOCUMENT_REASONS: Record<string, string> = {
    file_missing: 'file_missing', remote_download_denied: 'remote_download_denied',
    encrypted: 'encrypted', encrypted_pdf: 'encrypted', corrupt_pdf: 'invalid_pdf', invalid_pdf: 'invalid_pdf',
    invalid_epub: 'invalid_epub', invalid_snapshot: 'invalid_snapshot',
    file_too_large: 'document_too_large', too_many_pages: 'document_too_large',
    pdf_too_complex: 'unsupported_document', empty_document: 'no_extractable_text',
    insufficient_text: 'no_extractable_text', low_confidence: 'no_extractable_text',
    no_text_layer: 'no_extractable_text', ocr_no_text: 'no_extractable_text', unsupported: 'unsupported_document',
    digital_signature: 'unsupported_document', image_too_large: 'document_too_large',
    render_failed: 'unsupported_document',
};
type Outcome = 'indexed' | 'pending' | { unavailable: string };
type Ref = { libraryId: number; zoteroKey: string };
type Count = SearchReadinessSummary['libraries'][number];
type Library = { keys: Set<string>; rows: Map<string, AttachmentProcessingStateRecord>; errors: Map<string, string>;
    outcomes: Map<string, Outcome>; dirty: Map<string, number>; count: Count };
export type Discovery = { libraryId: number; scope: number; changes: Map<string, number>;
    membership: Map<string, boolean> };

export function classifyPreparation(row: AttachmentProcessingStateRecord | undefined,
    errorCode: string | undefined, requirements: IndexRequirements, accountId: string,
    scopeRef: string, localId: string, hasOcrAccess = true): Outcome {
    if (!row) return 'pending';
    const identity = row.upsertRemoteIdentity;
    if (row.extractStatus === 'done' && row.structuredDocumentHash && row.upsertStatus === 'done'
        && requirements.index_incarnation && identity?.index_incarnation === requirements.index_incarnation
        && identity.index_account_id === accountId && identity.index_scope_ref === scopeRef
        && identity.index_local_id === localId && Number(row.upsertIndexVersion) === requirements.index_version
        && requirements.extract_schema_versions[row.contentKind]?.includes(row.extractSchemaVersion ?? '')) return 'indexed';
    if (row.ocrStatus === 'needed' || errorCode === 'ocr_required'
        || (row.contentKind === 'pdf' && errorCode === 'no_text_layer')) {
        return hasOcrAccess ? 'pending' : { unavailable: 'ocr_unavailable' };
    }
    if ((row.extractStatus === 'failed' || row.extractStatus === 'skipped' || row.ocrStatus === 'failed')
        && errorCode && DOCUMENT_REASONS[errorCode]) return { unavailable: DOCUMENT_REASONS[errorCode] };
    return 'pending';
}

/** Cached completed inventories, updated by attachment membership and durable writes. */
export class SearchReadiness {
    private scopeKey = '';
    private scopeRevision = 0;
    private revision = 0;
    private change = 0;
    private inventory = new Map<number, Library>();
    private discoveries = new Map<number, Discovery>();
    private rediscovery = new Set<number>();
    private requirements?: IndexRequirements;
    private summary: SearchReadinessSummary | null = null;
    private reading = false;
    private disposed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private ocrAccess = false;

    private syncScope(): { accountId: string; localId: string; libraries: number[] } {
        const owner = Zotero.Beaver;
        const accountId = owner?.account?.getSnapshot().session?.user.id ?? '';
        const localId = getZoteroUserIdentifier().localUserKey;
        const libraries = owner?.libraryScopeInitialized ? [...(owner.searchableLibraryIds ?? [])].sort((a,b) => a-b) : [];
        const key = JSON.stringify([accountId, localId, libraries, owner?.libraryScopeInitialized, owner?.hasSearchIndexAccess]);
        if (key !== this.scopeKey) {
            this.scopeKey = key;
            this.scopeRevision++;
            this.inventory.clear();
            this.discoveries.clear();
            this.rediscovery.clear();
            this.requirements = undefined;
            this.summary = null;
        }
        return { accountId, localId, libraries };
    }

    hasInventory(libraryId: number): boolean {
        this.syncScope();
        return this.inventory.has(libraryId);
    }

    needsDiscovery(libraryId?: number): boolean {
        this.syncScope();
        return libraryId === undefined ? this.rediscovery.size > 0 : this.rediscovery.has(libraryId);
    }

    beginDiscovery(libraryId: number): Discovery {
        this.syncScope();
        const discovery: Discovery = { libraryId, scope: this.scopeRevision, changes: new Map(), membership: new Map() };
        this.discoveries.set(libraryId, discovery);
        // A later unresolved notification must request another pass.
        this.rediscovery.delete(libraryId);
        return discovery;
    }

    cancelDiscovery(discovery: Discovery): void {
        if (this.discoveries.get(discovery.libraryId) !== discovery) return;
        this.discoveries.delete(discovery.libraryId);
        this.rediscovery.add(discovery.libraryId);
    }

    /** Replace a completed inventory; only writes observed during this pass need rereading. */
    async publishInventory(discovery: Discovery, keys: Iterable<string>, rows: AttachmentProcessingStateRecord[],
        errors: Map<string, string>, isCancelled: () => boolean = () => false): Promise<boolean> {
        this.syncScope();
        const current = () => !this.disposed && !isCancelled() && discovery.scope === this.scopeRevision
            && this.discoveries.get(discovery.libraryId) === discovery;
        if (!current()) return false;
        const library = this.makeLibrary(keys, rows, errors);
        const changes = new Map(discovery.changes);
        if (changes.size) {
            const refreshed = await this.readKeys(discovery.libraryId, [...changes.keys()]);
            this.syncScope();
            if (!current()) return false;
            for (const key of changes.keys()) this.storeRow(library, key, refreshed.rows.get(key), refreshed.errors.get(key));
        }
        // Membership notifications are newer than the enumeration, including deletions.
        for (const [key, included] of discovery.membership) {
            if (included) library.keys.add(key);
            else library.keys.delete(key);
        }
        for (const [key, version] of discovery.changes) {
            if (library.keys.has(key) && changes.get(key) !== version) library.dirty.set(key, version);
        }
        this.inventory.set(discovery.libraryId, library);
        this.discoveries.delete(discovery.libraryId);
        this.reclassify(library, discovery.libraryId);
        this.publish();
        this.schedule();
        return true;
    }

    private makeLibrary(keys: Iterable<string>, rows: AttachmentProcessingStateRecord[], errors: Map<string, string>): Library {
        return { keys: new Set(keys), rows: new Map(rows.map(row => [row.zoteroKey, row])), errors: new Map(errors),
            outcomes: new Map(), dirty: new Map(), count: { scope_ref: '', discovery_complete: true,
                inventory_revision: ++this.revision, indexed: 0, pending: 0, unavailable: 0, unavailable_reasons: {} } };
    }

    /** Resolve cheap membership hints immediately; parent/unknown identities are rediscovered. */
    notifyAttachments(events: AttachmentChange[]): void {
        this.syncScope();
        for (const event of events) {
            let libraryId = event.extra?.libraryID;
            try {
                const item = event.event === 'delete' ? undefined : Zotero.Items.get(event.id);
                libraryId = item?.libraryID ?? libraryId;
                const key = item?.key ?? event.extra?.key;
                if (libraryId != null && key && event.event === 'delete') {
                    this.updateAttachment(libraryId, key, false);
                    continue;
                }
                // Parent edits are resolved through the reconciler's targeted child path.
                if (item && !item.isAttachment()) continue;
                if (libraryId != null && key && item?.isAttachment()) {
                    const trashed = safeIsInTrash(item);
                    if (trashed !== null) {
                        const kind = getReadableContentKind(item);
                        this.updateAttachment(libraryId, key, !trashed
                            && (kind === 'pdf' || kind === 'epub' || kind === 'snapshot'));
                        continue;
                    }
                }
            } catch { /* The reconciler loads unresolved attachment and parent data. */ }
            this.requestDiscovery(libraryId);
        }
    }

    requestDiscovery(libraryId?: number): void {
        const { libraries } = this.syncScope();
        for (const id of libraries) {
            if (libraryId === undefined || id === libraryId) this.rediscovery.add(id);
        }
    }

    private setOutcome(library: Library, key: string, outcome?: Outcome): void {
        const adjust = (value: Outcome, delta: number) => {
            if (typeof value === 'string') library.count[value] += delta;
            else {
                library.count.unavailable += delta;
                const reasons = library.count.unavailable_reasons;
                reasons[value.unavailable] = (reasons[value.unavailable] ?? 0) + delta;
                if (!reasons[value.unavailable]) delete reasons[value.unavailable];
            }
        };
        const previous = library.outcomes.get(key);
        if (previous) adjust(previous, -1);
        if (outcome) { library.outcomes.set(key, outcome); adjust(outcome, 1); }
        else library.outcomes.delete(key);
    }

    updateAttachment(libraryId: number, key: string, included: boolean): void {
        this.syncScope();
        this.discoveries.get(libraryId)?.membership.set(key, included);
        const library = this.inventory.get(libraryId);
        if (!library) return;
        if (included) {
            if (library.keys.has(key)) return;
            library.keys.add(key);
            library.dirty.set(key, ++this.change);
            this.setOutcome(library, key, 'pending');
        } else {
            library.keys.delete(key);
            library.dirty.delete(key);
            library.rows.delete(key);
            library.errors.delete(key);
            this.setOutcome(library, key);
        }
        library.count.inventory_revision = ++this.revision;
        this.publish();
        this.schedule();
    }

    setRequirements(requirements: IndexRequirements): void {
        this.syncScope();
        if (JSON.stringify(this.requirements) === JSON.stringify(requirements)) return;
        this.requirements = requirements;
        for (const [id, library] of this.inventory) this.reclassify(library, id);
        this.publish();
        this.schedule();
    }

    getSummary(): SearchReadinessSummary | null {
        this.syncScope();
        if (this.ocrAccess !== (Zotero.Beaver?.hasOcrAccess === true)) this.publish();
        return this.summary;
    }

    /** Database writers report affected keys; unrelated acknowledgements remain usable. */
    changed = (refs: Ref[]): void => {
        this.syncScope();
        for (const ref of refs) {
            const version = ++this.change;
            this.discoveries.get(ref.libraryId)?.changes.set(ref.zoteroKey, version);
            const library = this.inventory.get(ref.libraryId);
            if (library?.keys.has(ref.zoteroKey)) {
                library.dirty.set(ref.zoteroKey, version);
                this.setOutcome(library, ref.zoteroKey, 'pending');
            }
        }
        this.publish();
        this.schedule();
    };

    private classify(library: Library, key: string, libraryId: number): Outcome {
        if (!this.requirements || library.dirty.has(key)) return 'pending';
        const { accountId, localId } = this.syncScope();
        return classifyPreparation(library.rows.get(key), library.errors.get(key), this.requirements,
            accountId, getIndexScopeRef(libraryId) ?? '', localId, Zotero.Beaver?.hasOcrAccess === true);
    }

    private reclassify(library: Library, libraryId: number): void {
        for (const key of library.keys) this.setOutcome(library, key, this.classify(library, key, libraryId));
    }

    private publish(): void {
        const { accountId, localId, libraries } = this.syncScope();
        const requirements = this.requirements;
        const ocrAccess = Zotero.Beaver?.hasOcrAccess === true;
        if (this.ocrAccess !== ocrAccess) {
            this.ocrAccess = ocrAccess;
            for (const [id, library] of this.inventory) this.reclassify(library, id);
        }
        if (!accountId || !Zotero.Beaver?.libraryScopeInitialized || !requirements
            || requirements.index_validity !== 'current' || !requirements.index_incarnation || this.disposed) {
            this.summary = null;
            return;
        }
        const counts: Count[] = [];
        for (const id of libraries) {
            const scopeRef = getIndexScopeRef(id);
            const library = this.inventory.get(id);
            if (!scopeRef || !library) { this.summary = null; return; }
            counts.push({ ...library.count, scope_ref: scopeRef, unavailable_reasons: { ...library.count.unavailable_reasons } });
        }
        this.summary = { version: 2, account_id: accountId, installation_id: localId,
            scope_revision: this.scopeRevision, index_version: requirements.index_version,
            extract_schema_versions: requirements.extract_schema_versions,
            index_incarnation: requirements.index_incarnation, libraries: counts };
    }

    private schedule(delay = 100): void {
        if (this.disposed || this.timer !== undefined || this.reading
            || ![...this.inventory.values()].some(library => library.dirty.size)) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
    }

    private async readKeys(libraryId: number, keys: string[]) {
        const rows = new Map<string, AttachmentProcessingStateRecord>();
        const errors = new Map<string, string>();
        const db = Zotero.Beaver.db!;
        // Bound SQL parameter counts, including large imports, without a full ledger walk.
        for (let start = 0; start < keys.length; start += 250) {
            const batch = keys.slice(start, start + 250);
            const [records, codes] = await Promise.all([
                db.getAttachmentProcessingStatesByLibrary(libraryId, batch),
                db.getAttachmentReadingErrorsByLibrary(libraryId, batch),
            ]);
            for (const row of records) rows.set(row.zoteroKey, row);
            for (const [key, code] of codes) errors.set(key, code);
        }
        return { rows, errors };
    }

    private storeRow(library: Library, key: string, row?: AttachmentProcessingStateRecord, error?: string): void {
        if (row) library.rows.set(key, row); else library.rows.delete(key);
        if (error) library.errors.set(key, error); else library.errors.delete(key);
    }

    async refresh(): Promise<void> {
        if (this.disposed || this.reading) return;
        this.reading = true;
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
        let retryDelay = 100;
        try {
            this.syncScope();
            for (const [libraryId, library] of this.inventory) {
                if (!library.dirty.size) continue;
                const batch = new Map(library.dirty);
                try {
                    const result = await this.readKeys(libraryId, [...batch.keys()]);
                    this.syncScope();
                    if (this.inventory.get(libraryId) !== library || this.disposed) continue;
                    for (const [key, version] of batch) {
                        if (library.dirty.get(key) !== version) continue;
                        library.dirty.delete(key);
                        this.storeRow(library, key, result.rows.get(key), result.errors.get(key));
                        this.setOutcome(library, key, this.classify(library, key, libraryId));
                    }
                } catch (error) {
                    retryDelay = 5000;
                    logger(`Search readiness refresh failed: ${error}`, 2);
                }
            }
            this.publish();
        } finally {
            this.reading = false;
            this.schedule(retryDelay);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.discoveries.clear();
        this.inventory.clear();
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.summary = null;
    }
}

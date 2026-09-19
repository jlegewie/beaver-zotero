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
type Library = { keys: Set<string>; outcomes: Map<string, Outcome>; dirty: Map<string, number>; full: boolean; count: Count };

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

/** One plugin-owned view of successful inventories and durable acknowledgements. */
export class SearchReadiness {
    private scopeKey = '';
    private scopeRevision = 0;
    private revision = 0;
    private change = 0;
    private inventory = new Map<number, Library>();
    private requirements?: IndexRequirements;
    private summary: SearchReadinessSummary | null = null;
    private reading = false;
    private pendingChanges = false;
    private membershipRevision = 0;
    private validityKnown = false;
    private disposed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private warnedScope?: number;

    private syncScope(): { accountId: string; localId: string; libraries: number[] } {
        const owner = Zotero.Beaver;
        const accountId = owner?.account?.getSnapshot().session?.user.id ?? '';
        const localId = getZoteroUserIdentifier().localUserKey;
        const libraries = owner?.libraryScopeInitialized ? [...(owner.searchableLibraryIds ?? [])].sort((a,b) => a-b) : [];
        const key = JSON.stringify([accountId, localId, libraries, owner?.hasSearchIndexAccess, owner?.hasOcrAccess]);
        if (key !== this.scopeKey) {
            this.scopeKey = key;
            this.scopeRevision++;
            this.revision++;
            this.inventory.clear();
            this.pendingChanges = false;
            this.membershipRevision++;
            this.requirements = undefined;
            this.validityKnown = false;
            this.summary = null;
        }
        return { accountId, localId, libraries };
    }

    membershipFence(): number { this.syncScope(); return this.membershipRevision; }
    discoveryFence(): number { this.syncScope(); return this.revision; }
    hasInventory(libraryId: number): boolean { this.syncScope(); return this.inventory.has(libraryId); }

    publishInventory(libraryId: number, keys: Iterable<string>, fence: number): boolean {
        this.syncScope();
        if (fence !== this.revision || this.disposed) return false;
        const library: Library = { keys: new Set(keys), outcomes: new Map(), dirty: new Map(), full: true,
            count: { scope_ref: '', discovery_complete: true, inventory_revision: fence,
                indexed: 0, pending: 0, unavailable: 0, unavailable_reasons: {} } };
        this.inventory.set(libraryId, library);
        for (const key of library.keys) this.invalidateKey(library, key);
        this.publish();
        this.schedule();
        return true;
    }

    beginChanges(events?: AttachmentChange[]): number {
        this.syncScope();
        this.membershipRevision++;
        let unresolved = events === undefined;
        for (const event of events ?? []) {
            if (!this.applyMembershipNotification(event)) unresolved = true;
        }
        if (unresolved) {
            this.pendingChanges = true;
            this.summary = null;
        }
        return this.membershipRevision;
    }

    private applyMembershipNotification(event: AttachmentChange): boolean {
        // Modifications can affect children or require loading attachment data.
        if (event.event === 'modify') return false;
        try {
            const item = event.event === 'delete' ? undefined : Zotero.Items.get(event.id);
            const libraryId = item?.libraryID ?? event.extra?.libraryID;
            const key = item?.key ?? event.extra?.key;
            if (libraryId == null || !key || !this.inventory.has(libraryId)) return false;
            if (event.event === 'delete') {
                this.updateAttachment(libraryId, key, false);
                return true;
            }
            if (!item?.isAttachment()) return false;
            const trashed = safeIsInTrash(item);
            if (trashed === null) return false;
            const kind = getReadableContentKind(item);
            this.updateAttachment(libraryId, key, !trashed
                && (kind === 'pdf' || kind === 'epub' || kind === 'snapshot'));
            return true;
        } catch {
            return false;
        }
    }

    completeChanges(fence: number): void {
        this.syncScope();
        if (fence !== this.membershipRevision) return;
        this.pendingChanges = false;
        this.publish();
        this.schedule();
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

    private invalidateKey(library: Library, key: string): void {
        library.dirty.set(key, ++this.change);
        this.setOutcome(library, key, 'pending');
    }

    updateAttachment(libraryId: number, key: string, included: boolean): void {
        const library = this.inventory.get(libraryId);
        if (!library) return;
        if (included) {
            library.keys.add(key);
            this.invalidateKey(library, key);
        } else {
            library.keys.delete(key); library.dirty.delete(key); this.setOutcome(library, key);
        }
        library.count.inventory_revision = this.revision;
        this.publish();
        this.schedule();
    }

    invalidateLibrary(libraryId: number): void {
        this.inventory.delete(libraryId);
        this.publish();
    }

    invalidateInventory(): void {
        this.syncScope(); this.revision++; this.inventory.clear(); this.publish();
    }

    setRequirements(requirements: IndexRequirements): void {
        this.syncScope();
        if (JSON.stringify(this.requirements) === JSON.stringify(requirements)) return;
        this.validityKnown = requirements.index_validity === 'current' || requirements.index_validity === 'missing';
        this.requirements = requirements;
        this.changed();
    }

    getSummary(): SearchReadinessSummary | null {
        this.syncScope();
        return this.pendingChanges || !this.validityKnown ? null : this.summary;
    }

    /** Dirty attachments become pending immediately; unrelated acknowledgements remain usable. */
    changed = (refs?: Ref[]): void => {
        this.syncScope();
        if (refs) {
            for (const ref of refs) {
                const library = this.inventory.get(ref.libraryId);
                if (library?.keys.has(ref.zoteroKey)) this.invalidateKey(library, ref.zoteroKey);
            }
        } else {
            for (const library of this.inventory.values()) {
                library.full = true;
                for (const key of library.keys) this.invalidateKey(library, key);
            }
        }
        this.publish();
        this.schedule();
    };

    private publish(): void {
        const { accountId, localId, libraries } = this.syncScope();
        const requirements = this.requirements;
        if (!accountId || !requirements || !this.validityKnown || this.pendingChanges || this.disposed) {
            this.summary = null;
            return;
        }
        const counts: Count[] = [];
        for (const id of libraries) {
            const scopeRef = getIndexScopeRef(id);
            if (!scopeRef) {
                if (this.warnedScope !== this.scopeRevision) {
                    logger('Search readiness: an included library has no portable scope; waiting for scope initialization', 2);
                    this.warnedScope = this.scopeRevision;
                }
                this.summary = null;
                return;
            }
            const count = this.inventory.get(id)?.count;
            counts.push(count ? { ...count, scope_ref: scopeRef, unavailable_reasons: { ...count.unavailable_reasons } }
                : { scope_ref: scopeRef, discovery_complete: false, inventory_revision: this.revision,
                    indexed: 0, pending: 0, unavailable: 0, unavailable_reasons: {} });
        }
        this.summary = { version: 2, account_id: accountId, installation_id: localId,
            scope_revision: this.scopeRevision, index_version: requirements.index_version,
            extract_schema_versions: requirements.extract_schema_versions,
            index_incarnation: requirements.index_incarnation ?? null, libraries: counts };
    }

    private schedule(delay = 100): void {
        if (this.disposed || this.timer !== undefined || this.reading) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
    }

    async refresh(): Promise<void> {
        if (this.disposed || this.reading) return;
        this.reading = true;
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
        let retryDelay = 100;
        let canRetry = false;
        try {
            const { accountId, localId, libraries } = this.syncScope();
            const requirements = this.requirements;
            const db = Zotero.Beaver?.db;
            if (!db || !requirements || !accountId || this.pendingChanges || !this.validityKnown) return;
            canRetry = true;
            for (const libraryId of libraries) {
                const library = this.inventory.get(libraryId);
                if (!library?.dirty.size) continue;
                const scopeRef = getIndexScopeRef(libraryId);
                if (!scopeRef) { canRetry = false; continue; }
                const full = library.full;
                const batch = new Map(full ? library.dirty : [...library.dirty].slice(0, 250));
                library.full = false;
                const keys = full ? undefined : [...batch.keys()];
                try {
                    const [rows, errors] = await Promise.all([
                        db.getAttachmentProcessingStatesByLibrary(libraryId, keys),
                        db.getAttachmentReadingErrorsByLibrary(libraryId, keys),
                    ]);
                    this.syncScope();
                    if (this.inventory.get(libraryId) !== library || this.requirements !== requirements || this.disposed) continue;
                    const byKey = new Map(rows.map(row => [row.zoteroKey, row]));
                    for (const [key, version] of batch) {
                        if (library.dirty.get(key) !== version) continue;
                        library.dirty.delete(key);
                        this.setOutcome(library, key, classifyPreparation(byKey.get(key), errors.get(key), requirements,
                            accountId, scopeRef, localId, Zotero.Beaver?.hasOcrAccess === true));
                    }
                } catch (error) {
                    retryDelay = 5000;
                    logger(`Search readiness refresh failed: ${error}`, 2);
                }
            }
            this.publish();
        } finally {
            this.reading = false;
            if (canRetry && !this.pendingChanges && this.validityKnown && [...this.inventory.values()].some(l => l.dirty.size)) this.schedule(retryDelay);
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.summary = null;
    }
}

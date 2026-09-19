import type { SearchReadinessSummary } from '@beaver/agent-core/protocol/agentProtocol';
import type { AttachmentProcessingStateRecord } from '../database';
import type { AttachmentChange } from './reconciler';
import type { IndexRequirements } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { logger } from '@beaver/agent-core/platform/logger';

const DOCUMENT_ERRORS = new Set([
    'file_missing', 'remote_download_denied', 'encrypted', 'encrypted_pdf', 'corrupt_pdf',
    'invalid_pdf', 'invalid_epub', 'invalid_snapshot', 'file_too_large', 'too_many_pages',
    'pdf_too_complex', 'empty_document', 'insufficient_text', 'low_confidence', 'no_text_layer',
    'ocr_no_text', 'unsupported', 'digital_signature', 'image_too_large', 'render_failed',
]);
type Outcome = 'indexed' | 'pending' | 'unavailable';
type Count = SearchReadinessSummary['libraries'][number];
type Library = { discovered: boolean; membershipRevision: number; revision: number; count?: Count };

export function classifyPreparation(row: AttachmentProcessingStateRecord | undefined,
    errorCode: string | undefined, requirements: IndexRequirements, accountId: string,
    scopeRef: string, localId: string, hasOcrAccess = true): Outcome {
    if (!row) return 'pending';
    const identity = row.upsertRemoteIdentity;
    if (row.extractStatus === 'done' && row.structuredDocumentHash && row.upsertStatus === 'done'
        && requirements.namespace_generation && identity?.namespace_generation === requirements.namespace_generation
        && identity.index_account_id === accountId && identity.index_scope_ref === scopeRef
        && identity.index_local_id === localId && Number(row.upsertIndexVersion) === requirements.index_version
        && requirements.extract_schema_versions[row.contentKind]?.includes(row.extractSchemaVersion ?? '')) return 'indexed';
    if (row.ocrStatus === 'needed' || errorCode === 'ocr_required'
        || (row.contentKind === 'pdf' && errorCode === 'no_text_layer')) {
        return hasOcrAccess ? 'pending' : 'unavailable';
    }
    if ((row.extractStatus === 'failed' || row.extractStatus === 'skipped' || row.ocrStatus === 'failed')
        && errorCode && DOCUMENT_ERRORS.has(errorCode)) return 'unavailable';
    return 'pending';
}

function classificationKey(requirements?: IndexRequirements): string {
    return JSON.stringify([requirements?.namespace_generation, requirements?.index_version,
        requirements?.extract_schema_versions]);
}

/** Library counts cached between durable writes and completed membership passes. */
export class SearchReadiness {
    private scopeKey = '';
    private scopeRevision = 0;
    private revision = 0;
    private libraries = new Map<number, Library>();
    private requirements?: IndexRequirements;
    private summary: SearchReadinessSummary | null = null;
    private reading = false;
    private disposed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private ocrAccess = false;

    private syncScope() {
        const owner = Zotero.Beaver;
        const accountId = owner?.account?.getSnapshot().session?.user.id ?? '';
        const localId = getZoteroUserIdentifier().localUserKey;
        const ids = owner?.libraryScopeInitialized ? [...(owner.searchableLibraryIds ?? [])].sort((a,b) => a-b) : [];
        const key = JSON.stringify([accountId, owner?.account?.getGeneration(), localId, ids, owner?.libraryScopeInitialized, owner?.hasSearchIndexAccess]);
        if (key !== this.scopeKey) {
            this.scopeKey = key;
            this.scopeRevision++;
            this.libraries = new Map(ids.map(id => [id, {
                discovered: false, membershipRevision: ++this.revision, revision: this.revision,
            }]));
            this.requirements = undefined;
            this.summary = null;
        }
        const ocrAccess = owner?.hasOcrAccess === true;
        if (ocrAccess !== this.ocrAccess) {
            this.ocrAccess = ocrAccess;
            this.summary = null;
            for (const library of this.libraries.values()) this.invalidate(library);
        }
        return { accountId, localId };
    }

    private invalidate(library: Library): void {
        library.revision = ++this.revision;
        library.count = undefined;
    }

    needsDiscovery(libraryId?: number): boolean {
        this.syncScope();
        return libraryId === undefined
            ? [...this.libraries.values()].some(library => !library.discovered)
            : this.libraries.get(libraryId)?.discovered === false;
    }

    requestDiscovery(libraryId?: number): void {
        this.syncScope();
        for (const [id, library] of this.libraries) {
            if (libraryId !== undefined && id !== libraryId) continue;
            this.invalidate(library);
            library.discovered = false;
            library.membershipRevision = library.revision;
        }
    }

    /** A pass can finish only if no newer membership or scope change superseded it. */
    beginDiscovery(libraryId: number): number | undefined {
        this.requestDiscovery(libraryId);
        return this.libraries.get(libraryId)?.membershipRevision;
    }

    completeDiscovery(libraryId: number, revision: number): boolean {
        this.syncScope();
        const library = this.libraries.get(libraryId);
        if (this.disposed || !library || library.membershipRevision !== revision) return false;
        library.discovered = true;
        this.invalidate(library);
        this.schedule();
        return true;
    }

    notifyAttachments(events: AttachmentChange[]): void {
        for (const event of events) {
            // Trash restoration and parent moves arrive as modify notifications.
            const changed = event.extra?.changed;
            if (event.event === 'modify' && !['deleted', 'parentKey'].some(field =>
                Object.prototype.hasOwnProperty.call(changed ?? {}, field))) continue;
            let libraryId = event.extra?.libraryID;
            try {
                const item = Zotero.Items.get(event.id);
                if (event.event === 'add' && item?.isAttachment?.() === false) continue;
                libraryId = item?.libraryID ?? libraryId;
            } catch { /* Unresolved membership changes invalidate every included library. */ }
            this.requestDiscovery(libraryId);
        }
    }

    setRequirements(requirements: IndexRequirements): void {
        this.syncScope();
        if (JSON.stringify(this.requirements) === JSON.stringify(requirements)) return;
        const classificationChanged = classificationKey(this.requirements) !== classificationKey(requirements);
        this.requirements = requirements;
        this.summary = null;
        if (classificationChanged) {
            for (const library of this.libraries.values()) this.invalidate(library);
        }
        this.publish();
        this.schedule();
    }

    getSummary(): SearchReadinessSummary | null {
        this.syncScope();
        this.schedule();
        return this.summary;
    }

    changed = (refs: Array<{ libraryId: number; zoteroKey: string }>): void => {
        this.syncScope();
        for (const id of new Set(refs.map(ref => ref.libraryId))) {
            const library = this.libraries.get(id);
            if (library) this.invalidate(library);
        }
        this.schedule();
    };

    private schedule(delay = 250): void {
        if (this.disposed || this.timer !== undefined || this.reading || !this.requirements
            || ![...this.libraries.values()].some(library => library.discovered && !library.count)) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
    }

    async refresh(): Promise<void> {
        if (this.disposed || this.reading) return;
        this.reading = true;
        if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
        let retryDelay = 250;
        try {
            const { accountId, localId } = this.syncScope();
            const requirements = this.requirements;
            if (!requirements) return;
            for (const [id, library] of this.libraries) {
                if (!library.discovered || library.count) continue;
                const revision = library.revision;
                const scopeRef = getIndexScopeRef(id);
                if (!scopeRef) { retryDelay = 5000; continue; }
                try {
                    const db = Zotero.Beaver.db!;
                    const [rows, errors] = await Promise.all([
                        db.getAttachmentProcessingStatesByLibrary(id),
                        db.getAttachmentReadingErrorsByLibrary(id),
                    ]);
                    this.syncScope();
                    if (classificationKey(this.requirements) !== classificationKey(requirements)) return;
                    if (this.disposed || this.libraries.get(id) !== library || library.revision !== revision) continue;
                    const count: Count = { scope_ref: scopeRef, discovery_complete: true,
                        inventory_revision: revision, indexed: 0, pending: 0, unavailable: 0 };
                    for (const row of rows) {
                        count[classifyPreparation(row, errors.get(row.zoteroKey), requirements,
                            accountId, scopeRef, localId, this.ocrAccess)]++;
                    }
                    library.count = count;
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

    private publish(): void {
        const { accountId, localId } = this.syncScope();
        const requirements = this.requirements;
        const counts = [...this.libraries.values()].map(library => library.count);
        if (this.disposed || !accountId || Zotero.Beaver?.hasSearchIndexAccess !== true
            || !Zotero.Beaver?.libraryScopeInitialized || requirements?.index_validity !== 'current'
            || !requirements.namespace_generation) {
            this.summary = null;
            return;
        }
        // Keep the last completed snapshot until every library has fresh counts.
        if (!counts.every((count): count is Count => !!count)) return;
        this.summary = { version: 2, account_id: accountId, installation_id: localId,
            scope_revision: this.scopeRevision, index_version: requirements.index_version,
            extract_schema_versions: requirements.extract_schema_versions,
            namespace_generation: requirements.namespace_generation, libraries: counts };
    }

    dispose(): void {
        this.disposed = true;
        this.libraries.clear();
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.summary = null;
    }
}

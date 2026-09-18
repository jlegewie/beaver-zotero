import type { SearchReadiness } from '@beaver/agent-core/protocol/agentProtocol';
import { discoverSearchCensus } from './searchCensus';
import { searchIndexApiClient } from './searchIndexApiClient';
import { evaluateSearchReadiness, unknownSearchReadiness } from './searchReadinessPolicy';
import { getZoteroUserIdentifier, getIndexScopeRef } from '../../utils/zoteroInstanceIdentity';

export interface SearchReadinessStatus {
    current: SearchReadiness;
    lastConfirmed: SearchReadiness | null;
    error: string | null;
    refreshing: boolean;
}

/** Plugin-owned discovery and verification, independent of preparation and windows. */
export class InstanceSearchReadiness {
    private scopeKey = '';
    private censusKey = '';
    private confirmedRefs = new Set<string>();
    private epoch = 0;
    private dirty = true;
    private stopped = false;
    private observation = unknownSearchReadiness();
    private lastConfirmed: SearchReadiness | null = null;
    private retainedReady = false;
    private error: string | null = null;
    private pending?: Promise<void>;
    private refreshRequested = false;
    private timer?: ReturnType<typeof setTimeout>;
    private observer?: string;

    private scope() {
        const owner = Zotero.Beaver;
        const account = owner?.account;
        const snapshot = account?.getSnapshot();
        const generation = account?.getGeneration();
        const ids = [...(owner?.searchableLibraryIds ?? [])].sort((a, b) => a - b);
        let enabled = !!owner?.libraryScopeInitialized && !!owner.hasSearchIndexAccess
            && !!snapshot?.session;
        let device: string | null = null;
        let refs: Array<[number, string | null]> = [];
        try {
            if (enabled) {
                device = getZoteroUserIdentifier().localUserKey;
                refs = ids.map((id) => [id, getIndexScopeRef(id)]);
                enabled = !!device && refs.every(([, ref]) => ref !== null);
            }
        } catch {
            enabled = false;
        }
        return { ids, enabled, device, generation, key: JSON.stringify([
            generation, snapshot?.session?.user.id,
            enabled, device, refs,
        ]) };
    }

    reconcile() {
        const scope = this.scope();
        if (scope.key !== this.scopeKey) {
            this.scopeKey = scope.key;
            this.censusKey = '';
            this.confirmedRefs.clear();
            this.epoch++;
            this.dirty = true;
            this.observation = unknownSearchReadiness();
            this.lastConfirmed = null;
            this.retainedReady = false;
            this.error = null;
        }
        return scope;
    }

    start(): void {
        this.stopped = false;
        this.observer = Zotero.Notifier.registerObserver({ notify: (event: string, type: string) => {
            if ((type === 'item' && ['add', 'modify', 'delete', 'trash'].includes(event)) || type === 'file') {
                this.epoch++;
                this.dirty = true;
                if (this.pending) this.refreshRequested = true;
                else this.schedule(1_000);
            }
        } } as any, ['item', 'file'], 'beaver-search-readiness');
        this.schedule(0);
    }

    private schedule(delay: number): void {
        if (this.stopped) return;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().finally(() => {
                // A notification after settlement may already have requested an earlier pass.
                if (this.timer === undefined) this.schedule(60_000);
            });
        }, delay);
    }

    getStatus(): SearchReadinessStatus {
        const scope = this.reconcile();
        let current = evaluateSearchReadiness(this.observation, this.retainedReady);
        if (this.stopped || !scope.enabled) current = { ...unknownSearchReadiness(), reason: 'unavailable' };
        else if (this.dirty) current = { ...current, ready: false, discovery_complete: false, reason: 'discovering' };
        return { current, lastConfirmed: this.lastConfirmed, error: this.error, refreshing: !!this.pending };
    }

    refresh(): Promise<void> {
        const scope = this.reconcile();
        if (this.stopped || !scope.enabled) return Promise.resolve();
        if (this.pending) return this.pending;
        this.refreshRequested = false;
        this.pending = this.collect(scope).finally(() => {
            this.pending = undefined;
            if (this.refreshRequested && !this.stopped && this.scope().enabled) return this.refresh();
            Zotero.Beaver?.runtime?.publish('background-processing:changed', {});
        });
        return this.pending;
    }

    private async collect(scope: ReturnType<InstanceSearchReadiness['scope']>): Promise<void> {
        const epoch = this.epoch;
        const current = () => !this.stopped && epoch === this.epoch
            && Zotero.Beaver?.account?.getGeneration() === scope.generation;
        const scopeCurrent = () => {
            if (!current()) return false;
            this.reconcile();
            return current();
        };
        try {
            const census = await discoverSearchCensus(scope.ids, current, scopeCurrent);
            if (!scopeCurrent()) return;
            const censusKey = JSON.stringify(census);
            if (censusKey !== this.censusKey) this.dirty = true;
            if (evaluateSearchReadiness(this.observation, this.retainedReady).reason === 'stale') {
                this.retainedReady = false;
            }
            const requirements = await searchIndexApiClient.requirements();
            if (!scopeCurrent()) return;
            const versionChanged = this.observation.index_version !== requirements.index_version
                || JSON.stringify(this.observation.extract_schema_versions) !== JSON.stringify(requirements.extract_schema_versions);
            if (versionChanged) {
                this.retainedReady = false;
                this.observation = { ...unknownSearchReadiness(), index_version: requirements.index_version,
                    extract_schema_versions: requirements.extract_schema_versions };
            }
            const libraries: SearchReadiness['libraries'] = [];
            const confirmedRefs = new Set<string>();
            // Use the start of verification, so a long pass cannot overstate freshness.
            const verifiedAt = new Date().toISOString();
            for (const library of census) {
                let confirmed = 0;
                const candidates = library.attachments.filter((attachment) => attachment.identity
                    && requirements.extract_schema_versions[attachment.contentKind]?.includes(attachment.identity.schemaVersion));
                for (let offset = 0; offset < candidates.length; offset += 50) {
                    if (!scopeCurrent()) return;
                    const batch = candidates.slice(offset, offset + 50);
                    const response = await searchIndexApiClient.verify(scope.device!, batch.map((attachment) => ({
                        scope_ref: library.scopeRef, zotero_key: attachment.zoteroKey, doc_hash: attachment.identity!.docHash,
                    })));
                    if (!scopeCurrent()) return;
                    const refs = new Map<string, (typeof response.refs)[number]>();
                    for (const ref of response.refs) {
                        const identity = JSON.stringify([ref.scope_ref, ref.zotero_key, ref.doc_hash]);
                        if (refs.has(identity)) throw new Error('Duplicate search verification');
                        refs.set(identity, ref);
                    }
                    for (const attachment of batch) {
                        const identity = JSON.stringify([library.scopeRef, attachment.zoteroKey, attachment.identity!.docHash]);
                        const ref = refs.get(identity);
                        if (!ref) throw new Error('Incomplete search verification');
                        if ((ref.state === 'current' || ref.state === 'empty')
                            && ref.index_version === requirements.index_version
                            && ref.extract_schema_version === attachment.identity!.schemaVersion) {
                            confirmed++;
                            confirmedRefs.add(identity);
                        } else if (this.confirmedRefs.has(identity)) {
                            // Positive evidence of lost membership revokes the old observation,
                            // even if a later batch fails before this pass can finish.
                            this.dirty = true;
                        }
                    }
                }
                libraries.push({ scope_ref: library.scopeRef, supported: library.attachments.length, confirmed });
            }
            if (!scopeCurrent()) return;
            // Extraction can replace a ledger hash without a Zotero item notification.
            // Never publish membership for identities that changed during verification.
            const after = await discoverSearchCensus(scope.ids, current, scopeCurrent);
            if (!scopeCurrent()) return;
            if (JSON.stringify(after) !== censusKey) {
                this.dirty = true;
                return;
            }
            const observation: SearchReadiness = { ...unknownSearchReadiness(),
                discovery_complete: true, verified_at: verifiedAt, index_version: requirements.index_version,
                extract_schema_versions: requirements.extract_schema_versions, zotero_local_id: scope.device, libraries };
            this.observation = evaluateSearchReadiness(observation, this.retainedReady);
            this.retainedReady = this.observation.ready;
            this.lastConfirmed = this.observation;
            this.censusKey = censusKey;
            this.confirmedRefs = confirmedRefs;
            this.dirty = false;
            this.error = null;
        } catch (error) {
            if (scopeCurrent()) this.error = 'Could not verify current search coverage.';
        }
    }

    async dispose(): Promise<void> {
        this.stopped = true;
        this.refreshRequested = false;
        this.epoch++;
        if (this.timer !== undefined) clearTimeout(this.timer);
        if (this.observer) Zotero.Notifier.unregisterObserver(this.observer);
        this.observer = undefined;
        await this.pending;
    }
}

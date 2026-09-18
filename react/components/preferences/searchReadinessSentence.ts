import type { ZoteroLibrary } from '@beaver/agent-core/types/zotero';
import type { SearchReadiness } from '@beaver/agent-core/protocol/agentProtocol';
import type { SearchReadinessStatus } from '../../../src/services/searchIndex/instanceSearchReadiness';
import type { StatusTone } from './processingStatusSentence';
import { plural } from './processingStatusSentence';

export interface SearchReadinessSentence {
    tone: StatusTone;
    headline: string;
    caption: string;
    /** Libraries that keep full-text search off, one line each. */
    libraries: string[];
}

/** Initial per-library share of indexed files that turns full-text search on. */
const READY_PERCENT = 95;

interface Coverage { confirmed: number; supported: number }

function sum(libraries: SearchReadiness['libraries']): Coverage {
    return libraries.reduce(
        (total, library) => ({ confirmed: total.confirmed + library.confirmed, supported: total.supported + library.supported }),
        { confirmed: 0, supported: 0 },
    );
}

/** Whole percent, rounded down so the number never overstates the policy check. */
function percent({ confirmed, supported }: Coverage): number {
    return supported > 0 ? Math.floor((confirmed * 100) / supported) : 0;
}

function coverageText(coverage: Coverage): string {
    return `${coverage.confirmed.toLocaleString()} of ${plural(coverage.supported, 'file')} indexed (${percent(coverage)}%)`;
}

/** "today at 3:54 PM", "yesterday at 3:54 PM", "on Sep 17 at 3:54 PM". */
export function describeCheckedAt(iso: string, now = new Date()): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'at an unknown time';
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const dayDifference = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
    if (dayDifference === 0) return `today at ${time}`;
    if (dayDifference === 1) return `yesterday at ${time}`;
    const day = date.toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
    return `on ${day} at ${time}`;
}

/** Display name for an index scope ref (`l<userKey>` or `g<groupID>`). */
function libraryName(scopeRef: string, libraries: readonly ZoteroLibrary[]): string {
    if (scopeRef.startsWith('g')) {
        const groupId = Number(scopeRef.slice(1));
        return libraries.find((library) => library.group_id === groupId)?.name ?? `Group library ${groupId}`;
    }
    return libraries.find((library) => !library.is_group)?.name ?? 'My Library';
}

/**
 * Reduce the verified coverage status to a headline, a caption, and the
 * libraries holding full-text search back. The policy's fail-closed reasons
 * (`unknown`, `stale`) read as "Checking…": a recheck follows within a minute,
 * and the difference never matters to the user.
 */
export function describeSearchReadiness(
    status: SearchReadinessStatus | undefined,
    libraries: readonly ZoteroLibrary[] = [],
    now = new Date(),
): SearchReadinessSentence {
    if (!status) return { tone: 'waiting', headline: 'Checking…', caption: 'Reading full-text search status.', libraries: [] };
    const { current, lastConfirmed, error } = status;
    if (error) {
        // After a failed check the current observation is itself the last success.
        const known = current.discovery_complete && current.verified_at ? current : lastConfirmed;
        const lastKnown = known?.verified_at
            ? ` Last successful check: ${coverageText(sum(known.libraries))}, ${describeCheckedAt(known.verified_at, now)}.`
            : '';
        return {
            tone: 'error', headline: 'Could not check',
            caption: `${error} Beaver will try again automatically.${lastKnown}`, libraries: [],
        };
    }
    switch (current.reason) {
        case 'unavailable':
            return { tone: 'waiting', headline: 'Not available', caption: 'Full-text search is not available for this account right now.', libraries: [] };
        case 'discovering':
        case 'unknown':
        case 'stale':
            return { tone: 'busy', headline: 'Checking…', caption: 'Comparing the files in your libraries with the search index.', libraries: [] };
        case 'empty':
            return { tone: 'idle', headline: 'Nothing to search yet', caption: 'The included libraries have no PDF, EPUB, or web snapshot files to search.', libraries: [] };
        case 'ready': {
            const checked = current.verified_at ? ` Last checked ${describeCheckedAt(current.verified_at, now)}.` : '';
            return { tone: 'idle', headline: 'Ready', caption: `${coverageText(sum(current.libraries))}.${checked}`, libraries: [] };
        }
        case 'coverage': {
            const behind = current.libraries.length > 1
                ? current.libraries
                    .filter((library) => library.supported > 0 && percent(library) < READY_PERCENT)
                    .map((library) => `${libraryName(library.scope_ref, libraries)}: ${coverageText(library)}`)
                : [];
            return {
                tone: 'waiting', headline: 'Not ready yet',
                caption: `${coverageText(sum(current.libraries))}. Full-text search turns on once at least ${READY_PERCENT}% of the files in each library are indexed.`,
                libraries: behind,
            };
        }
    }
}

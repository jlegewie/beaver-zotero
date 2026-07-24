/**
 * Helpers for driving Beaver's surfaces (main-window sidebar, separate window),
 * the selected Zotero tab, and the in-memory library-exclusion set, plus reading
 * back the run context those produce.
 *
 * Talks to the dev-only `/beaver/test/*` endpoints registered in
 * `useHttpEndpoints.ts`. The surface/tab endpoints wait for reader tracking to
 * settle before returning, so a caller can read `applicationState()` straight
 * after without racing React.
 */

import { post } from './zoteroHttpClient';

export interface Surfaces {
    sidebar_visible: boolean;
    window_open: boolean;
    beaver_ui_visible: boolean;
    is_library_tab: boolean;
}

export interface ReaderState {
    library_id: number;
    zotero_key: string;
    library_ref?: string;
    current_page?: number | null;
    content_kind?: 'pdf' | 'epub' | 'snapshot';
    text_selection?: { text: string } | null;
}

export interface ApplicationStateResponse {
    ok: boolean;
    application_state: {
        current_view: 'library' | 'file_reader' | 'note_editor';
        reader_state?: ReaderState;
        current_library?: { library_id: number; is_synced?: boolean };
    };
    surfaces: Surfaces;
    context_atoms: {
        reader_attachment: { library_id: number; zotero_key: string } | null;
        reader_text_selection: unknown;
        note_item: { library_id: number; zotero_key: string } | null;
    };
}

/** Common shape of the endpoints that change a surface or the selected tab. */
export interface SettleResponse {
    ok: boolean;
    /**
     * Whether reader tracking reached AND held the state the open surfaces and
     * selected tab imply. False means the transition never converged — always
     * assert on it rather than only on the state that follows.
     */
    reader_context_settled: boolean;
    surfaces: Surfaces;
}

export interface WindowResponse extends SettleResponse {
    /** Null when no separate window is open. */
    owner_is_main_window: boolean | null;
}

export interface SelectTabResponse extends SettleResponse {
    selected_tab_type: string | null;
    reader_item_id: number | null;
    error?: string;
}

export interface ExclusionState {
    ok: boolean;
    has_profile: boolean;
    excluded_libraries: Array<{ type: 'user' | 'group'; group_id?: number }>;
    searchable_library_ids: number[];
    local_library_ids: number[];
}

/**
 * How long the endpoints wait for a transition to settle.
 *
 * Deliberately well above the endpoints' own default: the first time a given
 * PDF is opened in a session, the work that follows (validation, extraction)
 * competes with the settle poll on Zotero's main thread and a transition that
 * normally lands in ~1s can take an order of magnitude longer. A tight budget
 * here shows up as an order-dependent failure, not as a real defect.
 */
export const SETTLE_TIMEOUT_MS = 45000;

/** Matching client-side budget — the request must never outlive the wait. */
const REQUEST_TIMEOUT_MS = SETTLE_TIMEOUT_MS + 15000;

const settlePost = <T>(path: string, body: Record<string, unknown>) =>
    post<T>(path, { timeout_ms: SETTLE_TIMEOUT_MS, ...body }, { timeout: REQUEST_TIMEOUT_MS });

/** The `application_state` an agent run would send right now. */
export const applicationState = () =>
    post<ApplicationStateResponse>('/beaver/test/application-state', {});

/** Open or close the separate Beaver window. */
export const setBeaverWindow = (open: boolean) =>
    settlePost<WindowResponse>('/beaver/test/beaver-window', { open });

/** Show or hide the main-window sidebar. */
export const setBeaverSidebar = (open: boolean) =>
    settlePost<SettleResponse>('/beaver/test/beaver-sidebar', { open });

/** Select the library tab. */
export const selectLibraryTab = () =>
    settlePost<SelectTabResponse>('/beaver/test/select-tab', { tab: 'library' });

/**
 * Open (or re-select) an attachment's reader tab.
 *
 * `closeTabs` closes every reader tab first, so the selection is a genuine cold
 * open — the reader instance does not exist yet when tracking is notified.
 */
export const selectReaderTab = (
    attachment: { library_id: number; zotero_key: string },
    opts?: { closeTabs?: boolean },
) =>
    settlePost<SelectTabResponse>('/beaver/test/select-tab', {
        ...attachment,
        ...(opts?.closeTabs && { close_tabs: true }),
    });

/** Read the in-memory excluded-libraries set and what it makes searchable. */
export const getExclusionState = () =>
    post<ExclusionState>('/beaver/test/excluded-libraries', { action: 'get' });

/** Overwrite the in-memory excluded set by library id (never persisted). */
export const excludeLibraries = (libraryIds: number[]) =>
    post<ExclusionState>('/beaver/test/excluded-libraries', {
        action: 'set',
        exclude_library_ids: libraryIds,
    });

/** Restore a previously captured excluded set verbatim. */
export const restoreExclusions = (entries: ExclusionState['excluded_libraries']) =>
    post<ExclusionState>('/beaver/test/excluded-libraries', {
        action: 'set',
        excluded_libraries: entries,
    });

/**
 * Put Beaver into a known surface state: both surfaces closed.
 *
 * Order matters — closing the window first means the final wait covers the
 * sidebar transition, which is the one that decides whether tracking stops.
 */
export async function closeAllSurfaces(): Promise<void> {
    await setBeaverWindow(false);
    await setBeaverSidebar(false);
}

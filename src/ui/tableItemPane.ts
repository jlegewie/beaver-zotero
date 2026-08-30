/**
 * The item-pane section for a stored table.
 *
 * A table is a Zotero item, so selecting one in the library shows the pane
 * Zotero shows for any snapshot: a file name, a URL, an "archived from" link.
 * None of that says anything about the table. This section replaces that
 * silence with the three facts a stored table has and a snapshot does not —
 * how big it is and how much of it is filled in, how much of it we are unsure
 * about, and which version it is at — plus the ways to open it.
 *
 * It is also where a table that went *backwards* is surfaced: a Zotero file
 * conflict resolved toward another device replaces the whole storage directory,
 * so the table looks healthy and is simply older than what this device wrote.
 * The section says so and offers the one action that undoes it, which — being a
 * write — goes through `Zotero.__beaverTables`. See `recoveryShadow.ts`.
 *
 * ## Where the numbers come from
 *
 * The version log's tip entry carries the `summarize()` of the spec that was
 * written ({@link readTableHistory}), so the section reads counts without
 * parsing the megabyte of JSON embedded in the document. Only a table with no
 * usable log falls back to reading the spec — and a table the log gives reason
 * to suspect a sync conflict on, because that claim is the document's to make
 * and not the log's. The arithmetic and the wording live in
 * `tableItemPaneModel.ts`, which is pure; this file is the Zotero half:
 * registration, reading, DOM, and the buttons.
 *
 * ## Constraints
 *
 * **Nothing here may throw.** An exception out of a section hook lands in
 * Zotero's item pane, which is not ours to break; every step degrades to
 * showing less. Absent `ItemPaneManager` (an older Zotero) means the section
 * simply never registers.
 *
 * **Esbuild bundle only.** `src/hooks.ts` registers this, so it is compiled
 * into `beaver.js`, where React, the Jotai store and `process` do not exist —
 * hence `tableItemIdentity.ts` rather than `tableItem.ts`/`tableStore.ts` for
 * reading, and `getTablesApi()` rather than a direct import for opening.
 * `registeredPaneID` below is module state, so a second copy of this module
 * would be a second registration that {@link cleanupTableItemPane} never
 * unregisters; the webpack side reaches this through `Zotero.__beaverTables`.
 *
 * Reading a table to describe it is not gated on library exclusion, and neither
 * are the actions: exclusion governs writes, indexing and what leaves the
 * machine, not whether a user may look at an item already in their library.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { summarize } from '@beaver/agent-core/layouts/tableMutations';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import {
    isTableItem,
    loadTableItemFields,
    readTableHistory,
    readTableItemSpec,
    type TableRef,
} from '../services/artifacts/tableItemIdentity';
import { getTablesApi } from '../services/artifacts/tablesApi';
import {
    detectTableSyncConflict,
    lastTableShadow,
    tableSpecHash,
    type TableShadowEntry,
} from '../services/artifacts/recoveryShadow';
import {
    buildTableSectionFields,
    tipVersionEntry,
    type TableSectionConflict,
    type TableSectionFields,
    type TableSectionInput,
} from './tableItemPaneModel';

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Our half of the pane id; Zotero namespaces it with the plugin id. */
const PANE_ID = 'beaver-table';

/**
 * Zotero namespaces the pane id with this and drops the section when the plugin
 * is disabled, so it must be the real add-on id. Read through `Zotero.Beaver`
 * rather than the bare `addon` global, which exists in one bundle only.
 */
function pluginID(): string {
    const configured = (
        Zotero.Beaver as unknown as
            | { data?: { config?: { addonID?: string } } }
            | undefined
    )?.data?.config?.addonID;
    return configured || 'beaver@jlegewie.com';
}

/** 16×16 in the section header, 20×20 in the sidenav. One asset serves both. */
const ICON = 'chrome://beaver/content/icons/beaver_bw.png';

/**
 * The id Zotero returned, which is the namespaced one
 * (`<pluginID>-<paneID>`, CSS-escaped) and the only value
 * `unregisterSection` accepts. Null when the section is not registered.
 */
let registeredPaneID: string | null = null;

function itemPaneManager(): _ZoteroTypes.ItemPaneManager | null {
    const manager = (Zotero as { ItemPaneManager?: _ZoteroTypes.ItemPaneManager })
        .ItemPaneManager;
    return manager && typeof manager.registerSection === 'function' ? manager : null;
}

/** Whether this bundle currently owns a registered section. */
export function isTableItemPaneRegistered(): boolean {
    return registeredPaneID !== null;
}

/** The namespaced pane id Zotero assigned, or null. */
export function tableItemPaneID(): string | null {
    return registeredPaneID;
}

/**
 * Registers the section. Safe to call twice — a plugin reload unregisters the
 * previous one first rather than leaving a section nothing can remove.
 */
export function initTableItemPane(): void {
    const manager = itemPaneManager();
    if (!manager) {
        logger('tableItemPane: this Zotero has no ItemPaneManager; skipping', 2);
        return;
    }
    cleanupTableItemPane();
    try {
        const result = manager.registerSection({
            paneID: PANE_ID,
            pluginID: pluginID(),
            header: { l10nID: 'beaver-table-section-header', icon: ICON },
            sidenav: { l10nID: 'beaver-table-section-sidenav', icon: ICON },
            onItemChange: handleItemChange,
            onRender: handleRender,
            onAsyncRender: handleAsyncRender,
        });
        registeredPaneID = typeof result === 'string' ? result : null;
        if (!registeredPaneID) {
            logger('tableItemPane: registerSection refused the section', 1);
        }
    } catch (error) {
        registeredPaneID = null;
        logger(`tableItemPane: could not register: ${String(error)}`, 1);
    }
}

/** Unregisters it, so a torn-down bundle leaves no section behind. */
export function cleanupTableItemPane(): void {
    if (!registeredPaneID) return;
    const id = registeredPaneID;
    registeredPaneID = null;
    try {
        itemPaneManager()?.unregisterSection(id);
    } catch (error) {
        logger(`tableItemPane: could not unregister ${id}: ${String(error)}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Recognising the item, twice
// ---------------------------------------------------------------------------

/**
 * The cheapest test that can be wrong in only one direction.
 *
 * `onItemChange` decides synchronously whether the section exists at all, and
 * Zotero skips both render hooks for a hidden section — so a "no" here is
 * final and must never be wrong. Everything it reads is primary data, present
 * on any loaded item; the marks that need `itemData` and `tags`
 * ({@link isTableItem}) are checked once those are loaded, and the section
 * hides itself then.
 */
function couldBeTableItem(item: Zotero.Item | null | undefined): boolean {
    try {
        if (!item || !item.isAttachment() || !item.isTopLevelItem()) return false;
        if (item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_IMPORTED_URL) {
            return false;
        }
        return item.attachmentContentType === 'text/html';
    } catch {
        return false;
    }
}

/**
 * The real test, on an item whose lazy data may not be loaded.
 *
 * `isTableItem` reads tags, which throws on an unloaded item rather than
 * answering false, so "we cannot tell yet" is a third answer here and not a no.
 */
function knownTableItem(item: Zotero.Item): boolean | null {
    try {
        return isTableItem(item);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Reading what the section shows
// ---------------------------------------------------------------------------

export interface TableSectionData {
    fields: TableSectionFields;
    /** Why the counts are missing, when they are. */
    reason: string | null;
    /** Whether the reader action has a file to open. */
    hasFile: boolean;
}

/** Column headers by id, so a distribution read from a spec is labelled. */
function headersOf(spec: TableSpec): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const column of spec.columns ?? []) {
        if (column?.id && column.header) headers[column.id] = column.header;
    }
    return headers;
}

/**
 * When each annotation's position was captured.
 *
 * `dateAdded`, not `dateModified`: an annotation's offsets are fixed when it is
 * placed, and editing its comment afterwards does not re-anchor it.
 */
async function annotationDates(item: Zotero.Item): Promise<string[]> {
    try {
        if (!item.isFileAttachment()) return [];
        await item.loadDataType('childItems');
        return (item.getAnnotations() as Zotero.Item[])
            .map((annotation) => annotation?.dateAdded)
            .filter((date): date is string => typeof date === 'string' && !!date);
    } catch (error) {
        logger(`tableItemPane: could not read annotations: ${String(error)}`, 2);
        return [];
    }
}

/**
 * Everything the section shows for one item.
 *
 * The log is tried first and the spec only as a fallback, because the log's tip
 * entry already holds the summary and the spec is the megabyte we are avoiding.
 */
export async function readTableSectionData(
    item: Zotero.Item
): Promise<TableSectionData> {
    const input: TableSectionInput = {
        summary: null,
        source: null,
        version: null,
        history: [],
        annotationDates: await annotationDates(item),
    };
    let reason: string | null = null;
    // The spec, when the fallback below already had to read it. Handed to the
    // conflict check so it never reads the document twice.
    let documentSpec: TableSpec | null = null;

    const history = await readTableHistory(item);
    input.history = history.versions;

    const tip = tipVersionEntry(history.versions);
    if (tip) {
        input.summary = tip.summary;
        input.source = 'history';
        input.version = Math.max(history.tip, tip.version);
    } else {
        const read = await readTableItemSpec(item);
        if (read.ok) {
            documentSpec = read.spec;
            input.summary = summarize(read.spec);
            input.source = 'spec';
            input.version =
                typeof read.spec.version === 'number' ? read.spec.version : null;
            input.headers = headersOf(read.spec);
        } else {
            reason = read.message;
        }
    }

    const logVersion = tip ? Math.max(history.tip, tip.version) : null;
    input.conflict = await readTableConflict(item, {
        logVersion,
        // Paired with a version only when the log's own two answers agree about
        // which version is the tip.
        logSha256: tip && tip.version === logVersion ? (tip.sha256 ?? null) : null,
        spec: documentSpec,
    });

    let hasFile = false;
    try {
        hasFile = !!(await item.getFilePathAsync());
    } catch (error) {
        logger(`tableItemPane: could not resolve the file: ${String(error)}`, 2);
    }

    return { fields: buildTableSectionFields(input), reason, hasFile };
}

/** What the section already knows about the table when it asks about a conflict. */
interface ConflictSources {
    /** The version log's tip, or null when it has no usable entry. */
    logVersion: number | null;
    /** The tip's digest, when it is the digest of `logVersion`. */
    logSha256: string | null;
    /** The document's spec, when the section already read it. */
    spec: TableSpec | null;
}

/**
 * Whether this table went backwards under this device.
 *
 * **The document decides.** It is the store's commit point, so it — not the log
 * — is the authority on what version a table is at, and it is what the store's
 * own check compares against. Judging the log instead reports a conflict on an
 * ordinary interrupted write: a commit that landed before its log entry did
 * leaves a log one version behind, which is a state the next open silently
 * repairs, and calling it "another device replaced your table" is exactly the
 * false positive `recoveryShadow.ts` says is worse than the loss it warns about.
 *
 * The log still keeps this cheap. It is never *ahead* of the document — the
 * document is written first — so a log level with or above the shadow rules a
 * conflict out on its own, and the common case answers without parsing the
 * megabyte of JSON in the file. Only a log that would raise the alarm is worth
 * reading the document for, and then the document's answer is the one reported.
 */
async function readTableConflict(
    item: Zotero.Item,
    sources: ConflictSources
): Promise<TableSectionConflict | null> {
    try {
        const shadow = await lastTableShadow({
            libraryID: item.libraryID,
            key: item.key,
        });
        if (!shadow) return null;

        // Already read, so there is nothing cheaper to screen with.
        if (sources.spec) return await judgeDocument(shadow, sources.spec);

        if (typeof sources.logVersion !== 'number' || sources.logVersion <= 0) {
            return null;
        }
        const screened = detectTableSyncConflict(shadow, {
            version: sources.logVersion,
            sha256: sources.logSha256,
        });
        if (!screened) return null;

        const read = await readTableItemSpec(item);
        // A document that cannot be read cannot support the claim, and the
        // section says nothing rather than repeating the log's word for it.
        return read.ok ? await judgeDocument(shadow, read.spec) : null;
    } catch (error) {
        logger(`tableItemPane: could not read the recovery shadow: ${String(error)}`, 2);
        return null;
    }
}

/** The shadow against the document, the way the store compares them. */
async function judgeDocument(
    shadow: TableShadowEntry,
    spec: TableSpec
): Promise<TableSectionConflict | null> {
    const version = typeof spec.version === 'number' ? spec.version : 0;
    // Hashed only when the numbers are equal, because that is the only case the
    // digest decides.
    const sha256 = version === shadow.version ? await tableSpecHash(spec) : null;
    return detectTableSyncConflict(shadow, { version, sha256 });
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

type HookArgs = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;

/** Stamped on the body so an async render can tell it is still wanted. */
const ITEM_ATTRIBUTE = 'data-beaver-table-item';

function handleItemChange({ item, setEnabled }: HookArgs): void {
    try {
        setEnabled(couldBeTableItem(item));
    } catch (error) {
        logger(`tableItemPane: onItemChange failed: ${String(error)}`, 2);
    }
}

/**
 * The synchronous half: reset the body and put the actions up.
 *
 * The actions need no I/O, so they render immediately and the section has its
 * height before the counts arrive. If the item's data happens to be loaded and
 * says this is not one of ours, the section hides itself here — before anything
 * paints — and the asynchronous half is skipped.
 */
function handleRender({ doc, body, item, setEnabled, setSectionSummary }: HookArgs): void {
    try {
        body.setAttribute(ITEM_ATTRIBUTE, String(item?.id ?? ''));
        body.replaceChildren();
        setSectionSummary('');
        if (knownTableItem(item) === false) {
            setEnabled(false);
            return;
        }
        const root = doc.createElement('div');
        root.className = 'beaver-table-section';
        const facts = doc.createElement('div');
        facts.className = 'beaver-table-section-facts';
        root.append(facts, renderActions(doc, item));
        body.append(root);
    } catch (error) {
        logger(`tableItemPane: onRender failed: ${String(error)}`, 2);
    }
}

/** The half that reads from disk: the counts, the version, the caveat. */
async function handleAsyncRender({
    doc,
    body,
    item,
    setEnabled,
    setSectionSummary,
}: HookArgs): Promise<void> {
    try {
        const stamp = body.getAttribute(ITEM_ATTRIBUTE);

        await loadTableItemFields([item]);
        if (!isTableItem(item)) {
            setEnabled(false);
            return;
        }

        const data = await readTableSectionData(item);
        // The selection can move while the read is in flight; a late render
        // into the next item's body would show one table's numbers under
        // another's title.
        if (body.getAttribute(ITEM_ATTRIBUTE) !== stamp) return;

        const facts = body.querySelector('.beaver-table-section-facts');
        if (!facts) return;
        facts.replaceChildren();

        if (data.reason) {
            facts.append(line(doc, data.reason, 'beaver-table-section-problem'));
        }
        for (const text of [
            data.fields.dimensionsLine,
            data.fields.coverageLine,
            data.fields.versionLine,
        ]) {
            if (text) facts.append(line(doc, text));
        }
        if (data.fields.flagsLine) {
            facts.append(line(doc, data.fields.flagsLine, 'beaver-table-section-flags'));
        }
        for (const distribution of data.fields.distributions) {
            facts.append(renderDistribution(doc, distribution));
        }
        if (data.fields.warning) {
            facts.append(
                line(doc, data.fields.warning, 'beaver-table-section-warning')
            );
        }
        // Last, and styled apart: everything above describes the table, this
        // describes something that happened to it.
        if (data.fields.conflictLine) {
            facts.append(
                line(doc, data.fields.conflictLine, 'beaver-table-section-conflict')
            );
        }
        setSectionSummary(data.fields.headerSummary);

        const reader = body.querySelector<HTMLButtonElement>(
            '[data-beaver-action="reader"]'
        );
        if (reader) reader.disabled = !data.hasFile;

        const restore = body.querySelector<HTMLButtonElement>(
            '[data-beaver-action="restore-shadow"]'
        );
        if (restore) {
            const actions = tableSectionActions(
                windowOf(doc),
                data.hasFile,
                !!data.fields.conflict?.restorable
            );
            restore.disabled = !actions.restoreShadow;
            restore.hidden = !actions.restoreShadow;
        }
    } catch (error) {
        logger(`tableItemPane: onAsyncRender failed: ${String(error)}`, 2);
    }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function line(doc: Document, text: string, className?: string): HTMLElement {
    const element = doc.createElement('div');
    element.className = className
        ? `beaver-table-section-line ${className}`
        : 'beaver-table-section-line';
    element.textContent = text;
    return element;
}

function renderDistribution(
    doc: Document,
    distribution: TableSectionFields['distributions'][number]
): HTMLElement {
    const wrapper = doc.createElement('div');
    wrapper.className = 'beaver-table-section-distribution';

    const label = doc.createElement('div');
    label.className = 'beaver-table-section-distribution-label';
    label.textContent = distribution.label;
    wrapper.append(label);

    for (const entry of distribution.entries) {
        const row = doc.createElement('div');
        row.className = 'beaver-table-section-distribution-row';
        const name = doc.createElement('span');
        name.textContent = entry.label;
        const count = doc.createElement('span');
        count.textContent = String(entry.count);
        row.append(name, count);
        wrapper.append(row);
    }
    if (distribution.truncated > 0) {
        const more = doc.createElement('div');
        more.className = 'beaver-table-section-distribution-row';
        more.textContent = `+${distribution.truncated} more`;
        wrapper.append(more);
    }
    return wrapper;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Which of the section's buttons can do anything for this item right now. */
export interface TableSectionActions {
    openInBeaver: boolean;
    openInReader: boolean;
    showInLibrary: boolean;
    /**
     * True only for a table another device's copy replaced whose own version is
     * still retained. There is nothing to restore otherwise, and an enabled
     * button that cannot work is worse than no button.
     */
    restoreShadow: boolean;
}

function canShowInLibrary(win: Window | null): boolean {
    const pane = (win as unknown as { ZoteroPane?: { selectItem?: unknown } })
        ?.ZoteroPane;
    return typeof pane?.selectItem === 'function';
}

/**
 * What the section's buttons would do for this item.
 *
 * `openInReader` needs a file on disk and `restoreShadow` needs a retained
 * version, neither of which is knowable without a read, so both are passed in
 * rather than guessed.
 */
export function tableSectionActions(
    win: Window | null,
    hasFile: boolean,
    canRestoreShadow = false
): TableSectionActions {
    const api = !!getTablesApi();
    return {
        openInBeaver: api,
        openInReader: api && hasFile,
        showInLibrary: canShowInLibrary(win),
        restoreShadow: api && canRestoreShadow,
    };
}

function windowOf(doc: Document): Window | null {
    return (doc.defaultView as Window | null) ?? null;
}

function refOf(item: Zotero.Item): TableRef {
    return { libraryID: item.libraryID, key: item.key };
}

/**
 * Opens the table on a surface, through the shared namespace.
 *
 * `Zotero.__beaverTables` rather than a direct import even though this module
 * is in the same bundle as `openTable`: the namespace is the one seam every
 * caller of a table surface uses, and going through it means a torn-down bundle
 * reports "not up" instead of running a dead realm's closure.
 */
async function open(ref: TableRef, where?: 'tab' | 'reader'): Promise<void> {
    const api = getTablesApi();
    if (!api) {
        logger('tableItemPane: the table surfaces are not registered', 1);
        return;
    }
    const outcome = await api.openTable(ref, where ? { where } : {});
    if ('error' in outcome) logger(`tableItemPane: ${outcome.error}`, 1);
}

/**
 * Writes this device's retained version back, as a new version.
 *
 * Through the namespace for the usual reason and one more: the restore is a
 * *write*, and every write goes through `tableStore.ts`, which is webpack-only
 * so its single-flight lock stays single. This module cannot import it at all.
 */
async function restoreShadow(ref: TableRef): Promise<void> {
    const api = getTablesApi();
    if (!api) {
        logger('tableItemPane: the table surfaces are not registered', 1);
        return;
    }
    const result = await api.shadow.restore(ref);
    if (!result.ok) {
        logger(`tableItemPane: restore refused (${result.code}): ${result.error}`, 1);
        return;
    }
    // The store announces the write, so whatever is showing the table re-reads
    // it; the section itself re-renders on the next selection change.
    logger(
        `tableItemPane: restored ${ref.key} v${result.restoredFrom} as v${result.version}`,
        3
    );
}

function showInLibrary(win: Window | null, item: Zotero.Item): void {
    const scope = win as unknown as {
        ZoteroPane?: { selectItem?: (id: number) => unknown };
        Zotero_Tabs?: { select?: (id: string) => void };
    } | null;
    try {
        // The section also appears in the reader's context pane, where
        // selecting an item means nothing until the library tab is in front.
        scope?.Zotero_Tabs?.select?.('zotero-pane');
        void scope?.ZoteroPane?.selectItem?.(item.id);
    } catch (error) {
        logger(`tableItemPane: could not reveal ${item.key}: ${String(error)}`, 2);
    }
}

function renderActions(doc: Document, item: Zotero.Item): HTMLElement {
    const win = windowOf(doc);
    const actions = tableSectionActions(win, true);
    const wrapper = doc.createElement('div');
    wrapper.className = 'beaver-table-section-actions';

    const ref = refOf(item);
    wrapper.append(
        button(doc, 'beaver', 'Open in Beaver', actions.openInBeaver, () =>
            void open(ref)
        ),
        // Enabled optimistically; the async half disables it when the item has
        // no file, which is the only way to know.
        button(doc, 'reader', 'Open in reader', actions.openInReader, () =>
            void open(ref, 'reader')
        ),
        button(doc, 'library', 'Show in library', actions.showInLibrary, () =>
            showInLibrary(win, item)
        ),
        // The opposite default to the others: this one applies to almost no
        // table, so it starts disabled and the async half enables it only for a
        // table that is actually in the conflicted state.
        hidden(
            button(doc, 'restore-shadow', 'Restore my version', false, () =>
                void restoreShadow(ref)
            )
        )
    );
    return wrapper;
}

/** Starts a button out of the layout, for one the async half may reveal. */
function hidden(element: HTMLButtonElement): HTMLButtonElement {
    element.hidden = true;
    return element;
}

function button(
    doc: Document,
    action: string,
    label: string,
    enabled: boolean,
    onClick: () => void
): HTMLButtonElement {
    const element = doc.createElement('button');
    element.className = 'beaver-table-section-action';
    element.setAttribute('data-beaver-action', action);
    element.textContent = label;
    element.disabled = !enabled;
    element.addEventListener('click', () => {
        try {
            onClick();
        } catch (error) {
            logger(`tableItemPane: ${action} action failed: ${String(error)}`, 1);
        }
    });
    return element;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** What the section would render for one item — the dev endpoint's answer. */
export interface TableItemPaneReport {
    registered: boolean;
    paneID: string | null;
    libraryID: number;
    key: string;
    /** False when the item is not a stored table, so no section would show. */
    applies: boolean;
    /** Why the section is absent, or why its counts are. */
    reason: string | null;
    fields: TableSectionFields | null;
    actions: TableSectionActions;
}

/**
 * Resolves what the section would show for a table, without an item pane.
 *
 * Deliberately re-reads rather than reporting a rendered section's DOM: the
 * question this answers is "what do the stored numbers say", which must be
 * answerable whether or not the item is selected anywhere.
 */
export async function describeTableItemPane(
    ref: TableRef
): Promise<TableItemPaneReport> {
    let win: Window | null = null;
    try {
        win = Zotero.getMainWindow();
    } catch {
        win = null;
    }
    const base: TableItemPaneReport = {
        registered: isTableItemPaneRegistered(),
        paneID: registeredPaneID,
        libraryID: ref.libraryID,
        key: ref.key,
        applies: false,
        reason: null,
        fields: null,
        actions: tableSectionActions(win, false),
    };

    const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key) as
        | Zotero.Item
        | false;
    if (!item) {
        return { ...base, reason: `No item ${ref.key} in library ${ref.libraryID}.` };
    }
    try {
        await loadTableItemFields([item]);
    } catch (error) {
        return { ...base, reason: `Could not load ${ref.key}: ${String(error)}` };
    }
    if (!isTableItem(item)) {
        return { ...base, reason: `Item ${ref.key} is not a Beaver table.` };
    }

    const data = await readTableSectionData(item);
    return {
        ...base,
        applies: true,
        reason: data.reason,
        fields: data.fields,
        actions: tableSectionActions(
            win,
            data.hasFile,
            !!data.fields.conflict?.restorable
        ),
    };
}

import React, { useState } from 'react';
import type { AgentAction } from '../../../agents/agentActions';
import {
    importItemDisplayJson,
    itemJsonDisplay,
    type ImportItemProposedData,
    type ImportItemResultData,
    type ZoteroCreatorJson,
    type ZoteroItemJson,
} from '@beaver/agent-core/types/itemImport';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
    AttachmentIcon,
    CancelCircleIcon,
    CSSIcon,
    CSSItemTypeIcon,
    FileIcon,
    Icon,
    TagIcon,
} from '../../../components/icons/icons';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';
import { revealSource } from '../../../utils/sourceUtils';
import { selectCollection, selectLibrary } from '../../../utils/selectItem';
import { usePdfFetchStatus } from '../../../hooks/useBackgroundTasks';
import { enrichmentNote, importSourceBadge, importSourceDetail } from '../../../utils/importItemDisplay';
import { shortenActionError } from './agentActionViewHelpers';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

const WEB_CONTENT_TYPES = new Set(['webpage', 'blogPost', 'forumPost', 'newspaperArticle', 'magazineArticle', 'encyclopediaArticle', 'presentation']);

/** Fields the details view shows elsewhere, or that only describe the lookup. */
const HIDDEN_FIELDS = new Set(['title', 'abstractNote', 'extra', 'accessDate', 'dateAdded', 'dateModified', 'libraryCatalog', 'rights']);

/** Abstracts longer than this start clamped. */
const LONG_ABSTRACT = 400;

interface ImportItemsPreviewProps {
    /** `import_item` actions of one `create_items` call. */
    actions: AgentAction[];
    /** Batch status of the card; a declined batch strikes every row. */
    status?: ActionStatus;
}

const Badge: React.FC<{ label: string; caution?: boolean; tooltip?: string }> = ({ label, caution, tooltip }) => {
    const badge = (
        <span
            className={`text-xs px-15 rounded-sm whitespace-nowrap ${caution ? 'font-color-orange' : 'font-color-secondary'}`}
            style={{ border: '1px solid var(--fill-quinary)', lineHeight: '1.5' }}
        >
            {label}
        </span>
    );
    return tooltip ? <Tooltip content={tooltip} singleLine={tooltip.length < 70}>{badge}</Tooltip> : badge;
};

/** Zotero's localized label for a field, item type or creator type; the raw name if Zotero has none. */
function localized(kind: 'field' | 'itemType' | 'creatorType', name: string): string {
    try {
        const label = kind === 'field'
            ? Zotero.ItemFields.getLocalizedString(name)
            : kind === 'itemType'
                ? Zotero.ItemTypes.getLocalizedString(name)
                : Zotero.CreatorTypes.getLocalizedString(name);
        if (label) return label;
    } catch {
        // Unknown to this Zotero version: fall through to the raw name.
    }
    return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** The item's fields in Zotero's order for its type, then any others. */
function orderedFields(json: ZoteroItemJson): Array<[string, string]> {
    const values = new Map<string, string>();
    for (const [name, value] of Object.entries(json)) {
        if (HIDDEN_FIELDS.has(name) || ['itemType', 'creators', 'tags', 'notes', 'collections', 'relations'].includes(name)) continue;
        const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
        if (text) values.set(name, text);
    }
    if (values.get('journalAbbreviation') === values.get('publicationTitle')) values.delete('journalAbbreviation');
    let order: string[] = [];
    try {
        const typeID = Zotero.ItemTypes.getID(json.itemType);
        order = typeID ? Zotero.ItemFields.getItemTypeFields(typeID).map((id: number) => Zotero.ItemFields.getName(id) as string) : [];
    } catch {
        order = [];
    }
    const known = order.filter((name) => values.has(name));
    const rest = Array.from(values.keys()).filter((name) => !known.includes(name));
    return [...known, ...rest].map((name) => [name, values.get(name)!]);
}

function creatorName(creator: ZoteroCreatorJson): string {
    return creator.name?.trim() || [creator.firstName, creator.lastName].filter(Boolean).join(' ').trim();
}

/** Creators grouped by role, in order of first appearance: [["Author", "A; B"], ["Editor", "C"]]. */
function creatorRows(creators: ZoteroCreatorJson[] | undefined): Array<[string, string]> {
    const groups = new Map<string, string[]>();
    for (const creator of creators ?? []) {
        const name = creatorName(creator);
        if (!name) continue;
        const role = creator.creatorType || 'author';
        groups.set(role, [...(groups.get(role) ?? []), name]);
    }
    return Array.from(groups.entries()).map(([role, names]) => [localized('creatorType', role), names.join('; ')]);
}

function openUrl(url: string) {
    try {
        Zotero.launchURL(url);
    } catch {
        // Nothing to open with.
    }
}

const FieldValue: React.FC<{ name: string; value: string }> = ({ name, value }) => {
    const href = name === 'url' && /^https?:\/\//i.test(value)
        ? value
        : name === 'DOI' ? `https://doi.org/${value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}` : null;
    if (!href) return <>{value}</>;
    return (
        <button type="button" className="import-item-link" onClick={() => openUrl(href)}>
            {value}
        </button>
    );
};

/** Everything known about one import: its fields, abstract, source, file and notes. */
const ImportItemDetails: React.FC<{
    data: ImportItemProposedData;
    json: ZoteroItemJson | undefined;
    fileStatus: string | null;
}> = ({ data, json, fileStatus }) => {
    const rows: Array<[string, React.ReactNode]> = [];
    if (json) {
        rows.push([localized('field', 'itemType'), localized('itemType', json.itemType)]);
        for (const [label, names] of creatorRows(json.creators)) rows.push([label, names]);
        for (const [name, value] of orderedFields(json)) {
            rows.push([localized('field', name), <FieldValue key={name} name={name} value={value} />]);
        }
    }
    const source = [importSourceDetail(data), data.resolution?.translator].filter(Boolean).join(' · ');
    if (source) rows.push(['Source', source]);
    if (data.file) rows.push(['File', [data.file.filename ?? 'File', fileStatus].filter(Boolean).join(' · ')]);
    const abstract = typeof json?.abstractNote === 'string' ? json.abstractNote.trim() : '';
    const enrichment = enrichmentNote(data);
    const warnings = data.warnings ?? [];
    const [fullAbstract, setFullAbstract] = useState(false);
    const clampAbstract = abstract.length > LONG_ABSTRACT && !fullAbstract;

    return (
        <div className="import-item-details">
            {rows.length > 0 && (
                <div className="import-item-fields">
                    {rows.map(([label, value], index) => (
                        <React.Fragment key={index}>
                            <div className="import-item-field-label">{label}</div>
                            <div className="import-item-field-value">{value}</div>
                        </React.Fragment>
                    ))}
                </div>
            )}
            {abstract && (
                <div className="display-flex flex-col gap-05">
                    <div className="import-item-section-label">
                        Abstract{enrichment ? <span className="font-color-tertiary"> · {enrichment}</span> : null}
                    </div>
                    <div className={`import-item-abstract${clampAbstract ? ' import-item-abstract-clamped' : ''}`}>{abstract}</div>
                    {abstract.length > LONG_ABSTRACT && (
                        <button type="button" className="import-item-link text-sm" onClick={() => setFullAbstract((value) => !value)}>
                            {fullAbstract ? 'Show less' : 'Show more'}
                        </button>
                    )}
                </div>
            )}
            {warnings.length > 0 && (
                <div className="display-flex flex-col gap-05">
                    <div className="import-item-section-label">Notes</div>
                    <ul className="import-item-notes">
                        {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
};

/** One `import_item` row; a component so it can subscribe to its background task. */
const ImportItemRow: React.FC<{ action: AgentAction; cardStatus?: ActionStatus }> = ({ action, cardStatus }) => {
    const data = action.proposed_data as ImportItemProposedData;
    const result = action.result_data as ImportItemResultData | undefined;
    const status = action.status as ActionStatus;
    const [expanded, setExpanded] = useState(false);
    const { openItemMenu, itemMenu } = useItemContextMenu();

    const applied = status === 'applied' && !!result?.zotero_key;
    const attachmentTask = usePdfFetchStatus(applied ? result?.library_id : undefined, applied ? result?.zotero_key : undefined);
    const createdRef = applied ? { library_id: result!.library_id, zotero_key: result!.zotero_key, library_ref: result!.library_ref } : null;

    const json = importItemDisplayJson(data);
    const display = json ? itemJsonDisplay(json) : null;
    const badge = importSourceBadge(data);
    const file = data?.file;
    const isWeb = !!display && WEB_CONTENT_TYPES.has(display.itemType);
    const errorCode = (action.error_details as any)?.error_code;
    const alreadyInLibrary = status === 'error' && errorCode === 'already_in_library';
    const failed = status === 'error' && !alreadyInLibrary;
    const errorText = status === 'error' && action.error_message
        ? (alreadyInLibrary ? 'Already in your library' : shortenActionError(action.error_message))
        : null;
    const fileStatus = !file
        ? null
        : status === 'applied'
            ? (file.mode === 'link' ? 'linked' : 'attached')
            : status === 'error' || status === 'rejected' || status === 'undone'
                ? 'not attached'
                : (file.mode === 'link' ? 'will be linked' : 'will be attached');

    const meta = display
        ? isWeb
            ? [display.venue ?? display.site, display.year].filter(Boolean).join(' · ')
            : [display.creatorsSummary, display.year, display.venue].filter(Boolean).join(' · ')
        : '';

    const struck = status === 'rejected' || status === 'undone' || cardStatus === 'rejected' || cardStatus === 'undone';
    const textClass = (defaultClass: string = 'font-color-primary') => (struck ? 'font-color-tertiary line-through' : defaultClass);

    const toggle = () => setExpanded((value) => !value);
    const onHeaderClick = (event: React.MouseEvent<HTMLDivElement>) => {
        // Selecting text in the row should not toggle it.
        const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
        if (selection && !selection.isCollapsed) return;
        toggle();
    };

    return (
        <div onContextMenu={createdRef ? (event) => openItemMenu(createdRef, event) : undefined}>
            {itemMenu}
            <div className="import-item-header display-flex flex-row items-start gap-2" onClick={onHeaderClick}>
                <div className="import-item-icon">
                    {failed
                        ? <Icon icon={CancelCircleIcon} className="font-color-red" />
                        : display
                            ? <CSSItemTypeIcon itemType={display.itemType} className="scale-85" />
                            : <Icon icon={FileIcon} className="font-color-secondary scale-85" />}
                </div>

                <div className="display-flex flex-col gap-1 flex-1 min-w-0">
                    <div className={textClass()}>
                        {display?.title ?? file?.filename ?? 'Untitled item'}
                        {createdRef && (
                            <>
                                {'\u00A0'}
                                <Tooltip content="Reveal in Zotero" singleLine>
                                    <span
                                        className="import-item-reveal"
                                        role="button"
                                        aria-label="Reveal in Zotero"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            revealSource(createdRef, data.collection_ids?.[0] ?? data.collection_keys?.[0]);
                                        }}
                                    >
                                        <Icon icon={ArrowUpRightIcon} />
                                    </span>
                                </Tooltip>
                            </>
                        )}
                    </div>
                    {(meta || badge) && (
                        <div className="display-flex flex-row items-center gap-15 min-w-0">
                            {meta && <span className={`${textClass('font-color-secondary')} truncate`}>{meta}</span>}
                            {badge && (
                                <span className="flex-shrink-0">
                                    <Badge label={badge.label} caution={badge.caution} tooltip={badge.tooltip} />
                                </span>
                            )}
                        </div>
                    )}
                    {file && !failed && (
                        <Tooltip content={file.path ?? file.filename ?? ''} singleLine>
                            <span className="display-flex items-center gap-05 text-xs font-color-secondary truncate" style={{ maxWidth: '100%' }}>
                                <Icon icon={AttachmentIcon} className="scale-80" />
                                <span className="truncate">{file.filename ?? 'File'} · {fileStatus}</span>
                            </span>
                        </Tooltip>
                    )}
                    {errorText && <div className="font-color-secondary text-sm">{errorText}</div>}
                    {attachmentTask.isLoading && (
                        <div className="display-flex items-center gap-1 font-color-secondary text-sm">
                            <Spinner size={12} />
                            <span>{attachmentTask.kind === 'snapshot' ? 'Saving snapshot…' : 'Fetching PDF…'}</span>
                        </div>
                    )}
                </div>

                <div className="flex-shrink-0" onClick={(event) => event.stopPropagation()}>
                    <button
                        type="button"
                        className="import-item-toggle"
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Hide details' : 'Show details'}
                        onClick={toggle}
                    >
                        <Icon icon={ArrowDownIcon} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
                    </button>
                </div>
            </div>
            {expanded && (
                <ImportItemDetails data={data} json={json} fileStatus={fileStatus} />
            )}
        </div>
    );
};

interface Destination {
    library: Zotero.Library | null;
    libraryName: string;
    /** The target collections; a single one comes with its parent path. */
    path: Zotero.Collection[];
    others: Zotero.Collection[];
    tags: string[];
}

/** Where the items go: library, collections (looked up locally) and tags. */
function destinationOf(data: ImportItemProposedData | undefined): Destination | null {
    if (!data) return null;
    const libraryId = resolveLibraryRef({ library_ref: data.library_ref, library_id: data.library_id });
    const library = libraryId ? ((Zotero.Libraries.get(libraryId) as Zotero.Library | false) || null) : null;
    const libraryName = data.library_name ?? (library as any)?.name;
    const collections = (data.collection_keys ?? [])
        .map((key) => {
            if (!libraryId) return null;
            try {
                return (Zotero.Collections.getByLibraryAndKey(libraryId, key) as Zotero.Collection | false) || null;
            } catch {
                return null;
            }
        })
        .filter((collection): collection is Zotero.Collection => !!collection);
    const tags = (data.tags ?? []).filter(Boolean);
    if (!libraryName && !collections.length && !tags.length) return null;

    const path: Zotero.Collection[] = [];
    let others: Zotero.Collection[] = [];
    if (collections.length === 1) {
        // A nested collection is shown under its parents, like a breadcrumb.
        for (let current: Zotero.Collection | null = collections[0]; current && path.length < 8;) {
            path.unshift(current);
            current = current.parentID ? ((Zotero.Collections.get(current.parentID) as Zotero.Collection | false) || null) : null;
        }
    } else {
        others = collections;
    }
    return { library, libraryName: libraryName ?? 'Library', path, others, tags };
}

const Crumb: React.FC<{ icon: string; label: string; title?: string; onClick?: () => void }> = ({ icon, label, title, onClick }) => (
    <button type="button" className="import-crumb" title={title ?? label} onClick={onClick} disabled={!onClick}>
        <CSSIcon name={icon} className="icon-16 import-crumb-icon" />
        <span className="truncate">{label}</span>
    </button>
);

const CrumbSeparator: React.FC = () => (
    <Icon icon={ArrowRightIcon} className="import-crumb-separator" aria-hidden />
);

/** Library › collection breadcrumb, with the tags the items get beside it. */
const DestinationBar: React.FC<{ destination: Destination }> = ({ destination }) => {
    const { library, libraryName, path, others, tags } = destination;
    const isGroup = (library as any)?.libraryType === 'group';
    return (
        <div className="import-destination">
            <div className="import-crumbs">
                <Crumb
                    icon={isGroup ? 'library-group' : 'library'}
                    label={libraryName}
                    onClick={library ? () => { void selectLibrary(library); } : undefined}
                />
                {path.map((collection) => (
                    <React.Fragment key={collection.key}>
                        <CrumbSeparator />
                        <Crumb icon="collection" label={collection.name} onClick={() => { void selectCollection(collection); }} />
                    </React.Fragment>
                ))}
                {others.length > 0 && <CrumbSeparator />}
                {others.map((collection) => (
                    <Crumb key={collection.key} icon="collection" label={collection.name} onClick={() => { void selectCollection(collection); }} />
                ))}
            </div>
            {tags.length > 0 && (
                <div className="import-destination-tags">
                    {tags.map((tag) => (
                        <span key={tag} className="import-tag" title={`Tag: ${tag}`}>
                            {/* <CSSIcon name="tag" className="icon-16 import-tag-icon" /> */}
                            <Icon icon={TagIcon} className="scale-90 mr-020" />
                            <span className="truncate">{tag}</span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

/**
 * Approval card and run view for `import_item` actions (create_items v2).
 * Rows render the item JSON the user is approving: what gets written.
 */
export const ImportItemsPreview: React.FC<ImportItemsPreviewProps> = ({ actions, status }) => {
    // Citation imports name no destination: they go wherever the user is when clicking.
    const destination = destinationOf(actions[0]?.proposed_data as ImportItemProposedData | undefined);
    return (
        <div className="import-items-preview px-3 py-2">
            {destination && <DestinationBar destination={destination} />}
            <div className="display-flex flex-col gap-3">
                {actions.map((action) => (
                    <ImportItemRow key={action.id} action={action} cardStatus={status} />
                ))}
            </div>
        </div>
    );
};

export default ImportItemsPreview;

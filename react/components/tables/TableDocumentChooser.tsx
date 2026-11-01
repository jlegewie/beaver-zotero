import React, { useEffect, useState } from 'react';
import { rowReference } from '@beaver/agent-core/layouts/tableCitations';
import type { Row } from '@beaver/agent-core/layouts/table';
import Button from '@beaver/agent-ui/primitives/Button';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { getReadableContentKind } from '../../../src/services/documentExtraction/attachmentResolution';
import { safeAttachmentFilename } from '../../../src/utils/attachmentFiles';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { isRowDocumentKind } from '../../../src/services/tableFills/planner';

/** A document a row may be read from: a readable attachment of its item. */
export interface RowDocumentChoice {
    /** Portable id (`u-KEY`, `g<id>-KEY`), as rows name documents. */
    id: string;
    name: string;
    kind: string;
    /** Zotero's primary attachment of the item. */
    primary: boolean;
}

const KIND_LABELS: Record<string, string> = { pdf: 'PDF', epub: 'EPUB', snapshot: 'Snapshot', text: 'Text' };

/**
 * The readable attachments of a row's item, from Zotero's metadata (no file
 * is opened). Local only: the chooser renders in the user's own tab, so an
 * excluded library is looked up like any other.
 */
export async function rowDocumentChoices(row: Row): Promise<RowDocumentChoice[]> {
    const ref = row.ref;
    if (ref?.kind !== 'item') return [];
    const libraryID = resolveLibraryRef({ library_ref: ref.library_ref, library_id: ref.library_id });
    if (libraryID == null) return [];
    const item = (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.zotero_key)) as Zotero.Item | false;
    if (!item || !item.isRegularItem()) return [];
    await Zotero.Items.loadDataTypes([item], ['childItems']);
    const attachments = (await Zotero.Items.getAsync(item.getAttachments(false) as number[])) as Zotero.Item[];
    if (attachments.length) await Zotero.Items.loadDataTypes(attachments, ['itemData']);
    const best = (await item.getBestAttachment()) as Zotero.Item | false;
    const libraryRef = libraryRefForLibraryID(item.libraryID) ?? String(item.libraryID);
    const choices: RowDocumentChoice[] = [];
    for (const attachment of attachments) {
        if (!attachment || attachment.deleted) continue;
        const kind = getReadableContentKind(attachment);
        if (!isRowDocumentKind(kind)) continue;
        let title = '';
        try {
            title = attachment.getField('title') as string;
        } catch {
            title = '';
        }
        choices.push({
            id: `${libraryRef}-${attachment.key}`,
            name: safeAttachmentFilename(attachment) || title || 'Document',
            kind,
            primary: !!best && best.id === attachment.id,
        });
    }
    return choices;
}

/**
 * Choose document…: which of the paper's attachments the row is read from.
 * Choosing another puts the row's answers out of date (they were read from
 * the old one) until the row is filled again; the user's own answers stay.
 */
export function TableDocumentChooser({
    row,
    saving,
    error,
    onCancel,
    onChoose,
}: {
    row: Row;
    saving: boolean;
    error?: string | null;
    onCancel(): void;
    onChoose(choice: RowDocumentChoice): void;
}): React.ReactElement {
    const [choices, setChoices] = useState<RowDocumentChoice[] | null>(null);
    const [lookupError, setLookupError] = useState<string | null>(null);
    const current = row.documents?.[0];
    const [picked, setPicked] = useState<string | undefined>(current);

    useEffect(() => {
        let live = true;
        rowDocumentChoices(row).then(
            (found) => {
                if (!live) return;
                setChoices(found);
                if (!current || !found.some((choice) => choice.id === current))
                    setPicked(found.find((choice) => choice.primary)?.id ?? found[0]?.id);
            },
            (thrown) => {
                if (live) setLookupError(String((thrown as Error)?.message ?? thrown));
            },
        );
        return () => {
            live = false;
        };
    }, [row.id]);

    const choice = choices?.find((entry) => entry.id === picked);
    const title = rowReference(row)?.title ?? rowReference(row)?.display_name ?? 'This paper';

    return (
        <div className="rt-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Choose document"
                className="rt-dialog rt-document-chooser"
                onKeyDown={(event) => {
                    if (isImeKeyEvent(event.nativeEvent)) return;
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        onCancel();
                    }
                }}
            >
                <div className="rt-dialog-body">
                    <div className="rt-dialog-title">Choose document</div>
                    <div className="rt-document-paper">{title}</div>
                    {lookupError ? (
                        <div className="rt-dialog-error" role="alert">
                            {lookupError}
                        </div>
                    ) : choices === null ? (
                        <div className="rt-hint">Looking up the paper’s attachments…</div>
                    ) : choices.length === 0 ? (
                        <div className="rt-hint">This paper has no PDF, EPUB or snapshot attachment.</div>
                    ) : (
                        <div className="rt-document-choices" role="radiogroup" aria-label="Documents">
                            {choices.map((entry, index) => (
                                <label key={entry.id} className="rt-document-choice">
                                    <input
                                        type="radio"
                                        name="row-document"
                                        checked={picked === entry.id}
                                        disabled={saving}
                                        autoFocus={picked === entry.id || (!picked && index === 0)}
                                        onChange={() => setPicked(entry.id)}
                                    />
                                    <span className="rt-document-choice-name">{entry.name}</span>
                                    <span className="rt-hint">
                                        {[KIND_LABELS[entry.kind] ?? entry.kind, entry.id === current ? 'Current' : null]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </span>
                                </label>
                            ))}
                        </div>
                    )}
                    <div className="rt-hint">
                        Beaver’s answers in this row become out of date until you refill the row. Your own answers stay.
                    </div>
                    {error ? (
                        <div className="rt-dialog-error" role="alert">
                            {error}
                        </div>
                    ) : null}
                </div>
                <div className="rt-dialog-actions">
                    <Button variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        variant="solid"
                        disabled={!choice || choice.id === current || saving}
                        loading={saving}
                        onClick={() => choice && onChoose(choice)}
                    >
                        Use this document
                    </Button>
                </div>
            </div>
        </div>
    );
}

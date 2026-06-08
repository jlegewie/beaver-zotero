/**
 * Dev-only HTTP handlers for headless annotation creation primitives.
 */

import {
    createHighlightAnnotation,
    createNoteAnnotation,
    MissingPageGeometryError,
    type CreateHighlightInput,
    type CreateNoteInput,
} from "../../../src/services/annotations/createAnnotation";

type AnnotationCreateKind = "highlight" | "note";

interface AnnotationCreateRequest {
    library_id: number;
    zotero_key: string;
    type: AnnotationCreateKind;
    input: CreateHighlightInput | CreateNoteInput;
    force_file_path?: string;
    open_reader?: boolean;
    check_reader?: boolean;
}

function getPageIndex(
    type: AnnotationCreateKind,
    input: CreateHighlightInput | CreateNoteInput,
): number {
    return type === "highlight"
        ? (input as CreateHighlightInput).pageIndex
        : (input as CreateNoteInput).notePosition.page_index;
}

async function loadAnnotation(ref: {
    library_id: number;
    zotero_key: string;
}): Promise<Zotero.Item | null> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        ref.library_id,
        ref.zotero_key,
    );
    if (!item) return null;
    await item.loadDataType("annotation");
    return item;
}

async function findCachedGeometry(attachment: Zotero.Item, pageIndex: number) {
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) return null;
    const record = await Zotero.Beaver?.documentCache?.getMetadata(
        { libraryId: attachment.libraryID, zoteroKey: attachment.key },
        filePath,
    );
    return record?.pages?.[pageIndex] ?? null;
}

async function waitForReaderAnnotation(
    reader: any,
    zoteroKey: string,
    timeoutMs = 5000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const annotations = reader?._internalReader?._annotationManager?._annotations ?? [];
        if (annotations.some((annotation: any) => annotation?.id === zoteroKey)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

function serializeAnnotation(item: Zotero.Item) {
    return {
        item_id: item.id,
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_id: item.parentID,
        annotationType: item.annotationType,
        annotationText: item.annotationText,
        annotationComment: item.annotationComment,
        annotationColor: item.annotationColor,
        annotationPageLabel: item.annotationPageLabel,
        annotationSortIndex: item.annotationSortIndex,
        annotationAuthorName: item.annotationAuthorName,
        annotationPosition: JSON.parse(item.annotationPosition),
    };
}

export async function handleTestAnnotationCreateHttpRequest(
    request: AnnotationCreateRequest,
) {
    const { library_id, zotero_key, type, input } = request || {};
    if (library_id == null || zotero_key == null) {
        return { ok: false, error: "Provide library_id + zotero_key" };
    }
    if (type !== "highlight" && type !== "note") {
        return { ok: false, error: "type must be highlight or note" };
    }

    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
        library_id,
        zotero_key,
    );
    if (!attachment) return { ok: false, error: "not_found" };
    if (!attachment.isAttachment()) {
        return { ok: false, error: "not_an_attachment" };
    }

    const pageIndex = getPageIndex(type, input);
    let reader: any = null;
    if (request.open_reader) {
        reader = await Zotero.Reader.open(attachment.id, { pageIndex });
        // Zotero.Reader.open() returns undefined when it selects an existing tab.
        reader = reader ??
            Zotero.Reader._readers?.find((candidate: any) => {
                return candidate?.itemID === attachment.id;
            }) ??
            null;
        await reader?._internalReader?._primaryView?.initializedPromise;
    }

    const originalGetFilePathAsync = attachment.getFilePathAsync.bind(attachment);
    if (request.force_file_path) {
        // Dev-only negative-path hook; do not run this handler concurrently for the same cached Zotero item.
        attachment.getFilePathAsync = async () => request.force_file_path ?? false;
    }

    try {
        const ref = type === "highlight"
            ? await createHighlightAnnotation(
                attachment,
                input as CreateHighlightInput,
            )
            : await createNoteAnnotation(attachment, input as CreateNoteInput);
        const annotation = await loadAnnotation(ref);
        if (!annotation) {
            return { ok: false, error: "created_annotation_not_found" };
        }
        const reader_visible = request.check_reader && reader
            ? await waitForReaderAnnotation(reader, ref.zotero_key)
            : null;

        return {
            ok: true,
            reference: ref,
            annotation: serializeAnnotation(annotation),
            geometry: await findCachedGeometry(attachment, pageIndex),
            reader_visible,
        };
    } catch (error) {
        if (error instanceof MissingPageGeometryError) {
        return {
            ok: false,
            code: error.code,
            reason: error.reason,
            message: error.message,
        };
        }
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        if (request.force_file_path) {
            attachment.getFilePathAsync = originalGetFilePathAsync;
        }
    }
}

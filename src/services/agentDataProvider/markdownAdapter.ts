import type { MarkdownDocument } from "../../beaver-extract/schema";
import type { WSPageContent } from "../agentProtocol";
import type { CachedPageContent } from "../attachmentFileCache";

/** Convert canonical markdown pages to the content-cache wire shape. */
export function markdownDocumentToCachedPages(
    doc: MarkdownDocument,
): CachedPageContent[] {
    return doc.pages.map((page) => ({
        index: page.index,
        label: page.label,
        content: page.markdown,
        width: page.width,
        height: page.height,
    }));
}

/** Convert canonical markdown pages to the agent page-content wire shape. */
export function markdownDocumentToWSPageContent(
    doc: MarkdownDocument,
    pageLabels?: Record<string | number, string>,
): WSPageContent[] {
    return doc.pages.map((page) => ({
        page_number: page.index + 1,
        page_label: pageLabels?.[page.index] ?? pageLabels?.[String(page.index)] ?? page.label,
        content: page.markdown,
    }));
}

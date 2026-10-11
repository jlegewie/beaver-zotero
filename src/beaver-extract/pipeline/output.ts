/**
 * Result-building helpers shared by the markdown and structured outputs.
 */

import type { BoundingBox, InternalExtractionResult } from "@beaver/agent-core/extract/types";
import { bboxFromXYWH } from "@beaver/agent-core/extract/types";
import { inverseRotateBBox, type RotationAngle } from "../PageRotationNormalizer";
import type { PdfExtractionPreset } from "../schema";

export function pageLabelsToStringKeys(
    pageLabels?: Record<number, string>,
): Record<string, string> | undefined {
    if (!pageLabels || Object.keys(pageLabels).length === 0) return undefined;
    return Object.fromEntries(
        Object.entries(pageLabels).map(([index, label]) => [String(index), label]),
    );
}

// C0/C1 control characters never belong in extracted text; Type 3 fonts in
// some Word exports emit U+0007 for list tabs ("23. \x07Heer"). Each is
// replaced by one character so text offsets stay aligned: C1 codes 0x91-0x97,
// which some PDFs use as their Windows-1252 punctuation, become that
// punctuation; every other control becomes a space. Other C1 codes (0x80,
// 0x85, ...) mean different things in different fonts and are not mapped.
// This runs on the final result, not on raw pages: page analysis (the OCR
// gate, unmapped-glyph recovery) relies on control characters counting as
// non-letters. It is part of text repair, so it is off in the schema-4 preset.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CONTROL_CHAR_TEST = new RegExp(CONTROL_CHARS.source);
const CP1252_PUNCTUATION: Record<string, string> = {
    "\u0091": "‘", // ‘
    "\u0092": "’", // ’
    "\u0093": "“", // “
    "\u0094": "”", // ”
    "\u0095": "•", // •
    "\u0096": "–", // –
    "\u0097": "—", // —
};
function replaceControlChars(text: string): string {
    return CONTROL_CHAR_TEST.test(text)
        ? text.replace(CONTROL_CHARS, (c) => CP1252_PUNCTUATION[c] ?? " ")
        : text;
}

/**
 * Replace control characters in every text field of the result, in place,
 * when the PDF schema preset enables text repair.
 */
export function replaceControlCharsInResult(
    result: InternalExtractionResult,
    preset: PdfExtractionPreset,
): void {
    if (!preset.textRepair) return;
    result.fullText = replaceControlChars(result.fullText);
    for (const page of result.pages) {
        page.content = replaceControlChars(page.content);
        for (const item of page.items) {
            if (!("text" in item)) continue;
            item.text = replaceControlChars(item.text);
            for (const line of item.lines) line.text = replaceControlChars(line.text);
            if (!("sentences" in item) || !item.sentences) continue;
            for (const sentence of item.sentences) {
                sentence.text = replaceControlChars(sentence.text);
                for (const fragment of sentence.fragments ?? []) {
                    fragment.text = replaceControlChars(fragment.text);
                }
            }
        }
    }
}

/**
 * Inverse-rotate a column rect (`{x, y, w, h}` in upright frame) back
 * to MuPDF coords and project into the `{l, t, r, b}` shape stored on
 * `InternalProcessedPage.columns`.
 */
export function projectColumnRect(
    col: { x: number; y: number; w: number; h: number },
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): BoundingBox {
    const box = bboxFromXYWH(col.x, col.y, col.w, col.h, "top-left");
    return pageRotation === 0
        ? box
        : inverseRotateBBox(box, pageRotation, sourceWidth, sourceHeight);
}

/**
 * `items export`: one row per document with, per page, the model's units
 * with their feature rows, the structured result's items, and the lines the
 * margin filter removed. Training repos read it to train item models on what
 * the shipped pipeline produces.
 *
 * A unit is a draft item as segmentation produced it, where the task's model
 * runs (the start of step 3): units are the training rows. Item passes can
 * then split and merge items (reference entries), so each item lists the
 * units its lines came from. A split piece lists one unit, shared with its
 * sibling pieces; a merged item lists several. Item ids are the structured
 * result's, so labels made on a structured export of the same commit match
 * by id and map onto units through `units`.
 *
 * A line-level task (`--task boundaries`) also lists every flow line of a
 * page (`lines`): the lines the paragraph detector segments, blocks in reading
 * order and lines top to bottom, each with the detector's decision and the
 * task's feature row; with `learnedBoundaries`, the boundary model's
 * decision and probability. The rows are computed where the detector builds the
 * task's input (`BoundaryObserver`), before segmentation; the units' lines in
 * order are the same flow.
 */

import type { DocItem, InternalExtractionResult } from "@beaver/agent-core/extract/types";
import type { PageLine } from "../LineDetector";
import { inverseRotateBBox } from "../PageRotationNormalizer";
import { lineFace, lineSize } from "../features/style";
import { buildTypedDocument } from "../itemTypes/input";
import { FEATURES as ITEM_TYPE_FEATURES, FEATURE_SET as ITEM_TYPE_FEATURE_SET, FEATURE_VERSION as ITEM_TYPE_FEATURE_VERSION, itemTypeFeatures } from "../itemTypes/features";
import { bboxToRect } from "../schema/bbox";
import { ITEM_KINDS } from "../schema/itemKinds";
import type { Rect, StructuredExtractResult } from "../schema";
import type { DraftItem, DraftItemKind, DraftPage } from "./draftItems";
import type { DraftDocument, ItemPass } from "./itemPasses";
import type { BoundaryObserver } from "./structured";
import type { BoundaryPage } from "../boundaries/input";
import {
    FEATURES as BOUNDARY_FEATURES,
    FEATURE_SET as BOUNDARY_FEATURE_SET,
    FEATURE_VERSION as BOUNDARY_FEATURE_VERSION,
    boundaryFeatures,
} from "../boundaries/features";

export const ITEMS_EXPORT_FORMAT = "beaver-items-v1";

/**
 * A model task whose features `items export` writes: a feature row per unit
 * (`compute`), or per flow line (`lineFeatures`).
 */
export interface ItemsExportTask {
    featureSet: string;
    featureVersion: number;
    /** Names of the task's feature rows (`names` in the manifest). */
    features: readonly string[];
    /** Feature rows of every draft item, per page in reading order. */
    compute?(doc: DraftDocument): number[][][];
    /** Feature rows of every line of a page, per block in reading order. */
    lineFeatures?(page: BoundaryPage): number[][][];
}

export const ITEMS_EXPORT_TASKS: Record<string, ItemsExportTask> = {
    "item-type": {
        featureSet: ITEM_TYPE_FEATURE_SET,
        featureVersion: ITEM_TYPE_FEATURE_VERSION,
        features: ITEM_TYPE_FEATURES,
        compute: (doc) => itemTypeFeatures(buildTypedDocument(doc)),
    },
    boundaries: {
        featureSet: BOUNDARY_FEATURE_SET,
        featureVersion: BOUNDARY_FEATURE_VERSION,
        features: BOUNDARY_FEATURES,
        lineFeatures: boundaryFeatures,
    },
};

export interface ItemsExportLine {
    bbox: Rect;
    text: string;
    /** Font most glyphs are set in. */
    font: string;
    /** Size most glyphs are set in. */
    size: number;
    /** Hanging-indent role: 0 none, 1 entry start, 2 continuation. */
    role: 0 | 1 | 2;
}

/** A draft item at the start of step 3: one training row. */
export interface ItemsExportUnit {
    /** Index among the page's units. */
    unit: number;
    /** Draft kind: `text`, or `section_header` when the paragraph detector read a heading. */
    kind: string;
    bbox: Rect;
    /** Text without the detector's heading marker. */
    text: string;
    lines: ItemsExportLine[];
    /**
     * The task's feature row (`names` in the manifest); null where a value is
     * missing (NaN). Empty for a line-level task.
     */
    features: (number | null)[];
}

/** A line of a page's flow (line-level tasks). */
export interface ItemsExportFlowLine extends ItemsExportLine {
    /** The line's block (the paragraph detector's column index). */
    block: number;
    /**
     * Baseline and core of the line's dominant-size glyphs (`lineGeometry`),
     * as y positions in the page's upright reading frame (the frame of `bbox`
     * on unrotated pages); null without glyph metrics.
     */
    baseline: number | null;
    coreTop: number | null;
    coreBottom: number | null;
    /** The paragraph detector's decision: the line starts a draft unit. */
    start: boolean;
    /** The rule that decided it (`START_RULES`), or `model` where the boundary model did. */
    reason: string;
    /**
     * The boundary model's start probability, where it decided
     * (`learnedBoundaries`; not for a page's first line).
     */
    probability?: number;
    /** Break signals and vetoes of the decision (`START_SIGNALS`, `START_VETOES` bits). */
    signals: number;
    vetoes: number;
    /** The draft unit holding the line (index in `units`), -1 when none does. */
    unit: number;
    /** The task's feature row (`names`); null where a value is missing (NaN). */
    features: (number | null)[];
}

export interface ItemsExportItem {
    id: string;
    kind: string;
    bbox: Rect;
    column: number;
    text?: string;
    lines: ItemsExportLine[];
    /** Units the item's lines came from, in order; empty for region items. */
    units: number[];
}

export interface ItemsExportFilteredLine {
    bbox: Rect;
    text: string;
    size: number | null;
    filtered: true;
}

export interface ItemsExportPage {
    index: number;
    width: number;
    height: number;
    rotation: number;
    units: ItemsExportUnit[];
    items: ItemsExportItem[];
    /** Every flow line in reading order (line-level tasks); `l<n>` is the n-th. */
    lines?: ItemsExportFlowLine[];
    /**
     * Lines the margin filter (or region detection) set aside as page
     * furniture, and in presets with the item-type pass, the items it read
     * as furniture.
     */
    filtered_lines: ItemsExportFilteredLine[];
}

export interface ItemsExportRow {
    format: typeof ITEMS_EXPORT_FORMAT;
    task: string;
    feature_set: string;
    feature_version: number;
    schema_version: string;
    page_count: number;
    /** Names of the flow lines' feature rows (line-level tasks). */
    names?: readonly string[];
    pages: ItemsExportPage[];
}

/** Published kinds made from draft items (`DraftItemKind` without `margin`). */
const DRAFT_KINDS: ReadonlySet<DocItem["kind"]> = new Set(["text", "section_header", "reference", "footnote"] satisfies DraftItemKind[]);

/** Units of each step-2 line and item of a page. */
interface PageUnits {
    items: DraftItem[];
    byLine: Map<PageLine, number>;
    byItem: Map<DraftItem, number>;
}

function unitsOf(item: DraftItem, units: PageUnits): number[] {
    const out: number[] = [];
    for (const line of item.lines) {
        const unit = units.byLine.get(line);
        if (unit !== undefined && !out.includes(unit)) out.push(unit);
    }
    if (out.length === 0) {
        const unit = units.byItem.get(item);
        if (unit !== undefined) out.push(unit);
    }
    return out;
}

/** Collects what `items export` needs from the item passes of one run. */
export class ItemsExportCollector {
    private units: PageUnits[] = [];
    private features: number[][][] = [];
    /** Per page: the draft page and its items after every pass. */
    private final: DraftPage[] = [];
    private finalItems: DraftItem[][] = [];
    /** Line-level tasks: each page's boundary input, flow lines and feature rows. */
    private flows = new Map<number, { input: BoundaryPage; flow: PageLine[]; rows: number[][][] }>();

    constructor(private readonly task: ItemsExportTask) {}

    /** Observer of the run's boundary input, for a line-level task. */
    boundaryObserver(): BoundaryObserver | undefined {
        const lineFeatures = this.task.lineFeatures;
        if (!lineFeatures) return undefined;
        return {
            page: (input, flow) => {
                this.flows.set(input.pageIndex, { input, flow, rows: lineFeatures(input) });
            },
        };
    }

    /** The passes to run: a collector before and after the preset's own. */
    passes(presetPasses: readonly ItemPass[]): ItemPass[] {
        return [
            {
                name: "itemsExportUnits",
                run: (doc) => {
                    this.features = this.task.compute?.(doc) ?? [];
                    this.units = doc.pages.map((page) => {
                        const byLine = new Map<PageLine, number>();
                        const byItem = new Map<DraftItem, number>();
                        page.items.forEach((item, i) => {
                            byItem.set(item, i);
                            for (const line of item.lines) byLine.set(line, i);
                        });
                        return { items: page.items.slice(), byLine, byItem };
                    });
                },
            },
            ...presetPasses,
            {
                name: "itemsExportItems",
                run: (doc) => {
                    this.final = doc.pages;
                    this.finalItems = doc.pages.map((page) => page.items.slice());
                },
            },
        ];
    }

    /**
     * The export row of a finished run. `internal` is the run's result and
     * `projected` its public projection (which assigns the ids).
     */
    row(internal: InternalExtractionResult, projected: StructuredExtractResult, task: string, bboxPrecision: number): ItemsExportRow {
        const pages = projected.document.pages.map((publicPage, k): ItemsExportPage => {
            const internalPage = internal.pages[k];
            const draft = this.final[k];
            // Margin drafts (the item-type pass's furniture) become internal
            // margin items, listed with the filtered lines.
            const finalItems = (this.finalItems[k] ?? []).filter((item) => item.kind !== "margin");
            const units = this.units[k];
            if (!draft || !units || internalPage.index !== publicPage.index || draft.pageIndex !== publicPage.index) {
                throw new Error(`items export: page ${publicPage.index} is out of step with the run`);
            }
            const published = internalPage.items.filter((item) => ITEM_KINDS[item.kind].citable);
            if (published.length !== publicPage.items.length) {
                throw new Error(`items export: page ${publicPage.index} has ${published.length} items, its projection ${publicPage.items.length}`);
            }
            // Items made from draft items keep their order through sentence
            // mapping and region placement.
            const fromDrafts = published.filter((item) => DRAFT_KINDS.has(item.kind));
            if (fromDrafts.length !== finalItems.length) {
                throw new Error(`items export: page ${publicPage.index} has ${fromDrafts.length} text items for ${finalItems.length} draft items`);
            }
            const draftOf = new Map<DocItem, DraftItem>(fromDrafts.map((item, i) => [item, finalItems[i]]));
            const toPublic = (bbox: DraftItem["bbox"]) =>
                bboxToRect(
                    draft.frame && draft.frame.rotation !== 0
                        ? inverseRotateBBox(bbox, draft.frame.rotation, draft.frame.sourceWidth, draft.frame.sourceHeight)
                        : bbox,
                    bboxPrecision,
                );
            const linesOf = (item: DraftItem) =>
                item.lines.map((line, n): ItemsExportLine => {
                    const role = item.roles[n];
                    return {
                        bbox: toPublic(line.bbox),
                        text: line.text,
                        font: lineFace(line).font,
                        size: Math.round(lineSize(line) * 100) / 100,
                        role: role === "entry" ? 1 : role === "continuation" ? 2 : 0,
                    };
                });
            const pageFeatures = this.features[k] ?? [];
            const unitFeatures = (unit: number) =>
                this.task.compute
                    ? (pageFeatures[unit] ?? this.task.features.map(() => NaN)).map((v) => (Number.isFinite(v) ? v : null))
                    : [];
            const flowLines = this.task.lineFeatures ? this.flowLines(draft.pageIndex, units, toPublic, bboxPrecision) : undefined;
            return {
                index: publicPage.index,
                width: publicPage.width,
                height: publicPage.height,
                rotation: publicPage.rotation,
                units: units.items.map((item, unit): ItemsExportUnit => ({
                    unit,
                    kind: item.kind,
                    bbox: toPublic(item.bbox),
                    text: item.text,
                    lines: linesOf(item),
                    features: unitFeatures(unit),
                })),
                items: publicPage.items.map((publicItem, j): ItemsExportItem => {
                    const source = draftOf.get(published[j]);
                    return {
                        id: publicItem.id,
                        kind: publicItem.kind,
                        bbox: publicItem.bbox,
                        column: published[j].columnIndex,
                        ...("text" in publicItem && publicItem.text !== undefined ? { text: publicItem.text } : {}),
                        lines: source ? linesOf(source) : [],
                        units: source ? unitsOf(source, units) : [],
                    };
                }),
                filtered_lines: internalPage.items
                    .filter((item) => !ITEM_KINDS[item.kind].citable)
                    .map((item): ItemsExportFilteredLine => ({
                        bbox: bboxToRect(item.bbox, bboxPrecision),
                        text: "text" in item ? item.text : "",
                        size: ("lines" in item ? item.lines?.[0]?.fontSize : undefined) ?? null,
                        filtered: true,
                    })),
                ...(flowLines ? { lines: flowLines } : {}),
            };
        });
        return {
            format: ITEMS_EXPORT_FORMAT,
            task,
            feature_set: this.task.featureSet,
            feature_version: this.task.featureVersion,
            schema_version: projected.schemaVersion,
            page_count: projected.document.pageCount,
            ...(this.task.lineFeatures ? { names: this.task.features } : {}),
            pages,
        };
    }

    /** The flow lines of a page (line-level tasks), from the captured boundary input. */
    private flowLines(
        pageIndex: number,
        units: PageUnits,
        toPublic: (bbox: DraftItem["bbox"]) => Rect,
        bboxPrecision: number,
    ): ItemsExportFlowLine[] {
        const captured = this.flows.get(pageIndex);
        if (!captured) return [];
        const out: ItemsExportFlowLine[] = [];
        const scale = 10 ** bboxPrecision;
        const position = (v: number | null) => (v === null ? null : Math.round(v * scale) / scale);
        let n = 0;
        captured.input.blocks.forEach((block, b) => {
            block.lines.forEach((line, j) => {
                const source = captured.flow[n++];
                out.push({
                    bbox: toPublic(source.bbox),
                    text: line.text,
                    font: line.font,
                    size: Math.round(line.size * 100) / 100,
                    role: line.role,
                    block: block.index,
                    baseline: position(line.baseline),
                    coreTop: position(line.coreTop),
                    coreBottom: position(line.coreBottom),
                    start: line.start,
                    reason: line.rule ?? "model",
                    signals: line.signals,
                    vetoes: line.vetoes,
                    ...(line.probability !== undefined ? { probability: line.probability } : {}),
                    unit: units.byLine.get(source) ?? -1,
                    features: captured.rows[b][j].map((v) => (Number.isFinite(v) ? v : null)),
                });
            });
        });
        return out;
    }
}

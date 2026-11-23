/**
 * A research table as an Excel workbook (.xlsx).
 *
 * Three sheets: **Table** (the columns of `exportColumns`, one row per table
 * row, with a frozen header and title column, a filter on the header and
 * categories filled in their colours), **Evidence** (each answer's reasoning
 * and cited passages, when any cell has them) and **About** (the table's
 * title, description and the question behind each column).
 *
 * The SpreadsheetML is written directly: the workbook uses a fixed set of
 * styles, and no spreadsheet library this bundle could carry writes cell
 * styles without a commercial licence.
 */

import JSZip from "jszip";
import { escapeXml } from "../math/xml";
import {
    exportCellDetails,
    exportColumns,
    exportValue,
    type ExportCellDetail,
    type ExportColumn,
    type ExportValue,
} from "@beaver/agent-core/layouts/tableExport";
import {
    SELECT_COLORS,
    type Column,
    type Row,
    type SelectColor,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";

export interface WriteXlsxInput {
    spec: TableSpec;
    /** The rows to write, in order; defaults to the table's. */
    rows?: Row[];
    /** When the export was made, for the About sheet and the file's properties. */
    exportedAt?: Date;
}

export interface WriteXlsxResult {
    bytes: Uint8Array;
    stats: { rows: number; columns: number; evidenceRows: number };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TEXT_COLOR = "FF1F2328";
const MUTED_COLOR = "FF6B7280";
const FAINT_COLOR = "FF8A8F98";
const LINK_COLOR = "FF1D6FB8";
const HEADER_FILL = "FFF3F4F6";
const HEADER_BORDER = "FFD1D5DB";
const BODY_BORDER = "FFE5E7EB";

/** Category colours as the grid draws them, made opaque: [fill, text]. */
const SELECT_PALETTE: Record<SelectColor, [string, string]> = {
    gray: ["FFF0F0F0", "FF5F6368"],
    blue: ["FFE6F4FC", "FF1B6FA3"],
    green: ["FFE4F8EB", "FF15803D"],
    yellow: ["FFFFF7D6", "FF946200"],
    orange: ["FFFCF0E1", "FFC2410C"],
    red: ["FFFFECEC", "FFC62828"],
    purple: ["FFF1EBFE", "FF6D28D9"],
};

/** Cell style ids, indexes into `cellXfs`. */
const S = {
    header: 1,
    text: 2,
    title: 3,
    muted: 4,
    /** Years and yes/no answers. */
    centered: 5,
    link: 6,
    notReported: 7,
    sheetTitle: 8,
    label: 9,
    plain: 10,
    /** First category style; one per `SELECT_COLORS` entry, in order. */
    select: 11,
} as const;

function stylesXml(): string {
    const font = (color: string, extra = "", size = 11) =>
        `<font>${extra}<sz val="${size}"/><color rgb="${color}"/><name val="Calibri"/><family val="2"/></font>`;
    const fonts = [
        font(TEXT_COLOR), // 0 body
        font(TEXT_COLOR, "<b/>"), // 1 bold
        font(MUTED_COLOR), // 2 muted
        font(LINK_COLOR, "<u/>"), // 3 link
        font(FAINT_COLOR, "<i/>"), // 4 not reported
        font(TEXT_COLOR, "<b/>", 16), // 5 sheet title
        ...SELECT_COLORS.map((c) => font(SELECT_PALETTE[c][1])), // 6.. categories
    ];
    const solid = (color: string) =>
        `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`;
    const fills = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        solid(HEADER_FILL), // 2
        ...SELECT_COLORS.map((c) => solid(SELECT_PALETTE[c][0])), // 3..
    ];
    const bottom = (color: string) =>
        `<border><left/><right/><top/><bottom style="thin"><color rgb="${color}"/></bottom><diagonal/></border>`;
    const borders = [
        "<border><left/><right/><top/><bottom/><diagonal/></border>",
        bottom(BODY_BORDER), // 1
        bottom(HEADER_BORDER), // 2
    ];
    const xf = (
        fontId: number,
        fillId: number,
        borderId: number,
        align: string,
    ) =>
        `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
        `${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}` +
        `${align ? ` applyAlignment="1"><alignment ${align}/></xf>` : "/>"}`;
    const top = 'vertical="top" wrapText="1"';
    const cellXfs = [
        xf(0, 0, 0, ""), // 0 default
        xf(1, 2, 2, 'vertical="center" wrapText="1"'), // header
        xf(0, 0, 1, top), // text
        xf(1, 0, 1, top), // title
        xf(2, 0, 1, top), // muted
        xf(0, 0, 1, 'horizontal="center" vertical="top"'), // centered
        xf(3, 0, 1, top), // link
        xf(4, 0, 1, top), // not reported
        xf(5, 0, 0, ""), // sheet title
        xf(1, 0, 0, top), // label
        xf(0, 0, 0, top), // plain
        ...SELECT_COLORS.map((_, i) => xf(6 + i, 3 + i, 1, top)), // categories
    ];
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
        `<fills count="${fills.length}">${fills.join("")}</fills>` +
        `<borders count="${borders.length}">${borders.join("")}</borders>` +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>"
    );
}

// ---------------------------------------------------------------------------
// Cells and sheets
// ---------------------------------------------------------------------------

/** Excel's limit on the characters of one cell. */
const MAX_CELL_CHARS = 32767;

function cellText(text: string): string {
    const clean = text.replace(/\r\n?/g, "\n");
    return clean.length > MAX_CELL_CHARS
        ? `${clean.slice(0, MAX_CELL_CHARS - 1)}…`
        : clean;
}

/** `A`, `B`, …, `Z`, `AA`, … for a 0-based column index. */
function columnName(index: number): string {
    let name = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
        name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
}

/** The workbook's strings, written once and referenced by index. */
class SharedStrings {
    private readonly index = new Map<string, number>();
    private readonly list: string[] = [];
    private uses = 0;

    id(text: string): number {
        this.uses += 1;
        let id = this.index.get(text);
        if (id === undefined) {
            id = this.list.length;
            this.list.push(text);
            this.index.set(text, id);
        }
        return id;
    }

    xml(): string {
        const items = this.list.map((text) => {
            const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "";
            return `<si><t${space}>${escapeXml(text)}</t></si>`;
        });
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.uses}" uniqueCount="${this.list.length}">` +
            items.join("") +
            "</sst>"
        );
    }
}

/** One cell to write. */
interface SheetCell {
    style: number;
    text?: string;
    number?: number;
    href?: string;
}

interface SheetSpec {
    name: string;
    /** Width of each column, in characters. */
    widths: number[];
    rows: SheetCell[][];
    /** Freeze the first row, and the first column when true. */
    freeze?: { column: boolean };
    /** Put a filter on the first row over the whole sheet. */
    filter?: boolean;
    landscape?: boolean;
}

interface WrittenSheet {
    xml: string;
    rels?: string;
    filterRef?: string;
}

function writeSheet(sheet: SheetSpec, strings: SharedStrings): WrittenSheet {
    const links: { ref: string; href: string }[] = [];
    const width = Math.max(sheet.widths.length, ...sheet.rows.map((r) => r.length), 1);
    const lastRef = `${columnName(width - 1)}${Math.max(sheet.rows.length, 1)}`;
    const rowsXml = sheet.rows.map((cells, r) => {
        const cellsXml = cells.map((cell, c) => {
            const ref = `${columnName(c)}${r + 1}`;
            if (cell.href) links.push({ ref, href: cell.href });
            if (cell.number !== undefined && Number.isFinite(cell.number))
                return `<c r="${ref}" s="${cell.style}"><v>${cell.number}</v></c>`;
            if (cell.text)
                return `<c r="${ref}" s="${cell.style}" t="s"><v>${strings.id(cellText(cell.text))}</v></c>`;
            return `<c r="${ref}" s="${cell.style}"/>`;
        });
        return `<row r="${r + 1}">${cellsXml.join("")}</row>`;
    });
    const pane = sheet.freeze
        ? sheet.freeze.column
            ? '<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>' +
              '<selection pane="topRight"/><selection pane="bottomLeft"/>' +
              '<selection pane="bottomRight" activeCell="B2" sqref="B2"/>'
            : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
              '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
        : "";
    const cols = sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("");
    const filterRef = sheet.filter && sheet.rows.length ? `A1:${lastRef}` : undefined;
    const hyperlinks = links.length
        ? `<hyperlinks>${links
              .map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`)
              .join("")}</hyperlinks>`
        : "";
    const xml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<dimension ref="A1:${lastRef}"/>` +
        `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
        '<sheetFormatPr defaultRowHeight="15"/>' +
        (cols ? `<cols>${cols}</cols>` : "") +
        `<sheetData>${rowsXml.join("")}</sheetData>` +
        (filterRef ? `<autoFilter ref="${filterRef}"/>` : "") +
        hyperlinks +
        '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
        (sheet.landscape ? '<pageSetup orientation="landscape"/>' : "") +
        "</worksheet>";
    const rels = links.length
        ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          links
              .map(
                  (l, i) =>
                      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(l.href)}" TargetMode="External"/>`,
              )
              .join("") +
          "</Relationships>"
        : undefined;
    return { xml, rels, ...(filterRef ? { filterRef } : {}) };
}

// ---------------------------------------------------------------------------
// The table's sheets
// ---------------------------------------------------------------------------

function valueCell(value: ExportValue, kind: ExportColumn["kind"]): SheetCell {
    switch (value.kind) {
        case "empty":
            return { style: S.text };
        case "not_reported":
            return { style: S.notReported, text: value.text };
        case "number":
            return { style: S.centered, number: value.value };
        case "boolean":
            return { style: S.centered, text: value.text };
        case "select":
            return {
                style: S.select + SELECT_COLORS.indexOf(value.color ?? "gray"),
                text: value.label,
            };
        case "text": {
            const style =
                kind === "title"
                    ? S.title
                    : kind === "authors" || kind === "venue"
                      ? S.muted
                      : value.href
                        ? S.link
                        : S.text;
            return value.href
                ? { style, text: value.text, href: value.href }
                : { style, text: value.text };
        }
    }
}

/** Column width in characters: fixed by kind, and for a category column by its longest label. */
function columnWidth(column: ExportColumn, values: ExportValue[][], index: number): number {
    switch (column.kind) {
        case "title":
            return 48;
        case "authors":
            return 28;
        case "venue":
            return 26;
        case "year":
            return 8;
        case "identifier":
            return 26;
        case "question": {
            const { type } = column.column;
            if (type === "boolean") return Math.min(Math.max(column.header.length + 2, 10), 24);
            if (type !== "select") return 44;
            let longest = column.header.length;
            for (const row of values) {
                const value = row[index];
                if (value.kind === "select") longest = Math.max(longest, value.label.length);
            }
            return Math.min(Math.max(longest + 3, 14), 32);
        }
    }
}

function tableSheet(columns: ExportColumn[], rows: Row[]): SheetSpec {
    const values = rows.map((row) => columns.map((column) => exportValue(row, column)));
    return {
        name: "Table",
        widths: columns.map((column, c) => columnWidth(column, values, c)),
        rows: [
            columns.map((column) => ({ style: S.header, text: column.header })),
            ...values.map((row) => row.map((value, c) => valueCell(value, columns[c].kind))),
        ],
        freeze: { column: true },
        filter: true,
        landscape: true,
    };
}

function passageText(detail: ExportCellDetail): string {
    return detail.passages
        .map((p) => {
            const page = p.page ? `p. ${p.page}: ` : "";
            const context = p.context ? `\n(${p.context})` : "";
            return `${page}“${p.quote}”${context}`;
        })
        .join("\n\n");
}

function evidenceSheet(spec: TableSpec, rows: Row[], columns: ExportColumn[]): SheetSpec | undefined {
    const details = exportCellDetails(spec, rows);
    if (!details.length) return undefined;
    const title = columns.find((c) => c.kind === "title");
    return {
        name: "Evidence",
        widths: [40, 24, 32, 56, 80],
        rows: [
            ["Title", "Column", "Answer", "Reasoning", "Evidence"].map((text) => ({
                style: S.header,
                text,
            })),
            ...details.map((detail) => [
                title
                    ? valueCell(exportValue(detail.row, title), "title")
                    : { style: S.title },
                { style: S.text, text: detail.column.header },
                valueCell(detail.value, "question"),
                { style: S.text, text: detail.reasoning ?? "" },
                { style: S.text, text: passageText(detail) },
            ]),
        ],
        freeze: { column: false },
        filter: true,
        landscape: true,
    };
}

function typeLabel(column: Column): string {
    switch (column.type) {
        case "text":
            return "Text";
        case "boolean":
            return "Yes / No";
        case "select":
            return "Category";
        default:
            return column.type.charAt(0).toUpperCase() + column.type.slice(1);
    }
}

function exportDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function aboutSheet(spec: TableSpec, rows: Row[], columns: ExportColumn[], exportedAt: Date): SheetSpec {
    const questions = columns.filter((c) => c.kind === "question");
    const line = (label: string, text: string): SheetCell[] => [
        { style: S.label, text: label },
        { style: S.plain, text },
    ];
    const sheetRows: SheetCell[][] = [
        [{ style: S.sheetTitle, text: spec.title || "Table" }],
        ...(spec.description ? [line("Description", spec.description)] : []),
        [
            { style: S.label, text: "Items" },
            { style: S.plain, number: rows.length },
        ],
        line("Exported", exportDate(exportedAt)),
    ];
    if (questions.length) {
        sheetRows.push(
            [],
            ["Column", "Question", "Type", "Categories"].map((text) => ({
                style: S.header,
                text,
            })),
            ...questions.map(({ column }) => [
                { style: S.title, text: column.header },
                { style: S.text, text: column.description ?? "" },
                { style: S.text, text: typeLabel(column) },
                {
                    style: S.text,
                    text: (column.options ?? [])
                        .map((o) => (o.description ? `${o.label}: ${o.description}` : o.label))
                        .join("\n"),
                },
            ]),
        );
    }
    return { name: "About", widths: [26, 64, 12, 64], rows: sheetRows };
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A sheet name as Excel accepts it, quoted for a formula reference. */
function sheetRef(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
}

/** `A1:K13` as an absolute reference, `$A$1:$K$13`. */
function absolute(ref: string): string {
    return ref.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
}

export async function writeXlsx(input: WriteXlsxInput): Promise<WriteXlsxResult> {
    const { spec } = input;
    const rows = input.rows ?? spec.rows;
    const exportedAt = input.exportedAt ?? new Date();
    const strings = new SharedStrings();
    const columns = exportColumns(spec, rows);
    const table = tableSheet(columns, rows);
    const evidence = evidenceSheet(spec, rows, columns);
    const sheets = [table, ...(evidence ? [evidence] : []), aboutSheet(spec, rows, columns, exportedAt)];
    const written = sheets.map((sheet) => writeSheet(sheet, strings));

    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        XML_HEADER +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            sheets
                .map(
                    (_, i) =>
                        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
                )
                .join("") +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
            "</Types>",
    );
    zip.file(
        "_rels/.rels",
        XML_HEADER +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
            `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
            "</Relationships>",
    );
    zip.file(
        "docProps/core.xml",
        XML_HEADER +
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
            `<dc:title>${escapeXml(spec.title || "Table")}</dc:title>` +
            "<dc:creator>Beaver</dc:creator>" +
            `<dcterms:created xsi:type="dcterms:W3CDTF">${exportedAt.toISOString().replace(/\.\d{3}Z$/, "Z")}</dcterms:created>` +
            "</cp:coreProperties>",
    );
    zip.file(
        "docProps/app.xml",
        XML_HEADER +
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
            "<Application>Beaver</Application></Properties>",
    );
    const filters = written
        .map((sheet, i) =>
            sheet.filterRef
                ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(sheetRef(sheets[i].name))}!${absolute(sheet.filterRef)}</definedName>`
                : "",
        )
        .join("");
    zip.file(
        "xl/workbook.xml",
        XML_HEADER +
            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}">` +
            '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
            sheets
                .map(
                    (sheet, i) =>
                        `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
                )
                .join("") +
            "</sheets>" +
            (filters ? `<definedNames>${filters}</definedNames>` : "") +
            "</workbook>",
    );
    zip.file(
        "xl/_rels/workbook.xml.rels",
        XML_HEADER +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            sheets
                .map(
                    (_, i) =>
                        `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
                )
                .join("") +
            `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>` +
            `<Relationship Id="rId${sheets.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
            "</Relationships>",
    );
    written.forEach((sheet, i) => {
        zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheet.xml);
        if (sheet.rels) zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, sheet.rels);
    });
    zip.file("xl/styles.xml", stylesXml());
    zip.file("xl/sharedStrings.xml", strings.xml());

    const bytes = await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
    });
    return {
        bytes,
        stats: {
            rows: rows.length,
            columns: table.widths.length,
            evidenceRows: evidence ? evidence.rows.length - 1 : 0,
        },
    };
}

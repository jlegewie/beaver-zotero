/**
 * Draws a PDF extraction over the pages of a Zotero PDF reader, with a small
 * panel and a hover tooltip. The panel switches between three views: the
 * detected columns and lines (`stageViewModel.ts`), and the items the agent
 * sees (`agentPageViewModel.ts`), where the tooltip shows the exact text the
 * model receives for an element.
 *
 * The layer lives inside each PDF.js `.page` div and is positioned in
 * percentages of the page, so it follows zoom and scrolling without
 * recomputation. PDF.js removes foreign children from a page whenever it
 * resets the page (zoom, or a far-away page being released), so a
 * MutationObserver re-attaches layers after every change to the viewer.
 *
 * Everything drawn on the page has `pointer-events: none`: text selection,
 * links and annotation tools keep working while the view is shown. Hover hit
 * testing is done from a `mousemove` listener against the model's rects.
 */

import type { AgentViewBox, AgentViewBoxKind, ViewPage } from './agentPageViewModel';

export type AgentViewMode = 'columns' | 'lines' | 'items';

/** One view the panel can switch to. */
export interface AgentViewLayer {
    pages: ViewPage[];
    /** Shown in the panel while the view is selected. */
    summary: string;
}

const PREFIX = 'beaver-agent-view';
const STYLE_ID = `${PREFIX}-style`;
const LAYER_CLASS = `${PREFIX}-layer`;
const HIDE_IDS_CLASS = `${PREFIX}-hide-ids`;
const TOOLTIP_MAX_CHARS = 1500;

/** Panel switcher, in pipeline order. */
const MODES: { mode: AgentViewMode; label: string }[] = [
    { mode: 'columns', label: 'Columns' },
    { mode: 'lines', label: 'Lines' },
    { mode: 'items', label: 'Items' },
];

const LEGENDS: Record<AgentViewMode, { kind: AgentViewBoxKind; label: string }[]> = {
    columns: [
        { kind: 'column', label: 'Column' },
    ],
    lines: [
        { kind: 'line', label: 'Line (shades alternate)' },
    ],
    items: [
        { kind: 'sentence', label: 'Sentence' },
        { kind: 'item', label: 'Whole item (heading, unsplit text)' },
        { kind: 'table', label: 'Table' },
        { kind: 'table_row', label: 'Table row (one sentence)' },
        { kind: 'figure', label: 'Figure (label text only)' },
        { kind: 'equation', label: 'Equation' },
    ],
};

const STYLESHEET = `
.${LAYER_CLASS} {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 6;
}
.${PREFIX}-box {
    position: absolute;
    box-sizing: border-box;
    border-radius: 1px;
}
.${PREFIX}-box[data-kind="table"] { border: 2px solid rgba(0, 122, 255, 0.9); background: rgba(0, 122, 255, 0.04); }
.${PREFIX}-box[data-kind="figure"] { border: 2px solid rgba(175, 82, 222, 0.9); background: rgba(175, 82, 222, 0.06); }
.${PREFIX}-box[data-kind="equation"] { border: 2px solid rgba(255, 149, 0, 0.95); background: rgba(255, 149, 0, 0.08); }
.${PREFIX}-box[data-kind="item"] { border: 1px dashed rgba(36, 160, 70, 0.95); background: rgba(52, 199, 89, 0.12); }
.${PREFIX}-box[data-kind="sentence"][data-shade="0"] { background: rgba(255, 45, 85, 0.16); box-shadow: inset 0 -1px rgba(255, 45, 85, 0.55); }
.${PREFIX}-box[data-kind="sentence"][data-shade="1"] { background: rgba(255, 204, 0, 0.24); box-shadow: inset 0 -1px rgba(214, 160, 0, 0.7); }
.${PREFIX}-box[data-kind="table_row"][data-shade="0"] { background: rgba(48, 176, 199, 0.22); }
.${PREFIX}-box[data-kind="table_row"][data-shade="1"] { background: rgba(88, 86, 214, 0.16); }
.${PREFIX}-box[data-kind="column"] { border: 2px solid rgba(0, 150, 136, 0.9); background: rgba(0, 150, 136, 0.05); }
.${PREFIX}-box[data-kind="line"][data-shade="0"] { background: rgba(0, 122, 255, 0.14); box-shadow: inset 0 -1px rgba(0, 122, 255, 0.55); }
.${PREFIX}-box[data-kind="line"][data-shade="1"] { background: rgba(255, 149, 0, 0.18); box-shadow: inset 0 -1px rgba(214, 120, 0, 0.7); }
.${PREFIX}-box.is-hovered { outline: 2px solid rgba(0, 0, 0, 0.75); outline-offset: 1px; }
.${PREFIX}-chip {
    position: absolute;
    transform: translateY(-100%);
    padding: 0 3px;
    border-radius: 3px 3px 3px 0;
    font: 600 9px/12px system-ui, -apple-system, sans-serif;
    color: #fff;
    white-space: nowrap;
    opacity: 0.9;
}
.${PREFIX}-chip[data-kind="table"] { background: rgb(0, 122, 255); }
.${PREFIX}-chip[data-kind="figure"] { background: rgb(175, 82, 222); }
.${PREFIX}-chip[data-kind="equation"] { background: rgb(230, 130, 0); }
.${PREFIX}-chip[data-kind="item"] { background: rgb(36, 160, 70); }
.${PREFIX}-chip[data-kind="sentence"] { background: rgb(220, 30, 75); }
.${PREFIX}-chip[data-kind="sentence"][data-shade="1"] { background: rgb(190, 140, 0); }
.${PREFIX}-chip[data-kind="table_row"] { background: rgb(30, 140, 165); transform: translateX(-100%); border-radius: 3px 0 0 3px; }
.${PREFIX}-chip[data-kind="table_row"][data-shade="1"] { background: rgb(88, 86, 214); }
.${PREFIX}-chip[data-kind="column"] { background: rgb(0, 137, 123); }
.${PREFIX}-chip[data-kind="line"] { background: rgb(0, 100, 220); transform: translateX(-100%); border-radius: 3px 0 0 3px; }
.${PREFIX}-chip[data-kind="line"][data-shade="1"] { background: rgb(200, 110, 0); }
.${HIDE_IDS_CLASS} .${PREFIX}-chip { display: none; }

.${PREFIX}-panel, .${PREFIX}-tooltip {
    position: fixed;
    z-index: 100000;
    font: 12px/1.4 system-ui, -apple-system, sans-serif;
    color: #1d1d1f;
    background: rgba(255, 255, 255, 0.97);
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}
.${PREFIX}-panel { top: 10px; right: 10px; width: 250px; padding: 8px 10px; }
.${PREFIX}-panel-header { display: flex; align-items: center; justify-content: space-between; font-weight: 600; margin-bottom: 4px; }
.${PREFIX}-close { border: none; background: none; font-size: 16px; line-height: 1; cursor: pointer; color: inherit; padding: 0 2px; }
.${PREFIX}-modes { display: flex; gap: 2px; margin: 2px 0 8px; padding: 2px; border-radius: 6px; background: rgba(0, 0, 0, 0.07); }
.${PREFIX}-modes[hidden] { display: none; }
.${PREFIX}-modes button { flex: 1; border: none; border-radius: 4px; padding: 2px 0; background: none; color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
.${PREFIX}-modes button[aria-pressed="true"] { background: #fff; font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
.${PREFIX}-status { margin-bottom: 6px; white-space: pre-line; }
.${PREFIX}-status[data-tone="error"] { color: #c62828; }
.${PREFIX}-legend { display: grid; grid-template-columns: 14px 1fr; gap: 3px 6px; align-items: center; margin: 6px 0; }
.${PREFIX}-legend .${PREFIX}-box { position: static; width: 14px; height: 10px; }
.${PREFIX}-toggle { display: flex; gap: 4px; align-items: center; margin-top: 6px; font-size: 11px; }
.${PREFIX}-tooltip { max-width: 440px; padding: 6px 8px; pointer-events: none; display: none; }
.${PREFIX}-tooltip-title { font-weight: 600; margin-bottom: 3px; }
.${PREFIX}-tooltip pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 11px/1.4 ui-monospace, Menlo, monospace; }
@media (prefers-color-scheme: dark) {
    .${PREFIX}-panel, .${PREFIX}-tooltip { color: #f5f5f7; background: rgba(40, 40, 42, 0.97); border-color: rgba(255, 255, 255, 0.15); }
    .${PREFIX}-status[data-tone="error"] { color: #ff8a80; }
    .${PREFIX}-box.is-hovered { outline-color: rgba(255, 255, 255, 0.85); }
    .${PREFIX}-modes { background: rgba(255, 255, 255, 0.1); }
    .${PREFIX}-modes button[aria-pressed="true"] { background: rgba(255, 255, 255, 0.22); }
}
`;

function percent(value: number, total: number): string {
    return `${(value / total) * 100}%`;
}

function boxArea(box: AgentViewBox): number {
    return box.rects.reduce((sum, [l, t, r, b]) => sum + Math.max(0, r - l) * Math.max(0, b - t), 0);
}

/** One reader's overlay: page layers, panel (view switcher and legend) and hover tooltip. */
export class AgentPageOverlay {
    private readonly doc: Document;
    private readonly viewer: Element | null;
    private readonly container: Element | null;
    private views: Record<AgentViewMode, AgentViewLayer> | null = null;
    private pages = new Map<number, ViewPage>();
    private observer: MutationObserver | null = null;
    private ensureTimer: number | null = null;
    private panel: HTMLElement | null = null;
    private modesEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private detailsEl: HTMLElement | null = null;
    private legendEl: HTMLElement | null = null;
    private tooltip: HTMLElement | null = null;
    /** The box whose text the tooltip holds. */
    private tooltipBox: AgentViewBox | null = null;
    private hovered: { pageIndex: number; boxIndex: number } | null = null;
    private disposed = false;

    /**
     * @param win  The PDF view's iframe window (`_primaryView._iframeWindow`).
     * @param hostWin  The chrome window hosting the reader; owns the observer and timers.
     * @param title  Panel heading.
     * @param onClose  Called when the user closes the panel.
     * @param mode  The view shown once the extraction arrives.
     */
    constructor(
        private readonly win: Window,
        private readonly hostWin: Window,
        private readonly title: string,
        private readonly onClose: () => void,
        private mode: AgentViewMode = 'items',
    ) {
        this.doc = win.document;
        this.viewer = this.doc.getElementById('viewer');
        this.container = this.doc.getElementById('viewerContainer');
        this.installStyle();
        this.buildPanel();
        this.buildTooltip();
        // Capture phase: the reader stops `mousemove` from bubbling out of the page.
        this.container?.addEventListener('mousemove', this.onMouseMove as EventListener, true);
        this.container?.addEventListener('mouseleave', this.onMouseLeave);
    }

    /** Show a status line in the panel (progress or an error). */
    setStatus(text: string, tone: 'info' | 'error' = 'info'): void {
        if (!this.statusEl) return;
        this.statusEl.textContent = text;
        this.statusEl.dataset.tone = tone;
    }

    /** The selected view. */
    get currentMode(): AgentViewMode {
        return this.mode;
    }

    /** Provide every view, reveal the switcher and legend, and draw the selected view. */
    setViews(views: Record<AgentViewMode, AgentViewLayer>): void {
        if (this.disposed) return;
        this.views = views;
        if (this.modesEl) this.modesEl.hidden = false;
        if (this.detailsEl) this.detailsEl.hidden = false;
        this.showMode(this.mode);
        if (!this.observer && this.viewer) {
            // Chrome-side observer: its callback runs in this realm.
            const observer = new this.hostWin.MutationObserver(() => this.scheduleEnsureLayers());
            observer.observe(this.viewer, { childList: true, subtree: true });
            this.observer = observer;
        }
    }

    private showMode(mode: AgentViewMode): void {
        if (this.disposed || !this.views) return;
        this.mode = mode;
        const view = this.views[mode];
        this.setHovered(null);
        this.pages = new Map(view.pages.map((page) => [page.pageIndex, page]));
        this.removeLayers();
        this.ensureLayers();
        this.setStatus(view.summary);
        this.renderLegend();
        this.modesEl?.querySelectorAll('button').forEach((button: HTMLButtonElement) => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.observer?.disconnect();
        this.observer = null;
        if (this.ensureTimer !== null) {
            try {
                this.hostWin.clearTimeout(this.ensureTimer);
            } catch {
                // The reader is already gone.
            }
        }
        try {
            this.container?.removeEventListener('mousemove', this.onMouseMove as EventListener, true);
            this.container?.removeEventListener('mouseleave', this.onMouseLeave);
            this.removeLayers();
            this.panel?.remove();
            this.tooltip?.remove();
            this.doc.getElementById(STYLE_ID)?.remove();
            this.doc.documentElement.classList.remove(HIDE_IDS_CLASS);
        } catch {
            // The reader is already gone.
        }
        this.pages.clear();
    }

    // ---- page layers ----

    private removeLayers(): void {
        this.doc.querySelectorAll(`.${LAYER_CLASS}`).forEach((layer: Element) => layer.remove());
    }

    private scheduleEnsureLayers(): void {
        if (this.disposed || this.ensureTimer !== null) return;
        this.ensureTimer = this.hostWin.setTimeout(() => {
            this.ensureTimer = null;
            this.ensureLayers();
        }, 30);
    }

    /** Attach a layer to every rendered page that lacks one. */
    private ensureLayers(): void {
        if (this.disposed || !this.viewer) return;
        this.viewer.querySelectorAll('.page[data-page-number]').forEach((pageEl: Element) => {
            if (!pageEl.querySelector(':scope > .canvasWrapper')) return;
            if (pageEl.querySelector(`:scope > .${LAYER_CLASS}`)) return;
            const page = this.pages.get(Number(pageEl.getAttribute('data-page-number')) - 1);
            if (page) pageEl.appendChild(this.buildLayer(page));
        });
    }

    private buildLayer(page: ViewPage): HTMLElement {
        const layer = this.doc.createElement('div');
        layer.className = LAYER_CLASS;
        layer.dataset.pageIndex = String(page.pageIndex);
        page.boxes.forEach((box, boxIndex) => {
            box.rects.forEach(([l, t, r, b], rectIndex) => {
                const el = this.doc.createElement('div');
                el.className = `${PREFIX}-box`;
                el.dataset.kind = box.kind;
                el.dataset.shade = String(box.shade);
                el.dataset.box = String(boxIndex);
                el.style.left = percent(l, page.width);
                el.style.top = percent(t, page.height);
                el.style.width = percent(r - l, page.width);
                el.style.height = percent(b - t, page.height);
                layer.appendChild(el);
                if (rectIndex === 0) {
                    const chip = this.doc.createElement('span');
                    chip.className = `${PREFIX}-chip`;
                    chip.dataset.kind = box.kind;
                    chip.dataset.shade = String(box.shade);
                    chip.textContent = box.id;
                    chip.style.left = percent(l, page.width);
                    chip.style.top = percent(t, page.height);
                    layer.appendChild(chip);
                }
            });
        });
        return layer;
    }

    // ---- hover ----

    private readonly onMouseMove = (event: MouseEvent): void => {
        const target = event.target as Element | null;
        const pageEl = target?.closest?.('.page[data-page-number]');
        const page = pageEl
            ? this.pages.get(Number(pageEl.getAttribute('data-page-number')) - 1)
            : undefined;
        if (!pageEl || !page) {
            this.setHovered(null);
            return;
        }
        const rect = pageEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = ((event.clientX - rect.left) / rect.width) * page.width;
        const y = ((event.clientY - rect.top) / rect.height) * page.height;

        // The smallest box under the pointer wins, so a table row beats its table.
        let hitIndex = -1;
        let hitArea = Infinity;
        page.boxes.forEach((box, index) => {
            if (!box.rects.some(([l, t, r, b]) => x >= l && x <= r && y >= t && y <= b)) return;
            const area = boxArea(box);
            if (area < hitArea) {
                hitIndex = index;
                hitArea = area;
            }
        });
        if (hitIndex < 0) {
            this.setHovered(null);
            return;
        }
        this.setHovered({ pageIndex: page.pageIndex, boxIndex: hitIndex });
        this.showTooltip(page.boxes[hitIndex], event.clientX, event.clientY);
    };

    private readonly onMouseLeave = (): void => {
        this.setHovered(null);
    };

    private setHovered(next: { pageIndex: number; boxIndex: number } | null): void {
        const prev = this.hovered;
        if (prev && next && prev.pageIndex === next.pageIndex && prev.boxIndex === next.boxIndex) return;
        if (prev) this.toggleHoverClass(prev, false);
        this.hovered = next;
        if (next) this.toggleHoverClass(next, true);
        else if (this.tooltip) this.tooltip.style.display = 'none';
    }

    private toggleHoverClass(ref: { pageIndex: number; boxIndex: number }, on: boolean): void {
        const layer = this.viewer?.querySelector(`.${LAYER_CLASS}[data-page-index="${ref.pageIndex}"]`);
        layer?.querySelectorAll(`.${PREFIX}-box[data-box="${ref.boxIndex}"]`)
            .forEach((el: Element) => el.classList.toggle('is-hovered', on));
    }

    private showTooltip(box: AgentViewBox, clientX: number, clientY: number): void {
        const tooltip = this.tooltip;
        if (!tooltip) return;
        const title = tooltip.firstElementChild as HTMLElement;
        const body = tooltip.lastElementChild as HTMLElement;
        if (this.tooltipBox !== box) {
            this.tooltipBox = box;
            title.textContent = box.title;
            body.textContent = box.text.length > TOOLTIP_MAX_CHARS
                ? `${box.text.slice(0, TOOLTIP_MAX_CHARS)}…`
                : box.text;
        }
        tooltip.style.display = 'block';
        const margin = 14;
        const { innerWidth, innerHeight } = this.win;
        const width = tooltip.offsetWidth;
        const height = tooltip.offsetHeight;
        const left = clientX + margin + width > innerWidth ? clientX - margin - width : clientX + margin;
        const top = clientY + margin + height > innerHeight ? clientY - margin - height : clientY + margin;
        tooltip.style.left = `${Math.max(4, left)}px`;
        tooltip.style.top = `${Math.max(4, top)}px`;
    }

    // ---- chrome ----

    private installStyle(): void {
        if (this.doc.getElementById(STYLE_ID)) return;
        const style = this.doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLESHEET;
        (this.doc.head ?? this.doc.documentElement).appendChild(style);
    }

    private buildPanel(): void {
        const doc = this.doc;
        const panel = doc.createElement('div');
        panel.className = `${PREFIX}-panel`;

        const header = doc.createElement('div');
        header.className = `${PREFIX}-panel-header`;
        const title = doc.createElement('span');
        title.textContent = this.title;
        const close = doc.createElement('button');
        close.className = `${PREFIX}-close`;
        close.title = 'Hide visualization';
        close.textContent = '×';
        close.addEventListener('click', () => this.onClose());
        header.append(title, close);

        const modes = doc.createElement('div');
        modes.className = `${PREFIX}-modes`;
        modes.hidden = true;
        for (const entry of MODES) {
            const button = doc.createElement('button');
            button.dataset.mode = entry.mode;
            button.textContent = entry.label;
            button.addEventListener('click', () => this.showMode(entry.mode));
            modes.appendChild(button);
        }

        const status = doc.createElement('div');
        status.className = `${PREFIX}-status`;

        const details = doc.createElement('div');
        details.hidden = true;
        const legend = doc.createElement('div');
        legend.className = `${PREFIX}-legend`;
        const toggle = doc.createElement('label');
        toggle.className = `${PREFIX}-toggle`;
        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.addEventListener('change', () => {
            doc.documentElement.classList.toggle(HIDE_IDS_CLASS, !checkbox.checked);
        });
        toggle.append(checkbox, doc.createTextNode('Show ids'));

        details.append(legend, toggle);
        panel.append(header, modes, status, details);
        (doc.body ?? doc.documentElement).appendChild(panel);

        this.panel = panel;
        this.modesEl = modes;
        this.statusEl = status;
        this.detailsEl = details;
        this.legendEl = legend;
    }

    private renderLegend(): void {
        const legend = this.legendEl;
        if (!legend) return;
        legend.replaceChildren();
        for (const entry of LEGENDS[this.mode]) {
            const swatch = this.doc.createElement('div');
            swatch.className = `${PREFIX}-box`;
            swatch.dataset.kind = entry.kind;
            swatch.dataset.shade = '0';
            const label = this.doc.createElement('span');
            label.textContent = entry.label;
            legend.append(swatch, label);
        }
    }

    private buildTooltip(): void {
        const tooltip = this.doc.createElement('div');
        tooltip.className = `${PREFIX}-tooltip`;
        const title = this.doc.createElement('div');
        title.className = `${PREFIX}-tooltip-title`;
        const body = this.doc.createElement('pre');
        tooltip.append(title, body);
        (this.doc.body ?? this.doc.documentElement).appendChild(tooltip);
        this.tooltip = tooltip;
    }
}

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BEAVER_ACTIVE_ATTRIBUTE } from "../../../src/services/artifacts/tableDocument";
import {
    citationCardPosition,
    countCitationMarkers,
    enhanceTableDocument,
    isRoutedTableHref,
    type TableViewHost,
} from "../../../src/services/artifacts/view/enhanceTableDocument";

const doc = globalThis.document;

/** A host whose frame sits at a known place, with a recording `openLink`. */
function hostFor(
    mount: Element,
    frame = { left: 100, top: 50, right: 900, bottom: 650 },
): TableViewHost & { opened: string[] } {
    const opened: string[] = [];
    return {
        win: globalThis.window,
        cardMount: mount,
        frameRect: () => frame,
        openLink: (href: string) => {
            opened.push(href);
        },
        opened,
    };
}

function mount(html: string): { root: HTMLElement; card: HTMLElement } {
    doc.body.innerHTML = "";
    const root = doc.createElement("div");
    root.innerHTML = html;
    doc.body.appendChild(root);
    const card = doc.createElement("div");
    doc.body.appendChild(card);
    return { root, card };
}

function click(el: Element): MouseEvent {
    const event = new globalThis.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
    });
    el.dispatchEvent(event);
    return event;
}

describe("isRoutedTableHref", () => {
    it("routes the two schemes the renderer emits", () => {
        expect(isRoutedTableHref("https://example.org/a")).toBe(true);
        expect(isRoutedTableHref("zotero://select/library/items/ABCD1234")).toBe(true);
        expect(isRoutedTableHref("ZOTERO://open/library/items/ABCD1234?page=3")).toBe(true);
    });

    it("leaves everything else to the frame", () => {
        expect(isRoutedTableHref("#row-3")).toBe(false);
        expect(isRoutedTableHref("http://example.org")).toBe(false);
        expect(isRoutedTableHref("mailto:someone@example.org")).toBe(false);
        expect(isRoutedTableHref("javascript:void(0)")).toBe(false);
        expect(isRoutedTableHref("")).toBe(false);
    });
});

describe("citationCardPosition", () => {
    const frame = { left: 100, top: 50, right: 900, bottom: 650 };

    it("centres the card under the marker", () => {
        const at = { left: 300, bottom: 20, width: 10 };
        const { left, top } = citationCardPosition(frame, at, null, 200);
        // 100 + 300 + 5 - 100
        expect(left).toBe(305);
        // 50 + 20 + 6
        expect(top).toBe(76);
    });

    it("keeps the card inside the frame's left edge", () => {
        const at = { left: 0, bottom: 12, width: 8 };
        const { left } = citationCardPosition(frame, at, null, 200);
        expect(left).toBe(frame.left + 8);
    });

    it("keeps the card inside the frame's right edge", () => {
        const at = { left: 795, bottom: 12, width: 8 };
        const { left } = citationCardPosition(frame, at, null, 200);
        expect(left).toBe(frame.right - 200 - 8);
    });

    it("subtracts the offset parent, so the card lands where it is drawn", () => {
        const at = { left: 300, bottom: 20, width: 10 };
        const origin = { left: 40, top: 25 };
        const { left, top } = citationCardPosition(frame, at, origin, 200);
        expect(left).toBe(305 - 40);
        expect(top).toBe(76 - 25);
    });

    it("treats a card with no positioned ancestor as viewport-relative", () => {
        const at = { left: 300, bottom: 20, width: 10 };
        expect(citationCardPosition(frame, at, null, 200)).toEqual(
            citationCardPosition(frame, at, { left: 0, top: 0 }, 200),
        );
    });
});

describe("enhanceTableDocument link routing", () => {
    beforeEach(() => {
        doc.body.innerHTML = "";
    });

    it("hands an https link to the host instead of loading it in the frame", () => {
        const { card } = mount('<a id="x" href="https://example.org/a">a</a>');
        const host = hostFor(card);
        const dispose = enhanceTableDocument(doc, host);

        const event = click(doc.getElementById("x")!);

        expect(host.opened).toEqual(["https://example.org/a"]);
        expect(event.defaultPrevented).toBe(true);
        dispose();
    });

    it("hands a zotero link to the host", () => {
        const { card } = mount(
            '<a id="x" href="zotero://select/library/items/ABCD1234">a</a>',
        );
        const host = hostFor(card);
        const dispose = enhanceTableDocument(doc, host);

        const event = click(doc.getElementById("x")!);

        expect(host.opened).toEqual(["zotero://select/library/items/ABCD1234"]);
        expect(event.defaultPrevented).toBe(true);
        dispose();
    });

    it("routes a click on a marker inside the link, not only on the link", () => {
        const { card } = mount(
            '<a href="zotero://open/library/items/ABCD1234"><span id="x">1</span></a>',
        );
        const host = hostFor(card);
        const dispose = enhanceTableDocument(doc, host);

        click(doc.getElementById("x")!);

        expect(host.opened).toEqual(["zotero://open/library/items/ABCD1234"]);
        dispose();
    });

    it("leaves an href it does not route alone, but still shields the row", () => {
        const { card } = mount(
            '<details id="row"><summary><a id="x" href="#elsewhere">a</a></summary></details>',
        );
        const host = hostFor(card);
        const dispose = enhanceTableDocument(doc, host);
        const onRow = vi.fn();
        doc.getElementById("row")!.addEventListener("click", onRow);

        const event = click(doc.getElementById("x")!);

        expect(host.opened).toEqual([]);
        expect(event.defaultPrevented).toBe(false);
        // The cells live inside the `<summary>`; the click must not reach it.
        expect(onRow).not.toHaveBeenCalled();
        dispose();
    });

    it("ignores a click that is not on a link", () => {
        const { card } = mount('<div id="x">plain</div>');
        const host = hostFor(card);
        const dispose = enhanceTableDocument(doc, host);
        const onBody = vi.fn();
        doc.body.addEventListener("click", onBody);

        click(doc.getElementById("x")!);

        expect(host.opened).toEqual([]);
        expect(onBody).toHaveBeenCalledTimes(1);
        doc.body.removeEventListener("click", onBody);
        dispose();
    });

    it("stops routing once disposed", () => {
        const { card } = mount('<a id="x" href="https://example.org/a">a</a>');
        const host = hostFor(card);
        enhanceTableDocument(doc, host)();

        const event = click(doc.getElementById("x")!);

        expect(host.opened).toEqual([]);
        expect(event.defaultPrevented).toBe(false);
    });
});

describe("enhanceTableDocument plugin notice", () => {
    beforeEach(() => {
        doc.body.innerHTML = "";
        doc.documentElement.removeAttribute(BEAVER_ACTIVE_ATTRIBUTE);
    });

    it("marks the document, so the notice the file ships stands down", () => {
        const { card } = mount("<span></span>");
        const dispose = enhanceTableDocument(doc, hostFor(card));

        expect(doc.documentElement.hasAttribute(BEAVER_ACTIVE_ATTRIBUTE)).toBe(true);

        // The notice is only untrue while this view is attached.
        dispose();
        expect(doc.documentElement.hasAttribute(BEAVER_ACTIVE_ATTRIBUTE)).toBe(false);
    });
});

describe("enhanceTableDocument citation card", () => {
    const marker =
        '<span id="m" data-bt-cite="1" title="Smith 2020, p. 4" ' +
        'data-cite-name="Smith 2020" data-cite-loc="p. 4" ' +
        'data-cite-preview="The cited passage." data-cite-action="Open at page 4">1</span>';

    beforeEach(() => {
        doc.body.innerHTML = "";
    });

    it("draws the card in chrome, outside the cell that would clip it", () => {
        const { card } = mount(marker);
        const host = hostFor(card);
        const dispose = enhanceTableDocument(doc, host);

        doc.getElementById("m")!.dispatchEvent(
            new globalThis.MouseEvent("mouseover", { bubbles: true }),
        );

        const cardEl = card.lastElementChild as HTMLElement;
        expect(cardEl.style.display).toBe("block");
        expect(cardEl.textContent).toContain("Smith 2020");
        expect(cardEl.textContent).toContain("p. 4");
        expect(cardEl.textContent).toContain("The cited passage.");
        expect(cardEl.textContent).toContain("Open at page 4");
        dispose();
    });

    it("takes the native tooltip off the marker so it cannot sit over the card", () => {
        const { card } = mount(marker);
        const dispose = enhanceTableDocument(doc, hostFor(card));

        const el = doc.getElementById("m")!;
        el.dispatchEvent(new globalThis.MouseEvent("mouseover", { bubbles: true }));

        expect(el.hasAttribute("title")).toBe(false);
        expect(el.getAttribute("data-cite-title")).toBe("Smith 2020, p. 4");
        dispose();
    });

    it("hides the card when the pointer leaves the marker", () => {
        const { card } = mount(marker);
        const dispose = enhanceTableDocument(doc, hostFor(card));
        const el = doc.getElementById("m")!;

        el.dispatchEvent(new globalThis.MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new globalThis.MouseEvent("mouseout", { bubbles: true }));

        expect((card.lastElementChild as HTMLElement).style.display).toBe("none");
        dispose();
    });

    it("shows nothing for a marker that carries no citation", () => {
        const { card } = mount('<span id="m" data-bt-cite="1">1</span>');
        const dispose = enhanceTableDocument(doc, hostFor(card));

        doc.getElementById("m")!.dispatchEvent(
            new globalThis.MouseEvent("mouseover", { bubbles: true }),
        );

        const cardEl = card.lastElementChild as HTMLElement;
        expect(cardEl.style.display).not.toBe("block");
        expect(cardEl.textContent).toBe("");
        dispose();
    });

    it("takes the card away with the disposer", () => {
        const { card } = mount(marker);
        const before = card.childElementCount;
        enhanceTableDocument(doc, hostFor(card))();
        expect(card.childElementCount).toBe(before);
    });
});

describe("countCitationMarkers", () => {
    it("counts what the document marked", () => {
        doc.body.innerHTML =
            '<span data-bt-cite="1">1</span><a data-bt-cite="2" href="#">2</a><span>3</span>';
        expect(countCitationMarkers(doc)).toBe(2);
    });
});

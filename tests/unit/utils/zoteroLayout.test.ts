import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReaderPaneVisibility } from '../../../react/utils/zoteroLayout';

class TestStyle {
    display = '';
    pointerEvents = '';

    removeProperty(property: string): void {
        if (property === 'display') {
            this.display = '';
        }
        if (property === 'pointer-events') {
            this.pointerEvents = '';
        }
    }
}

class TestElement {
    id: string;
    children: TestElement[] = [];
    parentElement: TestElement | null = null;
    style = new TestStyle();

    constructor(id: string, display = '') {
        this.id = id;
        this.style.display = display;
    }

    appendChild(child: TestElement): void {
        if (child.parentElement) {
            child.parentElement.children = child.parentElement.children.filter(c => c !== child);
        }
        child.parentElement = this;
        this.children.push(child);
    }
}

class TestDocument {
    constructor(private roots: TestElement[]) {}

    getElementById(id: string): TestElement | null {
        const visit = (element: TestElement): TestElement | null => {
            if (element.id === id) return element;
            for (const child of element.children) {
                const found = visit(child);
                if (found) return found;
            }
            return null;
        };

        for (const root of this.roots) {
            const found = visit(root);
            if (found) return found;
        }
        return null;
    }
}

function setLayout(layout: string): void {
    vi.mocked(Zotero.Prefs.get).mockImplementation((pref: string) => (
        pref === 'layout' ? layout : undefined
    ));
}

function createWindow(root: TestElement): Window {
    return { document: new TestDocument([root]) } as unknown as Window;
}

describe('applyReaderPaneVisibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLayout('standard');
    });

    it('restores standard reader content when the Beaver pane has already been removed', () => {
        const ctxPane = new TestElement('zotero-context-pane');
        const deck = new TestElement('reader-deck', 'none');
        const sidenav = new TestElement('reader-sidenav', 'none');
        ctxPane.appendChild(deck);
        ctxPane.appendChild(sidenav);

        applyReaderPaneVisibility(createWindow(ctxPane), false);

        expect(deck.style.display).toBe('');
        expect(sidenav.style.display).toBe('');
    });

    it('restores stacked reader inner content when the Beaver pane has already been removed', () => {
        setLayout('stacked');
        const ctxPane = new TestElement('zotero-context-pane');
        const ctxInner = new TestElement('zotero-context-pane-inner');
        const deck = new TestElement('reader-deck', 'none');
        const sidenav = new TestElement('reader-sidenav', 'none');
        ctxPane.appendChild(ctxInner);
        ctxInner.appendChild(deck);
        ctxInner.appendChild(sidenav);

        applyReaderPaneVisibility(createWindow(ctxPane), false);

        expect(deck.style.display).toBe('');
        expect(sidenav.style.display).toBe('');
    });

    it('restores both possible reader parents when hiding an existing Beaver pane', () => {
        setLayout('standard');
        const ctxPane = new TestElement('zotero-context-pane');
        const standardContent = new TestElement('standard-reader-content', 'none');
        const ctxInner = new TestElement('zotero-context-pane-inner');
        const stackedContent = new TestElement('stacked-reader-content', 'none');
        const beaver = new TestElement('beaver-pane-reader');
        ctxPane.appendChild(standardContent);
        ctxPane.appendChild(ctxInner);
        ctxInner.appendChild(stackedContent);
        ctxPane.appendChild(beaver);

        applyReaderPaneVisibility(createWindow(ctxPane), false);

        expect(standardContent.style.display).toBe('');
        expect(stackedContent.style.display).toBe('');
        expect(beaver.style.display).toBe('none');
    });
});

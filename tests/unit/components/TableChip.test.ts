// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const mocks = vi.hoisted(() => ({ openTable: vi.fn() }));
vi.mock('@beaver/agent-ui/host', () => ({ getHost: () => ({ navigation: { openTable: mocks.openTable } }) }));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => null }));
vi.mock('../../../react/components/icons/icons', () => ({ Icon: () => null, CSSIcon: () => null, CSSItemTypeIcon: () => null, LibraryIcon: {}, NoteIcon: {}, HighlighterIcon: {}, ExternalLinkIcon: {}, TableIcon: {} }));
vi.mock('../../../react/components/icons/ZoteroIcon', () => ({ ZoteroIcon: () => null, ZOTERO_ICONS: {} }));
vi.mock('../../../react/utils/annotationDisplay', () => ({ ANNOTATION_ICON_BY_TYPE: {}, ANNOTATION_TEXT_BY_TYPE: {} }));
vi.mock('@beaver/agent-ui/chat/useItemContextMenu', () => ({ collectionMenuItems: () => [] }));
vi.mock('../../../react/hooks/useRemoveContextMenu', () => ({ useRemoveContextMenu: () => ({ isRemoveMenuOpen: false, contextMenuHandlers: {}, removeHandlers: {}, removeMenu: null }) }));
// The hover card renders its status into an attribute so the test can read it without hovering.
vi.mock('@beaver/agent-ui/chat/ChipPopup', () => ({
    ChipWithPopup: ({ children, popup }: any) => React.createElement('span', {
        'data-popup-status': popup.status?.label ?? '',
        'data-popup-action': popup.action?.label ?? '',
    }, children),
}));
vi.mock('../../../react/components/agentRuns/requestChips/ChipButton', () => ({ ChipButton: ({ children, ...props }: any) => React.createElement('button', props, children) }));
import { TableChip } from '../../../react/components/agentRuns/requestChips/RequestChipPrimitives';

function render(props: React.ComponentProps<typeof TableChip>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(TableChip, props)));
    return {
        button: container.querySelector('button')!,
        card: container.querySelector('[data-popup-status]')!,
    };
}

afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

it('marks a trashed table red and keeps its reason in the hover card, not beside the chip', () => {
    const { button, card } = render({ title: 'Evidence Table', tableKey: 'u-ABCDEFGH', unavailable: { reason: 'Table is in the trash.' } });
    expect(button.className).toContain('border-red');
    expect(button.querySelector('.truncate')!.className).toContain('font-color-red');
    expect(card.getAttribute('data-popup-status')).toBe('Table is in the trash.');
    expect(card.getAttribute('data-popup-action')).toBe('');
    expect(container.textContent).toBe('Evidence Table');
});

it('does not mark a table red when opening it downloads its files', () => {
    const reason = 'Table files are not on this device yet. Opening the table downloads them.';
    const { button, card } = render({ title: 'Evidence Table', tableKey: 'u-ABCDEFGH', unavailable: { reason, openable: true } });
    expect(button.className).not.toContain('border-red');
    expect(card.getAttribute('data-popup-status')).toBe(reason);
    expect(card.getAttribute('data-popup-action')).toBe('Open table');
});

it('shows download progress in the hover card and clears it when the table opens', async () => {
    let finish!: (value: unknown) => void;
    mocks.openTable.mockImplementation((_key: string, _win: unknown, options: { onDownload: () => void }) => {
        options.onDownload();
        return new Promise((resolve) => { finish = resolve; });
    });
    const { button, card } = render({ title: 'Evidence Table', tableKey: 'u-ABCDEFGH' });
    expect(button.className).not.toContain('border-red');
    act(() => button.click());
    expect(card.getAttribute('data-popup-status')).toBe('Downloading table…');
    expect(container.textContent).toBe('Evidence Table');
    await act(async () => { finish({ ok: true }); });
    expect(card.getAttribute('data-popup-status')).toBe('');
});

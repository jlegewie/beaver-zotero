/**
 * The run-scoped permission control on an approval card: what its rows say,
 * in which order, and where its footnote leads.
 */
import { describe, expect, it, vi } from 'vitest';

const openPreferencesWindow = vi.fn();
vi.mock('../../../src/ui/openPreferencesWindow', () => ({
    openPreferencesWindow: (...args: unknown[]) => openPreferencesWindow(...args),
}));

// The component is called as a plain function below, so its one hook has to
// work outside a React render: memoization is not what is under test.
vi.mock('react', async () => {
    const actual = await vi.importActual<any>('react');
    return { ...actual, useMemo: (factory: () => unknown) => factory() };
});

import React from 'react';
import PermissionMenu from '@beaver/agent-ui/primitives/PermissionMenu';
import RunPermissionButton, {
    FULL_ACCESS_DESCRIPTION,
    RUN_PERMISSION_FOOTNOTE_LINK,
    RUN_PERMISSION_OPTIONS,
    describeFullAccess,
} from '../../../react/components/ui/buttons/RunPermissionButton';

/** Render the component function once and return the PermissionMenu it produced. */
function renderMenu(props: Partial<React.ComponentProps<typeof RunPermissionButton>> = {}) {
    const element = (RunPermissionButton as React.FC<any>)({
        mode: 'ask',
        onChange: () => {},
        ...props,
    }) as React.ReactElement<any>;
    return element.props;
}

describe('RunPermissionButton', () => {
    it('lists the option that keeps asking before the grant', () => {
        expect(RUN_PERMISSION_OPTIONS.map((option) => option.value)).toEqual(['ask', 'full_access']);
    });

    it('says on the full-access row that deletions are included', () => {
        expect(FULL_ACCESS_DESCRIPTION).toMatch(/including deletions/);
    });

    it('states how many pending cards a switch answers only when there is more than one', () => {
        expect(describeFullAccess(0)).toBe(FULL_ACCESS_DESCRIPTION);
        expect(describeFullAccess(1)).toBe(FULL_ACCESS_DESCRIPTION);
        expect(describeFullAccess(3)).toMatch(/Approves the 3 pending changes now$/);
    });

    it('passes the counted description to the menu', () => {
        const props = renderMenu({ pendingCoveredCount: 4 });
        const fullAccess = props.options.find((option: any) => option.value === 'full_access');
        expect(fullAccess.description).toMatch(/4 pending/);
    });

    it('closes the menu before the footnote navigates', () => {
        const calls: string[] = [];
        const menuProps = renderMenu();
        // PermissionMenu hands MenuButton a footer renderer that takes the
        // menu's close; the link inside must close first, then navigate.
        const menuButton = (PermissionMenu as React.FC<any>)({
            ...menuProps,
            onFootnoteClick: () => calls.push('navigate'),
        }) as React.ReactElement<any>;
        const footer = menuButton.props.footer({ close: () => calls.push('close') });
        const link = React.Children.toArray(footer.props.children).find(
            (child) => React.isValidElement(child) && child.type === 'button',
        ) as React.ReactElement<any>;
        expect(link.props.children).toBe(RUN_PERMISSION_FOOTNOTE_LINK);
        link.props.onClick();
        expect(calls).toEqual(['close', 'navigate']);
    });

    it('opens the Permissions pane from the footnote', () => {
        const props = renderMenu();
        expect(props.footnote).toMatch(/Permissions/);
        expect(props.footnoteLink).toBe(RUN_PERMISSION_FOOTNOTE_LINK);
        props.onFootnoteClick();
        expect(openPreferencesWindow).toHaveBeenCalledWith('permissions');
    });
});

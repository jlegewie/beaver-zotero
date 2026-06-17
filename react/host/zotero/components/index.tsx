import React from 'react';
import type { ComponentsHost, ExternalReferenceActionsProps } from '../../types';
import ActionButtons from './ActionButtons';

/**
 * Zotero implementations of the host-provided, client-specific UI components.
 *
 * These render Zotero-coupled action UI (library imports, reveals, PDF opens)
 * that the shared render layer must not import directly. Shared dispatchers reach
 * them via `getHost().components?.…`. This slice grows as more agent-action /
 * mutation UIs move behind the host seam.
 */
export const zoteroComponents: ComponentsHost = {
    externalReferenceActions(props: ExternalReferenceActionsProps) {
        return <ActionButtons {...props} />;
    },
};

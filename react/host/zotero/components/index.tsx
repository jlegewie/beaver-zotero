import React from 'react';
import type {
    ComponentsHost,
    ExternalReferenceActionsProps,
    AgentActionInStreamProps,
    RequestSourcesMenuProps,
} from '@beaver/agent-ui/host/types';
import ActionButtons from './ActionButtons';
import { AgentActionInStream } from './AgentActionInStream';
import { AgentActionsReview } from './AgentActionsReview';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { CSSItemTypeIcon } from '../../../components/icons/zotero';
import { ZOTERO_ICONS, ZoteroIcon } from '../../../components/icons/ZoteroIcon';
import { RequestSourcesMenu } from '../../../components/ui/menus/RequestSourcesMenu';

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
    agentActionInStream(props: AgentActionInStreamProps) {
        return <AgentActionInStream {...props} />;
    },
    pendingActionsReview(props: { run: AgentRun }) {
        return <AgentActionsReview run={props.run} />;
    },
    itemTypeIcon({ itemType, className }: { itemType: string; className?: string }) {
        // Zotero's item-type glyphs are CSS icons keyed by the item type itself,
        // which is exactly the name the shared layer passes in.
        return <CSSItemTypeIcon className={className} itemType={itemType} />;
    },
    revealInLibraryIcon({ className }: { className?: string }) {
        return <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} className={className} />;
    },
    requestSourcesMenu(props: RequestSourcesMenuProps) {
        return <RequestSourcesMenu {...props} />;
    },
};

import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import { RepeatIcon, MoreHorizontalIcon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { copyToClipboard } from '../../utils/clipboard';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import Button from '@beaver/agent-ui/primitives/Button';
import CitedSourcesList from '@beaver/agent-ui/chat/CitedSourcesList';
import { renderToMarkdown, renderToHTML, preprocessNoteContent } from '../../utils/citationRenderers';
import CopyButton from '../ui/buttons/CopyButton';
import { citationMapAtom, citationsByRunIdAtom, citationKeyToMarkerAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { CitedSource, getCitationKey } from '@beaver/agent-core/types/citations';
import { messageSourcesVisibilityAtom, toggleMessageSourcesVisibilityAtom, setMessageSourcesVisibilityAtom } from '../../atoms/messageUIState';
import { allRunsAtom, mergeRunToolResults, resumeChainAtom } from '@beaver/agent-core/run-state/atoms';
import { sumChainUsage } from '@beaver/agent-core/run-state/runResumeHelpers';
import { extractRunResponseContent } from '../../utils/threadContent';
import { resolveToolCallLabelEnrichMap } from '../../utils/toolCallLabelEnrich';
import TokenUsageDisplay from './TokenUsageDisplay';
import { regenerateFromRunAtom, retryPendingRunIdAtom, streamingDoneRunIdsAtom } from '../../atoms/agentRunAtoms';
import { currentThreadIdAtom } from '../../atoms/threads';
import { store } from '../../store';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { prepareCitationRenderContext } from '../../utils/citationRenderContext';
import { addPopupMessageAtom } from '../../utils/popupMessageUtils';
import { getHost } from '@beaver/agent-ui/host';

interface AgentRunFooterProps {
    run: AgentRun;
}

/**
 * Footer component for agent runs.
 * Displays sources, share options, regenerate, and copy buttons.
 */
export const AgentRunFooter: React.FC<AgentRunFooterProps> = ({ run }) => {
    const citationDataMap = useAtomValue(citationMapAtom);
    const citationsByRunId = useAtomValue(citationsByRunIdAtom);
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);
    const citationMarkerMap = useAtomValue(citationKeyToMarkerAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    // A response that was continued after an error or an interruption spans
    // several runs but reads as one message, and only its last run carries a
    // footer. Everything below therefore describes the whole chain: its text,
    // its citations, its cost, and the question that started it. An ordinary
    // run is a chain of one, so nothing changes for it.
    const chainAtomValue = useAtomValue(useMemo(() => resumeChainAtom(run.id), [run.id]));
    // Empty only if this run has left the thread while its footer is still
    // mounted. The chain is always at least the run itself, and everything
    // below — `messageRun` in particular — relies on that.
    const chainRuns = useMemo(
        () => (chainAtomValue.length > 0 ? chainAtomValue : [run]),
        [chainAtomValue, run],
    );
    // Scoped to the chain rather than the thread: subscribing to every run's
    // tool results would re-render this footer on every frame of a later run's
    // response.
    const toolResultsMap = useMemo(() => mergeRunToolResults(chainRuns), [chainRuns]);
    // Where the message began: a continuation's own prompt is empty, and it is
    // the opening run that a link or an id should point at.
    const messageRun = chainRuns[0];
    const runCitations = useMemo(
        () => chainRuns.flatMap(chainRun => citationsByRunId[chainRun.id] || []),
        [chainRuns, citationsByRunId],
    );

    // Force re-render when menu opens to get fresh context for disabled state
    const [, forceUpdate] = useState({});
    
    const handleMenuToggle = useCallback((isOpen: boolean) => {
        if (isOpen) forceUpdate({});
    }, []);

    // Get unique citations for this run with their thread-scoped markers.
    // Citations render directly from metadata (citation v2) — no enrichment.
    const uniqueCitations = useMemo(() => {
        const seen = new Set<string>();
        const unique: CitedSource[] = [];

        for (const citation of runCitations) {
            if (citation.invalid) continue;
            const key = getCitationKey(citation);
            if (!seen.has(key)) {
                seen.add(key);
                unique.push({
                    ...citation,
                    numericCitation: citationMarkerMap[key] || null,
                });
            }
        }

        return unique;
    }, [runCitations, citationMarkerMap]);

    // Sources visibility state
    const sourcesVisibilityMap = useAtomValue(messageSourcesVisibilityAtom);
    const sourcesVisible = sourcesVisibilityMap[run.id] ?? false;
    const toggleSourcesVisibility = useSetAtom(toggleMessageSourcesVisibilityAtom);
    const setSourcesVisibility = useSetAtom(setMessageSourcesVisibilityAtom);

    // Toggle sources visibility
    const toggleSources = () => {
        toggleSourcesVisibility(run.id);
    };

    // Auto-hide sources if no citations
    useEffect(() => {
        if (uniqueCitations.length === 0 && sourcesVisible) {
            setSourcesVisibility({ messageId: run.id, visible: false });
        }
    }, [run.id, setSourcesVisibility, sourcesVisible, uniqueCitations.length]);

    // Combine all text content from the message's runs, in the order they ran.
    // Resolved lazily (copy / save-as-note), because tool-call labels need
    // host-resolved library/collection names — without them a list_* label
    // shows the raw library ref ("u") instead of the library name.
    const buildRunContent = useCallback(async () => {
        const enrichMap = await resolveToolCallLabelEnrichMap(chainRuns, toolResultsMap);
        return chainRuns
            .map(chainRun => extractRunResponseContent(chainRun, toolResultsMap, enrichMap))
            .filter(Boolean)
            .join('\n\n');
    }, [chainRuns, toolResultsMap]);

    // What the whole message cost, not just its final run
    const { usage: chainUsage, cost: chainCost } = useMemo(
        () => sumChainUsage(chainRuns),
        [chainRuns],
    );

    // Build share menu items
    const getShareMenuItems = () => {
        const host = getHost();
        const noteWriter = host.noteWriter;
        const hasParent = noteWriter?.canSaveAsChildNote() ?? false;

        const items: MenuItem[] = [
            {
                label: 'Copy',
                onClick: () => handleCopy()
            },
            {
                label: 'Copy link to message',
                onClick: () => copyRunUrl()
            },
            {
                label: 'Copy message ID',
                onClick: () => copyRunId()
            }
        ];

        if (noteWriter) {
            items.splice(1, 0,
                {
                    label: 'Save as note',
                    onClick: () => saveToLibrary(),
                    disabled: isResolvingCitations
                },
                {
                    label: 'Save as child note',
                    onClick: () => saveToItem(),
                    disabled: !hasParent || isResolvingCitations
                },
            );
        }

        if (host.config?.isDevelopment() ?? false) {
            items.push({
                label: 'Copy chat ID',
                onClick: () => copyThreadId()
            });
            items.push({
                label: 'Copy citation metadata',
                onClick: () => copyCitationMetadata()
            });
        }

        return items;
    };

    const handleCopy = async () => {
        const formattedContent = renderToMarkdown(await buildRunContent());
        await copyToClipboard(formattedContent);
    };

    const buildRunNoteContentHtml = async () => {
        const userQuestion = messageRun.user_prompt.content;
        const sections: string[] = [];
        if (userQuestion) {
            sections.push(`## User\n\n> ${userQuestion.replace(/\n/g, '\n> ')}`);
        }
        sections.push(`## Beaver\n\n${await buildRunContent()}`);
        const noteMarkdown = sections.join('\n\n---\n\n');

        const renderContent = preprocessNoteContent(noteMarkdown);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        return renderToHTML(renderContent, "markdown", renderContextData);
    };

    /**
     * Render the run as a Zotero note and persist it through the host.
     * When `asChild` is true the note is saved under the current parent item
     * (which must exist); otherwise it is saved standalone to the current
     * library/collection. Surfaces save failures (e.g. read-only library) as a
     * popup since the share menu is fire-and-forget.
     */
    const saveRunNote = async (asChild: boolean) => {
        const noteWriter = getHost().noteWriter;
        if (!noteWriter) return;
        try {
            // Read before the render below is awaited, not after. Rendering the
            // citations yields, and the reader can open another thread while it
            // does — leaving this looking for a run of the thread they left in
            // the runs of the one they opened, finding nothing, and titling the
            // note as though it had no place in a conversation.
            const responseIndex = store.get(allRunsAtom).findIndex((candidate: AgentRun) => candidate.id === messageRun.id) + 1;
            const contentHtml = await buildRunNoteContentHtml();
            await noteWriter.saveNote({
                contentHtml,
                asChild,
                requireParent: asChild,
                format: {
                    kind: 'agent-run',
                    responseIndex: responseIndex || undefined,
                    runId: messageRun.id,
                },
            });
        } catch (error: any) {
            addPopupMessage({
                type: 'error',
                title: 'Could not save note',
                text: error?.message || 'Failed to save note.',
            });
        }
    };

    /** Save as standalone note to current library/collection. */
    const saveToLibrary = () => saveRunNote(false);

    /** Save as child note attached to selected/current item. */
    const saveToItem = () => saveRunNote(true);

    const copyRunUrl = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;
        await copyToClipboard(`zotero://beaver/thread/${threadId}/run/${messageRun.id}`);
    };

    const copyRunId = async () => {
        await copyToClipboard(messageRun.id);
    };

    const copyCitationMetadata = async () => {
        await copyToClipboard(JSON.stringify(runCitations, null, 2));
    };

    const copyThreadId = async () => {
        await copyToClipboard(store.get(currentThreadIdAtom ) || '');
    };

    const regenerateFromRun = useSetAtom(regenerateFromRunAtom);
    // Loading state while this run's retry commits its removal on the
    // backend (truncate POST + undo), before the replacement run appears.
    const isRetryPending = useAtomValue(retryPendingRunIdAtom) === run.id;

    const handleRegenerate = async () => {
        // regenerateFromRunAtom walks the resume chain back to the root
        // internally, so we can pass the clicked run's id directly.
        await regenerateFromRun(run.id);
    };

    // Hide during streaming (but show during post-processing when citations are resolving)
    const streamingDoneRunIds = useAtomValue(streamingDoneRunIdsAtom);
    const isResolvingCitations = streamingDoneRunIds.has(run.id);
    const isStreaming = run.status === 'in_progress' && !isResolvingCitations;

    return (
        <div className="px-4">
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-2
                    ${isStreaming ? 'hidden' : ''}
                `}
            >
                {/* Sources button or resolving spinner */}
                <div className="flex-1">
                    {isResolvingCitations && uniqueCitations.length === 0 ? (
                        <div className="display-flex items-center gap-2 font-color-secondary">
                            <Spinner size={12} />
                            <span className="text-sm font-color-secondary">Linking sources...</span>
                        </div>
                    ) : uniqueCitations.length > 0 ? (
                        <Button
                            variant="ghost"
                            onClick={toggleSources}
                            icon={sourcesVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12 -ml-1"
                        >
                            <span>
                                {uniqueCitations.length} Source{uniqueCitations.length === 1 ? '' : 's'}
                            </span>
                        </Button>
                    ) : null}
                </div>
                
                {/* Action buttons */}
                <div className="display-flex gap-4">
                    {/* Additional action buttons */}
                    <MenuButton
                        icon={MoreHorizontalIcon}
                        iconClassName="scale-12"
                        menuItems={getShareMenuItems()}
                        className="scale-11"
                        ariaLabel="Share"
                        variant="ghost"
                        positionAdjustment={{ x: 0, y: 0 }}
                        toggleCallback={handleMenuToggle}
                        tooltipContent="More options"
                    />

                    {/* Usage display */}
                    {(getHost().config?.isDevelopment() ?? false) && run.status === 'completed' && chainUsage != null && chainCost != null && (
                        <TokenUsageDisplay usage={chainUsage} cost={chainCost} />
                    )}

                    {/* Retry button */}
                    <Tooltip
                        content="Retry"
                        showArrow
                    >
                        <IconButton
                            icon={RepeatIcon}
                            onClick={handleRegenerate}
                            className="scale-11"
                            ariaLabel="Retry"
                            loading={isRetryPending}
                        />
                    </Tooltip>

                    {/* Copy button */}
                    <Tooltip
                        content="Copy"
                        showArrow
                    >
                        <CopyButton
                            content={buildRunContent}
                            formatContent={renderToMarkdown}
                            className="scale-11"
                        />
                    </Tooltip>
                </div>
            </div>

            {/* Sources section */}
            {sourcesVisible && (
                <CitedSourcesList citations={uniqueCitations} />
            )}
        </div>
    );
};

export default AgentRunFooter;

import React, { useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { resumeChainAtom, allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Button from '@beaver/agent-ui/primitives/Button';
import { getHost } from '@beaver/agent-ui/host';
import type { FileExportContent } from '@beaver/agent-ui/host/types';
import { CancelIcon } from '../icons/icons';
import { exportContentChoiceAtom, exportDialogRunIdAtom } from '../../atoms/ui';
import { addPopupMessageAtom } from '../../utils/popupMessageUtils';

const CONTENT_OPTIONS: Array<{ value: FileExportContent; label: string; description: string }> = [
    {
        value: 'final',
        label: 'Final answer',
        description: 'Only the answer Beaver gave after it finished searching and reading.',
    },
    {
        value: 'full',
        label: 'Full response',
        description: 'Everything Beaver wrote, with each search and read it ran.',
    },
];

/**
 * Options for exporting a response to Word. The export itself (save dialog,
 * citation formatting, writing the file) runs through the host's document
 * export slice once the user confirms.
 */
const ExportResponseDialog: React.FC = () => {
    const [runId, setRunId] = useAtom(exportDialogRunIdAtom);
    const [content, setContent] = useAtom(exportContentChoiceAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const chainAtom = useMemo(() => resumeChainAtom(runId ?? ''), [runId]);
    const chain = useAtomValue(chainAtom);
    const allRuns = useAtomValue(allRunsAtom);

    const close = () => setRunId(null);

    const handleExport = async () => {
        const documentExport = getHost().documentExport;
        // The chain is empty only if the run left the thread while the dialog was open.
        const runs = chain.length > 0 ? chain : allRuns.filter(run => run.id === runId);
        close();
        if (!documentExport?.exportResponseToFile || runs.length === 0) return;
        try {
            const result = await documentExport.exportResponseToFile({ runs, format: 'docx', content });
            if (result.status !== 'saved') return;
            const reveal = documentExport.revealExportedFile;
            addPopupMessage({
                type: 'info',
                title: 'Exported to Word',
                text: [result.fileName, ...result.warnings].join(' — '),
                ...(reveal ? { button: { text: 'Show File', onClick: () => reveal(result.path) } } : {}),
            });
        } catch (error: any) {
            addPopupMessage({
                type: 'error',
                title: 'Could not export',
                text: error?.message || 'Failed to export the response.',
            });
        }
    };

    return (
        <div
            className="bg-sidepane border-popup rounded-lg shadow-lg mx-3 w-full pointer-events-auto"
            style={{
                background: 'var(--material-mix-quarternary)',
                border: '1px solid var(--fill-quinary)',
                borderRadius: '8px',
            }}
            role="dialog"
            aria-label="Export to Word"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="display-flex flex-row items-center justify-between p-4 pb-3">
                <div className="text-lg font-semibold">Export to Word</div>
                <IconButton icon={CancelIcon} onClick={close} className="scale-12" ariaLabel="Close dialog" />
            </div>

            <div className="px-4 pb-4 display-flex flex-col gap-4">
                <div className="display-flex flex-col gap-3" role="radiogroup" aria-label="Content">
                    {CONTENT_OPTIONS.map(option => (
                        <label key={option.value} className="display-flex flex-row items-start gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="beaver-export-content"
                                value={option.value}
                                checked={content === option.value}
                                onChange={() => setContent(option.value)}
                                style={{ marginTop: '3px' }}
                            />
                            <div className="display-flex flex-col gap-05">
                                <span className="font-color-primary">{option.label}</span>
                                <span className="text-sm font-color-secondary">{option.description}</span>
                            </div>
                        </label>
                    ))}
                </div>

                <div className="text-sm font-color-secondary">
                    Citations use your citation style setting and stay linked to Zotero, so the Zotero Word plugin can update them.
                </div>

                <div className="display-flex flex-row gap-4 justify-end">
                    <Button variant="outline" onClick={close}>Cancel</Button>
                    <Button variant="solid" onClick={handleExport}>Export…</Button>
                </div>
            </div>
        </div>
    );
};

export default ExportResponseDialog;

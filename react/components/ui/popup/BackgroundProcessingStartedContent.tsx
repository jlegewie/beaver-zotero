import React from 'react';
import { useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import PlayIcon from '@beaver/agent-ui/icons/PlayIcon';
import { removeFloatingPopupMessageAtom } from '../../../atoms/floatingPopup';
import { openPreferencesWindow } from '../../../ui/openPreferencesWindow';
import { CloudFeaturesHeader } from '../../cloudFeatures/cloudFeatures';

/**
 * Follow-up shown once cloud consent is accepted. Explains the idle-time
 * schedule and offers to start processing right away instead of waiting.
 */
export default function BackgroundProcessingStartedContent(props: {
    messageId: string;
    eyebrow: string;
}): React.ReactElement {
    const remove = useSetAtom(removeFloatingPopupMessageAtom);
    const dismiss = () => remove(props.messageId);
    const startNow = () => {
        // Consent has just queued a library scan; the drain request survives
        // that discovery, so the queue runs as soon as it is filled.
        Zotero.Beaver?.processingReconciler?.notify();
        Zotero.Beaver?.backgroundExtractor?.requestImmediateDrain();
        dismiss();
    };
    const showPreferences = () => {
        openPreferencesWindow('sync');
        dismiss();
    };

    return (
        <div className="display-flex flex-col gap-4 w-full">
            <CloudFeaturesHeader eyebrow={props.eyebrow} title="Beaver will prepare your library" />
            <div className="font-color-secondary text-base">
                Files are processed in the background once your computer has been idle for 30 seconds.
                Large libraries can take a while, so you can also start right away.
            </div>
            <div
                className="display-flex flex-row items-center justify-between pt-2"
            >
                <a
                    href="#"
                    className="text-link text-base"
                    onClick={(event) => {
                        event.preventDefault();
                        showPreferences();
                    }}
                >
                    Track progress
                </a>
                <div className="display-flex flex-row gap-2">
                    <Button variant="outline" onClick={dismiss}>
                        Wait for idle
                    </Button>
                    <Button variant="solid" rightIcon={PlayIcon} onClick={startNow}>
                        Start now
                    </Button>
                </div>
            </div>
        </div>
    );
}

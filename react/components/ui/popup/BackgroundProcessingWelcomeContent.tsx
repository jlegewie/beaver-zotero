import React from 'react';
import { useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { removeFloatingPopupMessageAtom } from '../../../atoms/floatingPopup';
import { openPreferencesWindow } from '../../../ui/openPreferencesWindow';

export default function BackgroundProcessingWelcomeContent(props: {
    messageId: string;
    reminder: boolean;
    generation: number;
}): React.ReactElement {
    const remove = useSetAtom(removeFloatingPopupMessageAtom);
    const dismiss = () => remove(props.messageId);
    const enable = () => {
        Zotero.Beaver?.account?.setCloudConsent(true, props.generation);
        dismiss();
    };
    const later = () => {
        Zotero.Beaver?.account?.setCloudConsent(false, props.generation);
        dismiss();
    };
    const chooseLibraries = () => {
        Zotero.Beaver?.account?.setCloudConsent(false, props.generation);
        openPreferencesWindow('sync');
        dismiss();
    };

    return (
        <div className="display-flex flex-col gap-3">
            <div className="font-color-secondary text-base">
                Cloud preparation uploads scanned PDFs for OCR and extracted attachment text for search when those features are available. It covers included libraries on this computer and uses your remote-file permission. Background processing is required while either feature is active. It runs after 30 seconds idle; Start now and Stop control immediate processing. You can exclude libraries in Preferences.

            </div>
            <div className="display-flex flex-row gap-2 justify-end flex-wrap">
                {!props.reminder && (
                    <Button variant="ghost" onClick={chooseLibraries}>Choose libraries…</Button>
                )}
                <Button variant="outline" onClick={later}>
                    Not now
                </Button>
                <Button variant="solid" onClick={enable}>
                    Accept and enable
                </Button>
            </div>
        </div>
    );
}

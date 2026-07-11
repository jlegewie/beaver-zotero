import React from 'react';
import { useSetAtom } from 'jotai';
import Button from '../Button';
import { removeFloatingPopupMessageAtom } from '../../../atoms/floatingPopup';
import { setPref } from '../../../../src/utils/prefs';
import { openPreferencesWindow } from '../../../../src/ui/openPreferencesWindow';

export default function BackgroundProcessingWelcomeContent(props: {
    messageId: string;
    title: string;
    reminder: boolean;
}): React.ReactElement {
    const remove = useSetAtom(removeFloatingPopupMessageAtom);
    const dismiss = () => remove(props.messageId);
    const enable = () => {
        setPref('backgroundProcessingEnabled', true);
        setPref('backgroundProcessingWelcomeAck', true);
        Zotero.Beaver?.processingReconciler?.notify();
        void Zotero.Beaver?.processingReconciler?.reconcileNow();
        Zotero.Beaver?.backgroundExtractor?.notify();
        dismiss();
    };
    const later = () => {
        if (props.reminder) {
            setPref('backgroundProcessingWelcomeAck', true);
        } else {
            setPref('backgroundProcessingWelcomeDeferred', true);
        }
        dismiss();
    };
    const chooseLibraries = () => {
        setPref('backgroundProcessingWelcomeDeferred', true);
        openPreferencesWindow('sync');
        dismiss();
    };

    return (
        <div className="display-flex flex-col gap-3">
            <div className="font-color-primary text-lg font-semibold">{props.title}</div>
            <div className="font-color-secondary text-base">
                {props.reminder
                    ? 'Background processing keeps the document search features available to you up to date. You can turn it on whenever you are ready.'
                    : 'To get started, turn on background processing. Beaver will extract your readable attachments and keep entitled OCR and search coverage current.'}
            </div>
            <div className="display-flex flex-row gap-2 justify-end flex-wrap">
                {!props.reminder && (
                    <Button variant="ghost" onClick={chooseLibraries}>Choose libraries…</Button>
                )}
                <Button variant="outline" onClick={later}>
                    {props.reminder ? 'Keep off' : 'Later'}
                </Button>
                <Button variant="solid" onClick={enable}>
                    {props.reminder ? 'Turn on' : 'Enable & run now'}
                </Button>
            </div>
        </div>
    );
}

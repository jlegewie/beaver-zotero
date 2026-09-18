import React from 'react';
import { useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { addFloatingPopupMessageAtom, removeFloatingPopupMessageAtom } from '../../../atoms/floatingPopup';
import BackgroundProcessingStartedContent from './BackgroundProcessingStartedContent';
import {
    CLOUD_FEATURES_TITLE,
    CloudFeatureList,
    CloudFeaturesHeader,
    cloudFeaturesDisclosure,
} from '../../cloudFeatures/cloudFeatures';

const STARTED_POPUP_ID = 'background-processing-started';

/**
 * Cloud consent popup. One acceptance covers both cloud features (OCR uploads
 * and the full-text search index), so both are always advertised even when the
 * account currently has access to only one. The disclosure names what leaves
 * the computer before the user is asked to turn the features on. Accepting
 * replaces the card with a follow-up that explains the idle-time schedule.
 */
export default function BackgroundProcessingWelcomeContent(props: {
    messageId: string;
    productName: string;
    beta: boolean;
    generation: number;
}): React.ReactElement {
    const remove = useSetAtom(removeFloatingPopupMessageAtom);
    const add = useSetAtom(addFloatingPopupMessageAtom);
    const eyebrow = props.beta ? `${props.productName} Beta` : props.productName;
    const dismiss = () => remove(props.messageId);
    const enable = () => {
        Zotero.Beaver?.account?.setCloudConsent(true, props.generation);
        dismiss();
        add({
            id: STARTED_POPUP_ID,
            type: 'cloud_consent',
            title: 'Beaver will prepare your library',
            expire: false,
            cancelable: false,
            customContent: <BackgroundProcessingStartedContent messageId={STARTED_POPUP_ID} eyebrow={eyebrow} />,
        });
    };
    const later = () => {
        Zotero.Beaver?.account?.setCloudConsent(false, props.generation);
        dismiss();
    };

    return (
        <div className="display-flex flex-col gap-4 w-full">
            <CloudFeaturesHeader eyebrow={eyebrow} title={CLOUD_FEATURES_TITLE} />
            <div className="font-color-secondary text-base">{cloudFeaturesDisclosure(props.productName)}</div>
            <CloudFeatureList />
            <div className="display-flex flex-row gap-2 justify-end flex-wrap pt-2">
                <Button variant="outline" onClick={later}>
                    Not now
                </Button>
                <Button variant="solid" onClick={enable}>
                    Accept and turn on
                </Button>
            </div>
        </div>
    );
}

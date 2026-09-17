import React from 'react';
import { useAtomValue } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import {
    accountGenerationAtom,
    cloudBetaAtom,
    cloudConsentAtom,
    cloudProductNameAtom,
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
} from '../../atoms/profile';
import {
    CLOUD_FEATURES_TITLE,
    CloudFeatureList,
    CloudFeaturesHeader,
    cloudFeaturesDisclosure,
} from '../cloudFeatures/cloudFeatures';

/**
 * Banner at the top of Search & Files while cloud consent is outstanding: the
 * same pitch and disclosure as the welcome popup, for users who clicked
 * "Not now" there or never saw it. Gone once consent is accepted.
 */
export default function CloudFeaturesBanner(): React.ReactElement | null {
    const consent = useAtomValue(cloudConsentAtom);
    const generation = useAtomValue(accountGenerationAtom);
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const productName = useAtomValue(cloudProductNameAtom);
    const beta = useAtomValue(cloudBetaAtom);
    if ((!hasOcrAccess && !hasSearchAccess) || consent === 'accepted') return null;

    const eyebrow = beta ? `${productName} Beta` : productName;
    return (
        <div
            className="display-flex flex-col gap-3 rounded-card border-card"
            style={{ padding: '12px 14px', marginTop: '20px' }}
        >
            <CloudFeaturesHeader eyebrow={eyebrow} title={CLOUD_FEATURES_TITLE} titleClassName="text-lg" />
            <div className="font-color-secondary text-base">{cloudFeaturesDisclosure(productName)}</div>
            <CloudFeatureList />
            <div className="display-flex flex-row gap-2 justify-end flex-wrap">
                {consent === 'pending' && (
                    <Button variant="outline" onClick={() => Zotero.Beaver?.account?.setCloudConsent(false, generation)}>
                        Not now
                    </Button>
                )}
                <Button variant="solid" onClick={() => Zotero.Beaver?.account?.setCloudConsent(true, generation)}>
                    Accept and turn on
                </Button>
            </div>
        </div>
    );
}

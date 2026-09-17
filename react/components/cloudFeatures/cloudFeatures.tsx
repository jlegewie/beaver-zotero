import React from 'react';
import { Icon, PdfIcon, BookSearchIcon } from '../icons/icons';

/**
 * Copy shared by every surface that asks for cloud consent (the welcome popup
 * and the Search & Files banner), so the two never drift apart.
 */
export const CLOUD_FEATURES = [
    {
        icon: BookSearchIcon,
        title: 'Search inside every PDF and EPUB',
        description: 'Full-text search finds passages across your whole library.',
    },
    {
        icon: PdfIcon,
        title: 'Read scanned PDFs',
        description: 'OCR makes scans and image-only PDFs readable, so Beaver can quote and cite them.',
    },
];

export const CLOUD_FEATURES_TITLE = 'Full-text search and OCR';

/** The disclosure sentence: what leaves the computer once consent is given. */
export function cloudFeaturesDisclosure(productName: string): string {
    return `${productName} supports full-text search across every PDF and OCR for scanned PDFs. `
        + 'Both run in the cloud, so Beaver uploads scanned PDFs and extracted attachment text from all attachments.';
}

/** Small uppercase plan eyebrow above a large title. */
export function CloudFeaturesHeader(props: { eyebrow: string; title: string; titleClassName?: string }): React.ReactElement {
    return (
        <div className="display-flex flex-col gap-05 w-full">
            <span className="text-base font-medium font-color-secondary">
                {props.eyebrow}
            </span>
            <div className={`font-color-primary font-semibold ${props.titleClassName ?? 'text-xl'}`}>{props.title}</div>
        </div>
    );
}

/** The two feature rows, one tinted card each. */
export function CloudFeatureList(): React.ReactElement {
    return (
        <div className="display-flex flex-col gap-2">
            {CLOUD_FEATURES.map((feature) => (
                <div
                    key={feature.title}
                    className="display-flex flex-row gap-3 items-start p-2"
                    style={{ background: 'var(--fill-senary)', borderRadius: '6px' }}
                >
                    <div className="flex-shrink-0 mt-020">
                        <Icon icon={feature.icon} className="scale-12 font-color-secondary" />
                    </div>
                    <div className="display-flex flex-col gap-0">
                        <span className="font-color-primary text-base font-medium">{feature.title}</span>
                        <span className="font-color-secondary text-sm">{feature.description}</span>
                    </div>
                </div>
            ))}
        </div>
    );
}

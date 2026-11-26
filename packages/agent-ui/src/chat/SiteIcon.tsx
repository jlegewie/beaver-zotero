import React from 'react';
import { siteIconSrc } from '@beaver/agent-core/identity/webPages';
import { GlobeIcon, Icon, PdfIcon } from '../icons';

interface SiteIconProps {
    /** The site's icon as an inline image; anything else (a URL above all) is not loaded. */
    icon?: string | null;
    /** Shown as a PDF glyph when the site has no icon. */
    isPdf?: boolean;
    /** The icon's size in px; the slot is 2 px wider, the tile's padding. */
    size?: number;
}

/**
 * A web page's site: its own icon, or a globe (PDF) glyph when it has none.
 *
 * The icon sits on a tile that turns white in dark mode (`.site-icon-tile`), so
 * a dark logo stays visible. The glyph takes the same width, so titles beside
 * either line up. The icon's `<img>` keeps a transparent background: web page
 * previews render inside the chat's Markdown, whose images get a fill.
 */
export const SiteIcon: React.FC<SiteIconProps> = ({ icon, isPdf = false, size = 16 }) => {
    const src = siteIconSrc(icon);
    if (src) {
        return (
            <span className="site-icon-tile">
                <img src={src} alt="" width={size} height={size} style={{ display: 'block', objectFit: 'contain', backgroundColor: 'transparent' }} />
            </span>
        );
    }
    return (
        <span className="display-flex items-center" style={{ width: size + 2, justifyContent: 'center', flexShrink: 0 }}>
            <Icon icon={isPdf ? PdfIcon : GlobeIcon} className="font-color-secondary" />
        </span>
    );
};

export default SiteIcon;

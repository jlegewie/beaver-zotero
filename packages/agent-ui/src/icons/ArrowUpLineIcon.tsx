import React from "react";

type ArrowUpLineIconProps = React.SVGProps<SVGSVGElement>;

/**
 * A full upward arrow — shaft and head. Distinct from `ArrowUpIcon`, which is
 * a chevron with no shaft and reads as "collapse" rather than "send".
 */
const ArrowUpLineIcon: React.FC<ArrowUpLineIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color={"currentColor"} fill={"none"} {...props}>
        <path d="M12 18.75V6.25" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M6.5 11.75L12 6.25L17.5 11.75" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export default ArrowUpLineIcon;

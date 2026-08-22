import React from "react";

type SortIconProps = React.SVGProps<SVGSVGElement>;

/**
 * The "this column can be sorted" affordance: a chevron pair, shown only while
 * a header is hovered so a resting table has no repeated chrome. The single
 * direction arrows (`ArrowUpIcon` / `ArrowDownIcon`) mark the active sort.
 */
const SortIcon: React.FC<SortIconProps> = (props) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={24}
        height={24}
        fill={"none"}
        {...props}
    >
        <path
            d="M8 10L12 6L16 10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <path
            d="M8 14L12 18L16 14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

export default SortIcon;

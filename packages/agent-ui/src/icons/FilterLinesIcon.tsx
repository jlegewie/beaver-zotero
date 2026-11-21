import React from "react";

type FilterLinesIconProps = React.SVGProps<SVGSVGElement>;

/** Three centered lines, long to short: the query and filters behind a search. */
const FilterLinesIcon: React.FC<FilterLinesIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" {...props}>
        <path d="M3 5.5H21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M6 12H18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M9.5 18.5H14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
);

export default FilterLinesIcon;

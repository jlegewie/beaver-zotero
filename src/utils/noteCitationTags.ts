/** Fresh scanner for self-closing note citation tags, including slashes in attribute values. */
export function noteCitationTagPattern(): RegExp {
    return /<citation\s+([^>]*?)\s*\/>/g;
}

/** Validate the JSON Schema subset used by these tools, including direct HTTP calls. */
export function validateInput(
    value: any,
    schema: any,
    path = 'arguments',
): void {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type: string) =>
        type === 'integer'
            ? Number.isSafeInteger(value)
            : type === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : type === 'array'
                ? Array.isArray(value)
                : type === 'object'
                  ? value !== null &&
                    typeof value === 'object' &&
                    !Array.isArray(value)
                  : typeof value === type,
    );
    if (schema.type && !matches)
        throw new Error(`${path} must be ${types.join(' or ')}.`);
    if (schema.enum && !schema.enum.includes(value))
        throw new Error(`${path} must be one of: ${schema.enum.join(', ')}.`);
    if (
        typeof value === 'number' &&
        (value < (schema.minimum ?? -Infinity) ||
            value > (schema.maximum ?? Infinity))
    ) {
        throw new Error(
            `${path} is outside the allowed range (${schema.minimum ?? '-infinity'}–${schema.maximum ?? 'infinity'}).`,
        );
    }
    if (
        typeof value === 'string' &&
        schema.minLength &&
        value.trim().length < schema.minLength
    )
        throw new Error(`${path} cannot be empty.`);
    if (Array.isArray(value)) {
        if (
            value.length < (schema.minItems ?? 0) ||
            value.length > (schema.maxItems ?? Infinity)
        )
            throw new Error(`${path} has an invalid number of items.`);
        if (schema.items)
            value.forEach((item, index) =>
                validateInput(item, schema.items, `${path}[${index}]`),
            );
    } else if (value !== null && typeof value === 'object') {
        for (const key of schema.required ?? [])
            if (!(key in value)) throw new Error(`${path}.${key} is required.`);
        for (const [key, item] of Object.entries(value)) {
            if (
                !Object.prototype.hasOwnProperty.call(
                    schema.properties ?? {},
                    key,
                )
            ) {
                if (schema.additionalProperties === false)
                    throw new Error(`Unknown argument: ${path}.${key}.`);
                continue;
            }
            validateInput(item, schema.properties[key], `${path}.${key}`);
        }
    }
}

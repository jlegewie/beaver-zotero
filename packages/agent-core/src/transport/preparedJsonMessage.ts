/**
 * Prepared JSON WebSocket message with one or more pre-serialized fields.
 *
 * This lets hot paths splice a large JSON value into a small response envelope
 * without parsing it back into an object or stringifying it again.
 */

const PREPARED_JSON_MESSAGE = Symbol('beaver.preparedJsonMessage');

export interface PreparedJsonMessage {
    readonly [PREPARED_JSON_MESSAGE]: true;
    readonly envelope: Record<string, any>;
    readonly rawFields: Record<string, string>;
}

export function createPreparedJsonMessage(
    envelope: Record<string, any>,
    rawFields: Record<string, string>,
): PreparedJsonMessage {
    return {
        [PREPARED_JSON_MESSAGE]: true,
        envelope,
        rawFields,
    };
}

export function isPreparedJsonMessage(value: unknown): value is PreparedJsonMessage {
    return !!value
        && typeof value === 'object'
        && (value as PreparedJsonMessage)[PREPARED_JSON_MESSAGE] === true;
}

export function withPreparedJsonEnvelope(
    message: PreparedJsonMessage,
    update: (envelope: Record<string, any>) => Record<string, any>,
): PreparedJsonMessage {
    return createPreparedJsonMessage(update(message.envelope), message.rawFields);
}

export function preparedJsonEnvelope(message: PreparedJsonMessage): Record<string, any> {
    return message.envelope;
}

export function materializePreparedJsonMessage(message: PreparedJsonMessage): string {
    const envelopeJson = JSON.stringify(message.envelope);
    if (!envelopeJson || envelopeJson[0] !== '{' || envelopeJson[envelopeJson.length - 1] !== '}') {
        throw new Error('Prepared JSON envelope must serialize to an object');
    }

    const rawEntries = Object.entries(message.rawFields).map(([key, rawJson]) => {
        if (!rawJson) {
            throw new Error(`Prepared JSON field '${key}' is empty`);
        }
        return `${JSON.stringify(key)}:${rawJson}`;
    });

    if (rawEntries.length === 0) {
        return envelopeJson;
    }
    if (envelopeJson === '{}') {
        return `{${rawEntries.join(',')}}`;
    }
    return `{${envelopeJson.slice(1, -1)},${rawEntries.join(',')}}`;
}

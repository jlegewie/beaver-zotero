# SentenceX WASM Bindings

A WebAssembly binding for the SentenceX sentence segmentation library. This allows you to use the fast, multilingual sentence segmentation capabilities of SentenceX directly in web browsers and Node.js applications.

## Installation

```bash
npm install sentencex-wasm
```

## Usage

### Basic Sentence Segmentation

```javascript
import init, { segment } from 'sentencex-wasm';

async function run() {
    // Initialize the WASM module
    await init();

    const text = "The James Webb Space Telescope (JWST) is a space telescope specifically designed to conduct infrared astronomy. The U.S. National Aeronautics and Space Administration (NASA) led Webb's design and development.";
    const sentences = segment("en", text);

    sentences.forEach((sentence, index) => {
        console.log(`${index + 1}. ${sentence}`);
    });
}

run();
```

### Detailed Sentence Boundaries

For more advanced use cases, you can get detailed information about sentence boundaries:

```javascript
import init, { get_sentence_boundaries } from 'sentencex-wasm';

async function run() {
    await init();

    const text = "Hello world. This is a test.\n\nNew paragraph.";
    const boundaries = get_sentence_boundaries("en", text);

    boundaries.forEach(boundary => {
        console.log({
            text: boundary.text,
            start: boundary.start_index,
            end: boundary.end_index,
            symbol: boundary.boundary_symbol,
            isParaBreak: boundary.is_paragraph_break
        });
    });
}

run();
```

## API Reference

### `segment(language: string, text: string): string[]`

Segments a given text into sentences based on the specified language.

**Parameters:**
- `language` - Language code (e.g., "en" for English, "fr" for French)
- `text` - Text to be segmented

**Returns:**
- Array of sentence strings

### `get_sentence_boundaries(language: string, text: string): SentenceBoundary[]`

Returns detailed sentence boundaries for analysis and advanced processing.

**Parameters:**
- `language` - Language code (e.g., "en" for English, "fr" for French)
- `text` - Text to be analyzed

**Returns:**
- Array of `SentenceBoundary` objects containing:
  - `start_index`: Byte index where the sentence starts
  - `end_index`: Byte index where the sentence ends
  - `text`: The sentence text
  - `boundary_symbol`: Punctuation mark that ended the sentence (if any)
  - `is_paragraph_break`: Whether this boundary represents a paragraph break

## Language Support

SentenceX supports sentence segmentation for over 240 languages with intelligent fallback chains. Common language codes include:

- `en` - English
- `es` - Spanish
- `fr` - French
- `de` - German
- `it` - Italian
- `pt` - Portuguese
- `ja` - Japanese
- `zh` - Chinese
- `ar` - Arabic
- `hi` - Hindi
- And many more...


## Performance

The WASM bindings provide near-native performance for sentence segmentation while running in JavaScript environments. The segmentation is non-destructive, meaning the original text can be reconstructed by joining the segments.

## License

MIT. See [https://github.com/wikimedia/sentencex](https://github.com/wikimedia/sentencex)

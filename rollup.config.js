import svelte from 'rollup-plugin-svelte';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import css from 'rollup-plugin-css-only';

export default {
    input: 'src/svelte/main.js', // 1) entrypoint for your Svelte code
    output: {
        sourcemap: true,
        format: 'iife',             // 2) "iife" or "umd" is often safest for a Zotero environment
        name: 'BeaverSvelteBundle', // 3) A global name for your bundle
        file: 'addon/content/svelte-dist/bundle.js'
    },
    plugins: [
        svelte({
            // You can add svelte compiler options here
            emitCss: true
        }),
        css({ output: 'bundle.css' }),
        resolve({
            browser: true,
            dedupe: ['svelte']
        }),
        commonjs(),
    ],
};

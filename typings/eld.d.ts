// Declarations for `eld` package subpath imports. tsconfig uses
// `module: "commonjs"`, which does not resolve the subpath exports
// declared in `eld/package.json`'s `"exports"` field. Bundlers
// (webpack + esbuild) resolve them at build time without issue;
// these declarations only exist so `tsc --noEmit` can find the types.

declare module "eld/extrasmall" {
    export { eld } from "eld";
}

declare module "eld/small" {
    export { eld } from "eld";
}

declare module "eld/medium" {
    export { eld } from "eld";
}

declare module "eld/large" {
    export { eld } from "eld";
}

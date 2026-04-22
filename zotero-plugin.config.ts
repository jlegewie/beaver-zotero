import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

// Zotero UI locales (mirrors chrome/locale/* in the Zotero source tree)
const ZOTERO_LOCALES = [
  "af-ZA", "ar", "bg-BG", "br", "ca-AD", "cs-CZ", "da-DK", "de", "el-GR",
  "en-GB", "en-US", "es-ES", "et-EE", "eu-ES", "fa", "fi-FI", "fr-FR",
  "gl-ES", "he-IL", "hr-HR", "hu-HU", "id-ID", "is-IS", "it-IT", "ja-JP",
  "km", "ko-KR", "lt-LT", "mn-MN", "nb-NO", "nl-NL", "nn-NO", "pl-PL",
  "pt-BR", "pt-PT", "ro-RO", "ru-RU", "sk-SK", "sl-SI", "sr-RS", "sv-SE",
  "ta", "th-TH", "tr-TR", "uk-UA", "vi-VN", "zh-CN", "zh-TW",
];

export default defineConfig({
  source: ["src", "addon"],
  // source: {
  //   paths: ["src", "addon"],
  //   ignored: ["src/react/**"]
  // },
  // source: [
  //   "src/**/*",          // All files in src
  //   "!src/react/**",     // Exclude react directory
  //   "!src/react/**/*",   // Exclude all files in react directory
  //   "addon/**/*"         // All files in addon
  // ],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
    hooks: {
      "build:fluent": async (ctx) => {
        const enUsDir = join(ctx.dist, "addon/locale/en-US");
        if (!existsSync(enUsDir)) return;
        const files = readdirSync(enUsDir).filter((f) => f.endsWith(".ftl"));
        if (files.length === 0) return;
        for (const locale of ZOTERO_LOCALES) {
          if (locale === "en-US") continue;
          const target = join(ctx.dist, "addon/locale", locale);
          mkdirSync(target, { recursive: true });
          for (const f of files) {
            copyFileSync(join(enUsDir, f), join(target, f));
          }
        }
      },
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});

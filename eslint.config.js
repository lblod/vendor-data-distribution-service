const {
    defineConfig,
    globalIgnores,
} = require("eslint/config");

const globals = require("globals");
const js = require("@eslint/js");

const {
    FlatCompat,
} = require("@eslint/eslintrc");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

module.exports = defineConfig([{
    languageOptions: {
        globals: {
            ...globals.browser,
        },

        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: {},
    },

    extends: compat.extends("eslint:recommended", "plugin:prettier/recommended"),

    rules: {
        indent: ["error", 2, {
            SwitchCase: 1,
        }],

        "linebreak-style": ["error", "unix"],
        quotes: ["error", "single"],
        semi: ["error", "always"],
    },
}, globalIgnores([
    "dist/",
    "tmp/",
    "bower_components/",
    "node_modules/",
    "coverage/",
    "!**/.*",
    "**/.*/",
    "**/.eslintcache",
    "**/eslint.config.js",
    "**/.prettierrc.cjs",
])]);

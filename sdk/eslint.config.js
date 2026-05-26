import tsParser from "@typescript-eslint/parser";

export default [
    {
        files: ["src/**/*.ts", "test/**/*.ts"],
        ignores: ["node_modules/**", "dist/**"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        rules: {
            "no-console": "off",
            "no-unused-vars": ["warn", {
                varsIgnorePattern: "^_",
                argsIgnorePattern: "^_",
                caughtErrors: "none",
            }],
        },
    },
];

/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: ["@naporin0624/eslint-config"],
  parserOptions: {
    project: "./tsconfig.eslint.json",
  },
  rules: {
    "no-restricted-imports": "off",
    "import/no-unresolved": [
      "error",
      {
        ignore: ["^cloudflare:.*$"],
      },
    ],
  },
  overrides: [
    {
      files: ["src/e2e/**/*"],
      rules: {
        "import/no-extraneous-dependencies": "off",
      },
    },
  ],
};

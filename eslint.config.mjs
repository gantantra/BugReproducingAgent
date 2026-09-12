import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The import-boundary rules below are the fast-feedback half of ADR-0006 and ADR-0019.
 * They are NOT the authority: lint can be disabled inline, so
 * tests/docs/import-boundary.spec.ts walks the resolved module graph and fails the build.
 */
const AI_PACKAGES = ["@investigator/ai-gateway", "@investigator/ai-flows"];
const PROVIDER_SDKS = [
  "openai",
  "@anthropic-ai/*",
  "@google/*",
  "cohere-ai",
  "ollama",
  "langchain",
  "langchain/*",
];

const deterministicOnly = {
  files: [
    "packages/execution/**/*.ts",
    "packages/evidence/**/*.ts",
    "packages/test-fixtures/**/*.ts",
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...AI_PACKAGES.map((name) => ({
            name,
            message:
              "ADR-0006: execution, evidence, and test-fixtures must never import AI code. DeepSeek is never in the execution loop.",
          })),
        ],
        patterns: [
          {
            group: PROVIDER_SDKS,
            message: "ADR-0006: no provider SDK may be reachable from the deterministic core.",
          },
          {
            group: ["**/ai-gateway/**", "**/ai-flows/**"],
            message: "ADR-0006: relative escape into AI code is still a boundary violation.",
          },
        ],
      },
    ],
  },
};

const toolsNoExecution = {
  files: ["packages/tools/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@investigator/execution",
            message: "ADR-0011: tools are read-only projections and must not reach the executor.",
          },
          {
            name: "playwright",
            message: "ADR-0011: no tool may drive a browser.",
          },
        ],
      },
    ],
  },
};

const noInlinePrompts = {
  files: ["packages/ai-flows/**/*.ts"],
  rules: {
    // ADR-0010: prompts are versioned filesystem artifacts, never string literals.
    "max-len": ["error", { code: 200, ignoreUrls: true, ignoreRegExpLiterals: true }],
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".investigator/**",
      "demo-ws/**",
      "**/*.tsbuildinfo",
      "scripts/workspace-graph.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      // Determinism: ADR-0007 bans ambient time and randomness from the evidence path.
      // Enforced narrowly below rather than repo-wide, since the CLI and tests need them.
    },
  },
  {
    files: ["packages/execution/**/*.ts", "packages/evidence/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "ADR-0007: use the injected seeded Rng. Ambient randomness breaks determinism.",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "ADR-0007: use the injected Clock. Ambient time breaks determinism.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "ADR-0007: use the injected Clock. Ambient time breaks determinism.",
        },
      ],
    },
  },
  deterministicOnly,
  toolsNoExecution,
  noInlinePrompts,
  {
    files: ["**/*.spec.ts", "**/test/**/*.ts", "tests/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    // CommonJS helper scripts. `require` is the correct call there, not a lapse.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", exports: "writable" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // The web UI's client script runs in a browser, not in Node.
    files: ["apps/web/public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        TextDecoder: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  }
);

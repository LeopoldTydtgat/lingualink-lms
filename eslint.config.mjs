import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // react-hooks/purity (React Compiler rule, added in eslint-plugin-react-hooks v7
    // via eslint-config-next 16.2.6) mis-fires on async Server Components: it treats
    // the once-per-request server render as a client render and flags Date.now() /
    // Math.random() as impure-in-render. These four files are async Server Components
    // (no 'use client'); the calls are request-time timestamps / an invoice-ref nonce,
    // not values that re-render non-deterministically. NOTE: this disables the rule
    // FILE-WIDE for these four paths, not per-call — any future impure pattern added to
    // these files will also be unguarded, so keep them server-only. The rule
    // stays ON everywhere else, including the three client components where it fires
    // legitimately (UpcomingClassesClient, RightPanel, ClassReminderModal).
    files: [
      "src/app/(dashboard)/layout.tsx",
      "src/app/(admin)/layout.tsx",
      "src/app/(dashboard)/billing/page.tsx",
      "src/app/(student)/student/layout.tsx",
    ],
    rules: {
      "react-hooks/purity": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

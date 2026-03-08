import globals from 'globals';
import tseslint from 'typescript-eslint';

const legacyLineBudgetFiles = [
    'apps/local-runner/src/state.ts',
    'apps/desktop-companion/src/renderer/App.tsx',
    'apps/local-runner/src/pluto.ts',
    'packages/shared/src/schemas.ts',
    'apps/local-runner/src/state.test.ts',
    'apps/desktop-companion/src/renderer/components/DashboardView.tsx',
    'apps/desktop-companion/src/main/server.ts',
    'apps/desktop-companion/src/main/index.ts',
];

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/tmp/**',
            '**/.turbo/**',
            '**/.vite/**',
            'logs/**',
            'docs/**',
            'infra/**',
        ],
    },
    {
        files: ['**/*.{ts,tsx,js,mjs,cjs}'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                ecmaFeatures: {
                    jsx: true,
                },
            },
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            'max-lines': [
                'error',
                {
                    max: 500,
                    skipBlankLines: true,
                    skipComments: true,
                },
            ],
        },
    },
    {
        files: legacyLineBudgetFiles,
        rules: {
            'max-lines': 'off',
        },
    },
];

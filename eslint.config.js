import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tseslintParser from '@typescript-eslint/parser';

export default [
    eslint.configs.recommended,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tseslintParser,
            parserOptions: {
                ecmaVersion: 6,
                sourceType: 'module'
            }
        },
        plugins: {
            '@typescript-eslint': tseslint
        },
        rules: {
            '@typescript-eslint/naming-convention': 'warn',
            '@typescript-eslint/semi': 'warn',
            'curly': 'warn',
            'eqeqeq': 'warn',
            'no-throw-literal': 'warn',
            'semi': 'off'
        },
        ignores: ['out/**', 'dist/**', '**/*.d.ts']
    }
]; 
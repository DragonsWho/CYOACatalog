// eslint.config.js
// v1.1
// Changes: Removed duplicate 'settings' key, merged settings into one object

import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';

export default [
  {files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}']},
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      'quotes': [
        2,
        'single',
        {
          'avoidEscape': true
        }
      ],
      'react/prop-types': 0,
    },
  },
];
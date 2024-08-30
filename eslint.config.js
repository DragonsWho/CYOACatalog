import globals from 'globals';
import pluginJs from '@eslint/js';
import pluginReact from 'eslint-plugin-react';


export default [
  {files: ['**/*.{js,mjs,cjs,jsx}']},
  pluginJs.configs.recommended,
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
        version: 'detect', // Automatically detect the React version
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
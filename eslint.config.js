import globals from 'globals';
import pluginJs from '@eslint/js';
import pluginReact from 'eslint-plugin-react';


export default [
  {files: ['**/*.{js,mjs,cjs,jsx}']},
  {languageOptions: { globals: globals.browser }},
  pluginJs.configs.recommended,
  pluginReact.configs.flat.recommended,
  {
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
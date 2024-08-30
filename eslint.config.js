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
    'settings': { 
      'react': {
        'version': 'detect'
      },
    },
  },
];
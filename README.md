# Things to install

[bun](https://bun.sh/)

[go](https://golang.org/)
sudo apt install golang-go

node.js

typescript

# For *nix

`make install` to install dependencies

`make build` to build the project


`make run` to run the build

add the testing file data.db to the pb_data folder  (the username is admin@gmail.com and password is adminadmin)

`make dev` to start development server


# For windows

`bun install` to install dependencies

`bun dev` to start development server

`bun run build` to build the project

`bun preview` to serve the build 

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react'

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
})
```









TODO

In voting for custom tags should still remove tags with 0 votes. Realize it on the server. It is better to transfer all the logic to the server.....

Make a script that would parse index.html and extract data that would draw the page itself, rather than using iframe. This will allow to add css, get rid of the ugly scroll bar in iframe
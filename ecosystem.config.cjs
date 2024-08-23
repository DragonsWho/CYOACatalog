module.exports = {
  apps: [
    {
      name: 'cyoa-frontend',
      script: 'npm',
      args: 'run dev',
      cwd: '/root/CYOACatalog',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'strapi',
      cwd: '/root/CYOACatalogStrapi',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

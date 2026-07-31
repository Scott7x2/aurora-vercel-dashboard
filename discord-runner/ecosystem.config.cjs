module.exports = {
  apps: [
    {
      name: 'aurora-runner',
      script: 'src/runner.js',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};

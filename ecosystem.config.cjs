/**
 * PM2 production config for the platform API (auth, chat, weather, contact).
 *
 *   chmod +x scripts/pm2-deploy.sh && ./scripts/pm2-deploy.sh
 *   pm2 logs Agricai-Node
 */
module.exports = {
  apps: [
    {
      name: "Agricai-Node",
      cwd: __dirname,
      script: "src/server.mjs",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: "3008",
      },
    },
  ],
};

/**
 * PM2 production config for the platform API (auth, chat, weather, contact).
 *
 * Loads `.env` here so PM2 injects variables into the process *before* Node starts.
 * That avoids a production outage where ESM import order meant `jwt.mjs` ran before
 * the entry point's dotenv call and saw an empty JWT_SECRET.
 *
 *   chmod +x scripts/pm2-deploy.sh && ./scripts/pm2-deploy.sh
 *   pm2 logs Agricai-Node
 */
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const ROOT = __dirname;
const envPath = path.join(ROOT, ".env");
const fileEnv = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};

module.exports = {
  apps: [
    {
      name: "Agricai-Node",
      cwd: ROOT,
      script: "src/server.mjs",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        ...fileEnv,
        NODE_ENV: "production",
        PORT: fileEnv.PORT || "3008",
      },
    },
  ],
};

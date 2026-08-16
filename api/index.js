const server = require('../server/dist/index.js');
const { runMigrations } = require('../server/dist/db/migrations.js');

const app = server.default || server;

let ready = null;

async function ensureReady() {
  if (!ready) {
    ready = runMigrations().catch((err) => {
      console.error('Migration failed:', err && err.message);
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = async function handler(req, res) {
  try {
    await ensureReady();
  } catch (err) {
    res.status(500).json({ error: 'Database failed to initialize: ' + (err && err.message) });
    return;
  }
  app(req, res);
};

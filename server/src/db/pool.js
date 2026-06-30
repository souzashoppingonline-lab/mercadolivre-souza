const { Pool } = require('pg');
const env = require('../config/env');

const pool = new Pool({ connectionString: env.databaseUrl });

pool.on('error', (err) => console.error('[pg] unexpected error', err));

module.exports = pool;

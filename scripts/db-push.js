#!/usr/bin/env node

const { drizzle } = require('drizzle-orm/neon-serverless');
const { migrate } = require('drizzle-orm/neon-serverless/migrator');
const { neon } = require('@neondatabase/serverless');

// Load environment variables from .env file if present
require('dotenv').config();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  console.log('Connecting to database...');
  const sql = neon(process.env.DATABASE_URL);
  const db = drizzle(sql);

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: 'drizzle' });

  console.log('Migrations completed successfully');
}

main().catch((error) => {
  console.error('Error running migrations:', error);
  process.exit(1);
});
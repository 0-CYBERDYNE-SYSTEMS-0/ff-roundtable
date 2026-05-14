#!/usr/bin/env bash
# FarmFriend Roundtable — Database Setup
# Creates the database and pushes schema migrations.
# Requires: PostgreSQL running locally, psql + drizzle-kit available.

set -euo pipefail

DB_NAME="${1:-farm_roundtable_dev}"
DB_URL="postgresql://localhost:5432/${DB_NAME}"

echo "🔧 Setting up database: ${DB_NAME}"

# Create database if it doesn't exist (ignore "already exists" error)
createdb "${DB_NAME}" 2>/dev/null && echo "   ✅ Database '${DB_NAME}' created" || echo "   ℹ️  Database '${DB_NAME}' already exists"

# Push Drizzle schema
echo "📦 Pushing schema..."
DATABASE_URL="${DB_URL}" npx drizzle-kit push

echo ""
echo "✅ Database setup complete!"
echo "   Connection: ${DB_URL}"
echo ""
echo "   Next: add DATABASE_URL=${DB_URL} to your .env file, then:"
echo "   npm run dev"

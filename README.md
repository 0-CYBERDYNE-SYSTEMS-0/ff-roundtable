# FarmFriend Roundtable PRO

[![CI](https://github.com/scrimwiggins/FarmFriendRoundtable-PRO/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/scrimwiggins/FarmFriendRoundtable-PRO/actions/workflows/ci.yml)
[![Docker Image Size](https://ghcr-badge.egpl.dev/scrimwiggins/FarmFriendRoundtable-PRO/size?tag=latest&label=image+size)](https://github.com/scrimwiggins/FarmFriendRoundtable-PRO/pkgs/container/FarmFriendRoundtable-PRO)

AI-powered agricultural advisory platform. Multi-expert roundtable discussions, weather-aware insights, and subscription management for modern farming.

## Quick Start

```bash
npm install
npm run dev
```

## Local development database

Use PostgreSQL for data that survives application restarts. On this Mac, PostgreSQL 17
is installed as a Homebrew service and the development database is `farm_roundtable_dev`.
The ignored `.env` file contains the connection URL and API credentials.

```bash
brew services start postgresql@17
/opt/homebrew/opt/postgresql@17/bin/createdb farm_roundtable_dev # first setup only
npm run db:push # apply schema changes to the development database
npm run dev # http://localhost:5001
```

Tests use in-memory storage and do not modify the development database.

## Tech Stack

- React 18 + Vite + TypeScript
- Express + WebSocket
- PostgreSQL + Drizzle ORM
- Tailwind CSS + shadcn/ui
- Stripe subscriptions
- OpenRouter AI integration

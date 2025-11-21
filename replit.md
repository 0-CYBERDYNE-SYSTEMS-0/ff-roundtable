# Farm Friend Roundtable

## Overview

Farm Friend Roundtable is an AI-powered agricultural discussion platform that enables farmers and agricultural professionals to engage with multiple AI experts simultaneously in roundtable-style conversations. The application leverages OpenRouter's diverse model library to provide specialized agricultural expertise across various domains including soil science, crop management, irrigation, and more. Users can select 4-8 AI experts with distinct roles to collaborate on agricultural challenges, with real-time WebSocket communication enabling dynamic, multi-expert interactions.

The platform features an innovative top-down roundtable visualization, file upload capabilities, artifact generation (code, charts, tables), and subscription-based access via Stripe. The system supports autonomous expert interactions where AI experts can engage with each other automatically, creating a rich collaborative environment for agricultural problem-solving.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Technology Stack:**
- React 18 with TypeScript for type-safe component development
- Vite as the build tool and development server
- TanStack Query (React Query) for server state management and caching
- Wouter for lightweight client-side routing
- Tailwind CSS with shadcn/ui component library for styling
- Three.js for 3D roundtable visualization

**Key Design Patterns:**
- Component-based architecture with clear separation between layout, feature, and UI components
- Custom hooks for auth (`use-auth`), WebSocket connections (`useWebSocket`), and toast notifications
- Query client with aggressive caching strategy (staleTime: Infinity) to minimize unnecessary API calls
- Protected routes that verify both authentication and subscription status before rendering

**State Management Strategy:**
- Server state managed via TanStack Query with explicit query keys
- WebSocket messages update query cache directly for real-time synchronization
- Local component state for UI interactions (modals, forms, selections)
- Authentication state globally available through React Context

**Rationale:** The choice of React Query eliminates the need for Redux or similar global state libraries while providing excellent caching, invalidation, and optimistic updates. Wouter provides routing without the overhead of React Router. The WebSocket integration allows real-time expert responses without polling.

### Backend Architecture

**Technology Stack:**
- Express.js server with TypeScript
- Session-based authentication using Passport.js with LocalStrategy
- In-memory storage implementation (MemStorage class) for development
- WebSocket server for real-time bidirectional communication
- Drizzle ORM for database schema definition and migrations

**Core Architectural Components:**

1. **Orchestrator System** (`server/orchestrator.ts`)
   - Manages conversation state and expert turn-taking
   - Supports multiple interaction modes: idle, processing_sequential, paused, autonomous
   - Handles autonomous expert interactions with configurable turn limits
   - Broadcasts state updates via WebSocket to keep clients synchronized
   - Problem solved: Coordinating multiple AI experts responding in sequence or autonomously
   - Alternative considered: Client-side orchestration, but rejected due to complexity of maintaining state across disconnections

2. **AI Integration Layer** (`server/ai.ts`)
   - Abstraction over OpenRouter API for accessing multiple LLM providers
   - Dynamic system prompt generation based on expert roles and context
   - Support for Perplexity API integration for web search capabilities
   - Artifact extraction from AI responses (code blocks, charts, tables, HTML)
   - Problem solved: Unified interface for diverse AI models with role-specific customization
   - Pros: Flexible model selection, easy to add new providers
   - Cons: Dependent on external API availability and rate limits

3. **Authentication & Authorization** (`server/auth.ts`)
   - Development mode flag enables easy testing with hardcoded credentials
   - Simple password hashing with environment-aware strategy (dev: prefix-based, production: placeholder for proper hashing)
   - Session management using express-session with MemoryStore
   - Protected route middleware validates both authentication and subscription status
   - Problem solved: Secure access control while maintaining development flexibility
   - Trade-off: Development mode reduces security for ease of testing

4. **Storage Abstraction** (`server/storage.ts`)
   - IStorage interface defining all CRUD operations
   - MemStorage implementation using in-memory Maps for development
   - Designed for easy swap to PostgreSQL-backed implementation
   - Problem solved: Allows development without database while maintaining production-ready interface
   - Future consideration: Drizzle ORM integration for PostgreSQL backend

5. **WebSocket Communication** (`server/routes.ts`)
   - Bidirectional real-time updates between server and clients
   - Message types: expert_typing, message_added, messages_updated, state_update
   - Client-side reconnection logic with exponential backoff
   - Problem solved: Real-time updates for multi-expert conversations without polling
   - Pros: Low latency, reduced server load
   - Cons: Requires connection state management, fallback handling

### Data Storage

**Current Implementation:**
- In-memory storage using JavaScript Maps (MemStorage class)
- Session data stored in MemoryStore
- Uploaded files stored on filesystem in `uploads/` directory
- Suitable for development and single-instance deployments

**Schema Design (Drizzle):**
- `users`: Authentication and Stripe subscription tracking
- `conversations`: User-owned discussion threads
- `experts`: AI experts associated with specific conversations
- `messages`: Conversation messages with role (user/assistant) and artifacts
- `files`: Uploaded files with conversation association
- `insights`: AI-generated key takeaways from conversations

**Rationale:** The in-memory implementation allows rapid development iteration without database setup. The Drizzle schema provides a clear migration path to PostgreSQL for production, maintaining the same interface through the IStorage abstraction.

**Future Migration Path:**
- Replace MemStorage with PostgresStorage implementation using Drizzle
- Configure PostgreSQL connection via DATABASE_URL environment variable
- Run migrations using `drizzle-kit push`
- No changes required to routes or business logic due to storage abstraction

### Authentication & Authorization

**Authentication Flow:**
1. User submits credentials via `/api/login` endpoint
2. Passport LocalStrategy validates against stored user records
3. Successful authentication creates session with `connect.sid` cookie
4. Session ID stored in MemoryStore (or future Redis for production)
5. Protected routes verify `req.isAuthenticated()` before proceeding

**Development Mode Features:**
- Auto-created developer account (username: developer, password: password)
- Special `/api/dev-login` endpoint for instant authentication
- Password hashing simplified with `dev:` prefix for easy debugging
- Subscription checks bypassed when DEVELOPMENT_MODE flag is true

**Authorization Layers:**
1. Route-level: Protected routes require valid session
2. Subscription-level: Certain features require active Stripe subscription
3. Resource-level: Users can only access their own conversations/data

**Rationale:** Passport.js provides battle-tested authentication with minimal configuration. Development mode significantly speeds up testing cycles while the subscription integration ensures monetization in production.

## External Dependencies

### Third-Party APIs

**OpenRouter API** (Primary AI Provider)
- Purpose: Access to 200+ AI models from providers like OpenAI, Anthropic, Google, Meta
- Integration: HTTP POST to `/api/v1/chat/completions` endpoint
- Authentication: Bearer token via `OPENROUTER_API_KEY` environment variable
- Usage: All expert responses generated through OpenRouter with model selection per expert
- Rate limiting: Handled by OpenRouter with graceful error handling
- Fallback: Predefined model list used if API unavailable for model discovery

**Perplexity API** (Optional - Web Search)
- Purpose: Internet search capabilities for experts needing current information
- Integration: Similar to OpenRouter, chat completions endpoint
- Authentication: `PERPLEXITY_API_KEY` environment variable
- Usage: Designated experts can perform web searches to augment responses with cited sources

**Stripe API** (Payment Processing)
- Purpose: Subscription management and payment processing
- Integration: Stripe SDK for session creation and webhook handling
- Authentication: `STRIPE_SECRET_KEY` for server-side, `VITE_STRIPE_PUBLIC_KEY` for client-side
- Usage: $10 monthly subscription required for app access
- Webhook: Handles subscription status updates from Stripe
- Development: Bypassed via DEVELOPMENT_MODE flag

### Database

**Neon Serverless PostgreSQL** (Production Target)
- Package: `@neondatabase/serverless`
- Connection: Via `DATABASE_URL` environment variable
- ORM: Drizzle with TypeScript schema definitions
- Current Status: Schema defined, in-memory storage used for development
- Migration: Drizzle Kit handles schema migrations via `db:push` script

### UI Component Libraries

**Radix UI Primitives**
- Comprehensive set of unstyled, accessible component primitives
- Includes: Dialog, Dropdown, Popover, Tabs, Toast, Avatar, and 20+ other components
- Rationale: Accessibility-first design, complete keyboard navigation, ARIA compliance

**shadcn/ui**
- Pre-styled components built on Radix UI primitives
- Customizable via Tailwind CSS utility classes
- Theme system with JSON-based configuration (`theme.json`)
- Rationale: Rapid UI development while maintaining customization flexibility

**Recharts**
- Data visualization library for React
- Used for rendering charts and graphs from AI-generated data artifacts
- Responsive container system for adaptive sizing

**Three.js**
- 3D graphics library for WebGL rendering
- Powers the roundtable visualization feature
- Rationale: Provides immersive visual representation of expert seating arrangement

### File Upload & Processing

**Multer** (Multipart Form Data)
- Middleware for handling `multipart/form-data` file uploads
- Configuration: 10MB file size limit, uploads stored in `uploads/` directory
- File types: Images, PDFs, spreadsheets, documents, text files
- Usage: Files attached to conversations for AI context

**DOMPurify** (HTML Sanitization)
- Prevents XSS attacks in AI-generated HTML artifacts
- Used when rendering HTML artifacts in the client
- Configuration: Allows iframes for embedded content with proper sandboxing

### Build & Development Tools

**esbuild** (Production Backend Build)
- Bundles server code for production deployment
- Configuration: ESM format, Node.js platform target, external packages
- Rationale: Extremely fast builds compared to webpack or rollup

**tsx** (Development Server)
- TypeScript execution for development server
- Hot reload support for rapid iteration
- Rationale: No build step needed during development

**Vite Plugins**
- `@vitejs/plugin-react`: React Fast Refresh support
- `@replit/vite-plugin-shadcn-theme-json`: Theme customization
- `@replit/vite-plugin-runtime-error-modal`: Development error overlay
- `@replit/vite-plugin-cartographer`: Replit-specific development features

### Environment Variables Required

**Required for Production:**
- `DATABASE_URL`: PostgreSQL connection string (Neon serverless)
- `SESSION_SECRET`: Secret for session encryption
- `OPENROUTER_API_KEY`: OpenRouter API authentication
- `STRIPE_SECRET_KEY`: Stripe API key (server-side)
- `VITE_STRIPE_PUBLIC_KEY`: Stripe publishable key (client-side)

**Optional:**
- `PERPLEXITY_API_KEY`: Enable web search functionality
- `NODE_ENV`: Set to "production" for production builds

**Development Defaults:**
- Missing SESSION_SECRET triggers warning, uses random string
- Missing Stripe keys allows bypass via DEVELOPMENT_MODE
- OpenRouter falls back to predefined model list if API key missing
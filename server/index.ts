import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { describeOwmKey } from "./weather";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

// Startup sanity check for the OWM key — env-only, no boot-time network call.
{
  const owm = describeOwmKey(process.env.OWM_API_KEY);
  if (!owm.present) {
    log("OWM_API_KEY not set — weather features disabled (missing_key)");
  } else if (owm.looksMalformed) {
    log("OWM_API_KEY is set but does not look like an OWM key (expected 32 hex chars) — weather may 401 (auth)");
  } else {
    log("OWM_API_KEY present and well-formed (must also be enabled for One Call 3.0)");
  }
}

const app = express();
// Keep the raw body around so the Stripe webhook can verify signatures —
// re-serializing a parsed object would produce different bytes.
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: false }));

// Security headers — CSP must be off in development: Vite's inline
// react-refresh preamble and HMR websocket are blocked by script-src 'self'.
app.use(helmet(app.get("env") === "development" ? { contentSecurityPolicy: false } : {}));

// CORS - allow only the configured origin
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "http://localhost:5173",
  credentials: true,
}));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});
app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5001", 10);
  server.listen({
    port,
    host: "0.0.0.0",
  }, () => {
    log(`serving on port ${port}`);
  });
})();

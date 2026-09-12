import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import { randomBytes } from "crypto";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";

// Development flag - set to true for easy authentication during development
const DEVELOPMENT_MODE = process.env.NODE_ENV !== "production";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const BCRYPT_ROUNDS = 12;

// Password hashing with bcrypt
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Password comparison with bcrypt
async function comparePasswords(supplied: string, stored: string): Promise<boolean> {
  // Backward compatibility: handle old dev: prefix passwords
  if (stored.startsWith("dev:")) {
    return supplied === stored.substring(4);
  }
  if (stored.startsWith("simple:")) {
    return supplied === stored.substring(7);
  }

  // Standard bcrypt comparison
  return bcrypt.compare(supplied, stored);
}

// Login rate limiter: 5 attempts per 15 minutes per IP.
// Factory (not a module-level singleton): each Express app gets its own
// counter, so isolated test apps don't share/exhaust one global bucket.
function makeLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    // Default 5 in production. Override hook exists for load-heavy test
    // suites that legitimately perform many logins against one app.
    max: Number(process.env.LOGIN_RATELIMIT_MAX ?? 5),
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many login attempts. Please try again in 15 minutes." },
  });
}

export function setupAuth(app: Express) {
  if (!process.env.SESSION_SECRET) {
    console.warn("No SESSION_SECRET provided. Using a random string, sessions will not persist across restarts.");
  }

  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      secure: process.env.NODE_ENV === "production",
    }
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const user = await storage.getUserByUsername(username);
        if (!user || !(await comparePasswords(password, user.password))) {
          return done(null, false);
        } else {
          return done(null, user);
        }
      } catch (error) {
        return done(error);
      }
    }),
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  // Registration with bcrypt password hashing
  app.post("/api/register", async (req, res, next) => {
    try {
      // Server-side validation — the client schema is not a security boundary.
      // Without this a blank username creates an account that can never log in,
      // and a crafted body could set tier/stripe fields at signup.
      const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      if (!username) {
        return res.status(400).json({ message: "Username is required" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "A valid email is required" });
      }
      if (typeof req.body.password !== "string" || req.body.password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }

      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const hashedPassword = await hashPassword(req.body.password);
      const user = await storage.createUser({
        username,
        email,
        password: hashedPassword,
      });

      req.login(user, (err) => {
        if (err) return next(err);
        // Don't return password hash to client
        const { password, ...safeUser } = user;
        res.status(201).json({ ...safeUser, password: "***" });
      });
    } catch (error) {
      next(error);
    }
  });

  // Login with rate limiting
  app.post("/api/login", makeLoginLimiter(), (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate("local", (err: any, user: Express.User | false) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: "Invalid username or password" });
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        const { password, ...safeUser } = user;
        res.status(200).json({ ...safeUser, password: "***" });
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const { password, ...safeUser } = req.user!;
    res.json({ ...safeUser, password: "***" });
  });
  
  // Middleware to check subscription
  app.use("/api/protected", (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    // In development mode, allow access regardless of subscription status
    if (DEVELOPMENT_MODE) {
      return next();
    }
    
    const user = req.user as SelectUser;
    if (user.subscriptionStatus !== "active") {
      return res.status(403).json({ message: "Subscription required" });
    }
    
    next();
  });
}

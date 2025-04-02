import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { randomBytes } from "crypto";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";

// Development flag - set to true for easy authentication during development
const DEVELOPMENT_MODE = true;

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

// Simple password hashing for development
function hashPassword(password: string): string {
  // In development mode, use a simple format that's easy to understand and debug
  if (DEVELOPMENT_MODE) {
    return `dev:${password}`;
  }
  
  // In production, you would use a proper hashing algorithm here
  // This is a placeholder that shouldn't be used in production
  return `simple:${password}`;
}

// Simple password comparison for development
function comparePasswords(supplied: string, stored: string): boolean {
  // For development mode users with the special prefix
  if (stored.startsWith('dev:')) {
    return supplied === stored.substring(4); // Skip the 'dev:' prefix
  }
  
  // For simple format
  if (stored.startsWith('simple:')) {
    return supplied === stored.substring(7); // Skip the 'simple:' prefix
  }
  
  // For any other format (shouldn't happen in development)
  console.warn('Unexpected password format. Using direct comparison.');
  return supplied === stored;
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

  app.post("/api/register", async (req, res, next) => {
    try {
      const existingUser = await storage.getUserByUsername(req.body.username);
      if (existingUser) {
        return res.status(400).send("Username already exists");
      }

      const user = await storage.createUser({
        ...req.body,
        password: await hashPassword(req.body.password),
      });

      req.login(user, (err) => {
        if (err) return next(err);
        res.status(201).json(user);
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/login", passport.authenticate("local"), (req, res) => {
    res.status(200).json(req.user);
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    res.json(req.user);
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

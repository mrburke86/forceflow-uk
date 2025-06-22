// src/startup.js - Fixed startup script for ForceFlow UK services
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import postgres from "@fastify/postgres";
import dotenv from "dotenv";

// Import routes
import flightRoutes from "./routes/flights.js";
import authRoutes from "./routes/auth.js";
import tempoRoutes from "./routes/tempo.js";
import healthRoutes from "./routes/health.js";

// Import services
import OpenSkyService from "./services/opensky.js";
import runMigration from "./db/migrate.js";

dotenv.config();

// Create Fastify instance
const fastify = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || "info",
        transport:
            process.env.NODE_ENV === "development"
                ? {
                      target: "pino-pretty",
                      options: {
                          colorize: true,
                          ignore: "pid,hostname",
                          translateTime: "SYS:standard",
                      },
                  }
                : undefined,
    },
    trustProxy: true,
});

// Global variable to track OpenSky service for status endpoint
let openSkyService = null;

async function startServices() {
    try {
        console.log("🚀 Starting ForceFlow UK services...");

        // Step 1: Run database migrations first
        console.log("📊 Running database migrations...");
        await runMigration();

        // Step 2: Register plugins
        console.log("🔧 Registering Fastify plugins...");

        // Security plugins
        await fastify.register(helmet, {
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                    connectSrc: ["'self'"],
                    fontSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    mediaSrc: ["'self'"],
                    frameSrc: ["'none'"],
                },
            },
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true,
            },
        });

        // CORS configuration
        await fastify.register(cors, {
            origin: process.env.CORS_ORIGIN || "http://localhost:3001",
            credentials: true,
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        });

        // Rate limiting
        await fastify.register(rateLimit, {
            max: parseInt(process.env.RATE_LIMIT_MAX || "60"),
            timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
            skipOnError: false,
            errorResponseBuilder: (request, context) => {
                return {
                    code: "ERR_RATE_LIMIT",
                    message: `Rate limit exceeded. Try again in ${Math.round(
                        context.ttl / 1000,
                    )} seconds.`,
                    statusCode: 429,
                };
            },
        });

        // JWT authentication
        await fastify.register(jwt, {
            secret:
                process.env.JWT_SECRET ||
                "your-super-secret-jwt-key-change-this-in-production",
            sign: {
                expiresIn: process.env.JWT_EXPIRES_IN || "15m",
            },
        });

        // Database connection
        await fastify.register(postgres, {
            connectionString:
                process.env.DATABASE_URL ||
                "postgresql://postgres:password@localhost:5432/forceflow_uk",
            ssl:
                process.env.NODE_ENV === "production"
                    ? { rejectUnauthorized: false }
                    : false,
        });

        // Step 3: Add decorators
        console.log("🎯 Adding authentication decorators...");

        // Authentication decorator
        fastify.decorate("authenticate", async function (request, reply) {
            try {
                await request.jwtVerify();
            } catch (err) {
                reply.code(401).send({
                    code: "ERR_UNAUTHORIZED",
                    message: "Invalid or expired token",
                });
            }
        });

        // Role-based authorization decorator
        fastify.decorate("authorize", (roles) => {
            return async function (request, reply) {
                if (!request.user) {
                    return reply.code(401).send({
                        code: "ERR_UNAUTHORIZED",
                        message: "Authentication required",
                    });
                }

                if (!roles.includes(request.user.role)) {
                    return reply.code(403).send({
                        code: "ERR_FORBIDDEN",
                        message: "Insufficient permissions",
                    });
                }
            };
        });

        // Step 4: Add error handler
        fastify.setErrorHandler(async (error, request, reply) => {
            fastify.log.error(error);

            // JWT errors
            if (error.code === "FST_JWT_NO_AUTHORIZATION_IN_HEADER") {
                return reply.code(401).send({
                    code: "ERR_NO_TOKEN",
                    message: "Authorization header required",
                });
            }

            if (error.code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED") {
                return reply.code(401).send({
                    code: "ERR_TOKEN_EXPIRED",
                    message: "Token has expired",
                });
            }

            // Database errors
            if (error.code?.startsWith("23")) {
                return reply.code(400).send({
                    code: "ERR_DATABASE_CONSTRAINT",
                    message: "Database constraint violation",
                });
            }

            // Default error response
            const statusCode = error.statusCode || 500;
            reply.code(statusCode).send({
                code: error.code || "ERR_INTERNAL_SERVER",
                message:
                    statusCode === 500
                        ? "Internal server error"
                        : error.message,
            });
        });

        // Step 5: Initialize OpenSky service (but don't start yet)
        console.log("🛠️  Initializing services...");
        openSkyService = new OpenSkyService(fastify);

        // Step 6: Register routes (BEFORE starting server)
        console.log("🛣️  Registering API routes...");

        // Health check (no auth required)
        await fastify.register(healthRoutes, { prefix: "/health" });

        // Authentication routes
        await fastify.register(authRoutes, { prefix: "/api/v1/auth" });

        // API routes (require authentication)
        await fastify.register(flightRoutes, { prefix: "/api/v1/flights" });
        await fastify.register(tempoRoutes, { prefix: "/api/v1/tempo" });

        // Root route
        fastify.get("/", async (request, reply) => {
            return {
                name: "ForceFlow UK API",
                version: "1.0.0",
                status: "operational",
                documentation: "/api/v1/docs",
                endpoints: {
                    health: "/health",
                    flights: "/api/v1/flights",
                    tempo: "/api/v1/tempo",
                    auth: "/api/v1/auth",
                },
            };
        });

        // Service status endpoint (registered BEFORE server starts)
        fastify.get("/api/v1/services/status", async (request, reply) => {
            return {
                timestamp: new Date().toISOString(),
                services: {
                    api: {
                        status: "running",
                        uptime: process.uptime(),
                    },
                    opensky: openSkyService
                        ? openSkyService.getStatus()
                        : {
                              service: "OpenSky Network",
                              running: false,
                              configured: false,
                              status: "not_started",
                          },
                    database: {
                        status: "connected",
                        url:
                            process.env.DATABASE_URL?.replace(
                                /:[^:@]*@/,
                                ":***@",
                            ) || "not configured",
                    },
                },
            };
        });

        // Step 7: Start the server
        console.log("🌐 Starting web server...");
        const port = parseInt(process.env.PORT || "3000");
        const host = process.env.HOST || "0.0.0.0";

        await fastify.listen({ port, host });

        fastify.log.info(
            `🚀 ForceFlow UK API server running on http://${host}:${port}`,
        );
        fastify.log.info(
            `📊 Environment: ${process.env.NODE_ENV || "development"}`,
        );
        fastify.log.info(
            `🔒 CORS origin: ${
                process.env.CORS_ORIGIN || "http://localhost:3001"
            }`,
        );

        // Step 8: Start background services (AFTER server is running)
        console.log("✈️  Starting OpenSky data ingestion...");
        if (openSkyService) {
            openSkyService.start();
        }

        console.log("✅ All services started successfully");

        // Graceful shutdown handler
        const shutdown = async (signal) => {
            console.log(`\n📴 Received ${signal}, shutting down gracefully...`);

            if (openSkyService) {
                openSkyService.stop();
            }
            await fastify.close();

            console.log("👋 ForceFlow UK shut down complete");
            process.exit(0);
        };

        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    } catch (error) {
        console.error("❌ Failed to start services:", error);
        process.exit(1);
    }
}

// Start services if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    startServices();
}

export default startServices;

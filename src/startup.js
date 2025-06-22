// src/startup.js Startup script for ForceFlow UK services
import fastify from "./server.js";
import OpenSkyService from "./services/opensky.js";
import runMigration from "./db/migrate.js";

async function startServices() {
    try {
        console.log("🚀 Starting ForceFlow UK services...");

        // Run database migrations
        console.log("📊 Running database migrations...");
        await runMigration();

        // Wait for server to be ready
        await fastify.ready();

        // Start OpenSky ingestion service
        console.log("✈️  Starting OpenSky data ingestion...");
        const openSkyService = new OpenSkyService(fastify);
        openSkyService.start();

        // Register service status endpoint
        fastify.get("/api/v1/services/status", async (request, reply) => {
            return {
                timestamp: new Date().toISOString(),
                services: {
                    api: {
                        status: "running",
                        uptime: process.uptime(),
                    },
                    opensky: openSkyService.getStatus(),
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

        console.log("✅ All services started successfully");

        // Graceful shutdown handler
        const shutdown = async (signal) => {
            console.log(`\n📴 Received ${signal}, shutting down gracefully...`);

            openSkyService.stop();
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

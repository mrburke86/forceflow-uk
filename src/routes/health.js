// Health check routes for ForceFlow UK API
export default async function healthRoutes(fastify, options) {
    // Basic health check
    fastify.get("/", async (request, reply) => {
        return {
            status: "healthy",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            version: process.env.npm_package_version || "1.0.0",
            environment: process.env.NODE_ENV || "development",
        };
    });

    // Detailed health check with database connectivity
    fastify.get("/detailed", async (request, reply) => {
        const healthCheck = {
            status: "healthy",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || "development",
            checks: {
                database: "unknown",
                memory: "unknown",
            },
        };

        // Check database connectivity
        try {
            const client = await fastify.pg.connect();
            const result = await client.query("SELECT 1 as health_check");
            client.release();

            healthCheck.checks.database =
                result.rows[0].health_check === 1 ? "healthy" : "unhealthy";
        } catch (error) {
            fastify.log.error("Database health check failed:", error.message);
            healthCheck.checks.database = "unhealthy";
            healthCheck.status = "degraded";
        }

        // Check memory usage
        const memoryUsage = process.memoryUsage();
        const memoryUsageMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
        healthCheck.checks.memory = {
            status: memoryUsageMB < 512 ? "healthy" : "warning",
            heapUsed: `${memoryUsageMB}MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
        };

        // Set HTTP status based on overall health
        const statusCode = healthCheck.status === "healthy" ? 200 : 503;
        return reply.code(statusCode).send(healthCheck);
    });

    // Readiness probe (for Kubernetes/container orchestration)
    fastify.get("/ready", async (request, reply) => {
        try {
            // Check if database is accessible
            const client = await fastify.pg.connect();
            await client.query("SELECT 1");
            client.release();

            return reply.code(200).send({
                status: "ready",
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            fastify.log.error("Readiness check failed:", error.message);
            return reply.code(503).send({
                status: "not ready",
                error: "Database not accessible",
                timestamp: new Date().toISOString(),
            });
        }
    });

    // Liveness probe (for Kubernetes/container orchestration)
    fastify.get("/live", async (request, reply) => {
        return {
            status: "alive",
            timestamp: new Date().toISOString(),
            pid: process.pid,
        };
    });
}

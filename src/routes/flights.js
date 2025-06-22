//

// Flight data API routes for ForceFlow UK
export default async function flightRoutes(fastify, options) {
    // Get recent flight data (requires authentication)
    fastify.get(
        "/recent",
        {
            preHandler: fastify.authenticate,
            schema: {
                querystring: {
                    type: "object",
                    properties: {
                        minutes: {
                            type: "integer",
                            minimum: 1,
                            maximum: 1440,
                            default: 15,
                        },
                        limit: {
                            type: "integer",
                            minimum: 1,
                            maximum: 1000,
                            default: 100,
                        },
                        military_only: { type: "boolean", default: true },
                    },
                },
                response: {
                    200: {
                        type: "object",
                        properties: {
                            data: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        code: { type: "string" },
                                        callsign: { type: ["string", "null"] },
                                        timestamp: { type: "string" },
                                        lat: { type: "number" },
                                        lon: { type: "number" },
                                        altitude: { type: ["number", "null"] },
                                        velocity: { type: ["number", "null"] },
                                        heading: { type: ["number", "null"] },
                                    },
                                },
                            },
                            metadata: {
                                type: "object",
                                properties: {
                                    count: { type: "integer" },
                                    timeRange: { type: "string" },
                                    lastUpdate: { type: "string" },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const {
                minutes = 15,
                limit = 100,
                military_only = true,
            } = request.query;

            try {
                const client = await fastify.pg.connect();

                // Query recent flight events with optional military filtering
                let query = `
                SELECT 
                    a.code,
                    a.callsign,
                    fe.ts as timestamp,
                    fe.lat,
                    fe.lon,
                    fe.alt as altitude,
                    fe.velocity,
                    fe.heading,
                    fe.on_ground
                FROM flight_events fe
                JOIN assets a ON fe.asset_id = a.id
                WHERE fe.ts > NOW() - INTERVAL '${minutes} minutes'
            `;

                // Add military filtering if requested
                if (military_only) {
                    query += ` AND (
                    a.code LIKE '43C%' OR  -- RAF aircraft hex codes
                    a.code LIKE '400%' OR  -- UK military ranges
                    a.callsign LIKE 'RRR%' OR  -- RAF callsigns
                    a.callsign LIKE 'ASCOT%' OR -- RAF transport
                    a.callsign LIKE 'KNIFE%' OR -- RAF training
                    a.callsign LIKE 'TARTAN%'   -- Scottish aircraft
                )`;
                }

                query += `
                ORDER BY fe.ts DESC
                LIMIT $1
            `;

                const result = await client.query(query, [limit]);
                client.release();

                return {
                    data: result.rows.map((row) => ({
                        code: row.code,
                        callsign: row.callsign,
                        timestamp: row.timestamp.toISOString(),
                        lat: parseFloat(row.lat),
                        lon: parseFloat(row.lon),
                        altitude: row.altitude,
                        velocity: row.velocity,
                        heading: row.heading,
                        onGround: row.on_ground,
                    })),
                    metadata: {
                        count: result.rows.length,
                        timeRange: `${minutes} minutes`,
                        lastUpdate: new Date().toISOString(),
                        militaryOnly: military_only,
                    },
                };
            } catch (error) {
                fastify.log.error("Failed to fetch recent flights:", error);
                return reply.code(500).send({
                    code: "ERR_DATABASE_QUERY",
                    message: "Failed to retrieve flight data",
                });
            }
        },
    );

    // Get flight tracks for a specific aircraft
    fastify.get(
        "/track/:code",
        {
            preHandler: fastify.authenticate,
            schema: {
                params: {
                    type: "object",
                    properties: {
                        code: { type: "string" },
                    },
                    required: ["code"],
                },
                querystring: {
                    type: "object",
                    properties: {
                        hours: {
                            type: "integer",
                            minimum: 1,
                            maximum: 72,
                            default: 24,
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { code } = request.params;
            const { hours = 24 } = request.query;

            try {
                const client = await fastify.pg.connect();

                const result = await client.query(
                    `
                SELECT 
                    fe.ts as timestamp,
                    fe.lat,
                    fe.lon,
                    fe.alt as altitude,
                    fe.velocity,
                    fe.heading,
                    fe.on_ground
                FROM flight_events fe
                JOIN assets a ON fe.asset_id = a.id
                WHERE a.code = $1 
                  AND fe.ts > NOW() - INTERVAL '${hours} hours'
                ORDER BY fe.ts ASC
            `,
                    [code.toUpperCase()],
                );

                client.release();

                if (result.rows.length === 0) {
                    return reply.code(404).send({
                        code: "ERR_NOT_FOUND",
                        message: `No flight data found for aircraft ${code}`,
                    });
                }

                return {
                    aircraft: code.toUpperCase(),
                    track: result.rows.map((row) => ({
                        timestamp: row.timestamp.toISOString(),
                        lat: parseFloat(row.lat),
                        lon: parseFloat(row.lon),
                        altitude: row.altitude,
                        velocity: row.velocity,
                        heading: row.heading,
                        onGround: row.on_ground,
                    })),
                    metadata: {
                        pointCount: result.rows.length,
                        timeRange: `${hours} hours`,
                        firstPoint: result.rows[0].timestamp.toISOString(),
                        lastPoint:
                            result.rows[
                                result.rows.length - 1
                            ].timestamp.toISOString(),
                    },
                };
            } catch (error) {
                fastify.log.error("Failed to fetch flight track:", error);
                return reply.code(500).send({
                    code: "ERR_DATABASE_QUERY",
                    message: "Failed to retrieve flight track",
                });
            }
        },
    );

    // Get live flight statistics
    fastify.get(
        "/stats",
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            try {
                const client = await fastify.pg.connect();

                // Get current flight counts and statistics
                const stats = await client.query(`
                SELECT 
                    COUNT(*) as total_aircraft,
                    COUNT(CASE WHEN fe.on_ground = false THEN 1 END) as airborne,
                    COUNT(CASE WHEN fe.on_ground = true THEN 1 END) as on_ground,
                    AVG(fe.alt) FILTER (WHERE fe.alt > 0 AND fe.on_ground = false) as avg_altitude,
                    MAX(fe.velocity) as max_velocity,
                    COUNT(CASE WHEN a.callsign LIKE 'RRR%' THEN 1 END) as raf_aircraft,
                    COUNT(CASE WHEN fe.ts > NOW() - INTERVAL '5 minutes' THEN 1 END) as active_last_5min
                FROM flight_events fe
                JOIN assets a ON fe.asset_id = a.id
                WHERE fe.ts > NOW() - INTERVAL '15 minutes'
            `);

                client.release();

                const row = stats.rows[0];

                return {
                    timestamp: new Date().toISOString(),
                    aircraft: {
                        total: parseInt(row.total_aircraft),
                        airborne: parseInt(row.airborne),
                        onGround: parseInt(row.on_ground),
                        activeLast5Min: parseInt(row.active_last_5min),
                        rafAircraft: parseInt(row.raf_aircraft),
                    },
                    metrics: {
                        averageAltitude: row.avg_altitude
                            ? Math.round(row.avg_altitude)
                            : null,
                        maxVelocity: row.max_velocity
                            ? Math.round(row.max_velocity)
                            : null,
                    },
                };
            } catch (error) {
                fastify.log.error("Failed to fetch flight statistics:", error);
                return reply.code(500).send({
                    code: "ERR_DATABASE_QUERY",
                    message: "Failed to retrieve flight statistics",
                });
            }
        },
    );
}

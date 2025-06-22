//

// Tempo Index routes for ForceFlow UK
export default async function tempoRoutes(fastify, options) {
    // Get current tempo index (public endpoint)
    fastify.get(
        "/index",
        {
            schema: {
                response: {
                    200: {
                        type: "object",
                        properties: {
                            current: {
                                type: "object",
                                properties: {
                                    score: { type: "number" },
                                    timestamp: { type: "string" },
                                    status: { type: "string" },
                                    drivers: { type: "object" },
                                },
                            },
                            trend: {
                                type: "object",
                                properties: {
                                    change24h: { type: "number" },
                                    change7d: { type: "number" },
                                    direction: { type: "string" },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            try {
                const client = await fastify.pg.connect();

                // Get latest tempo score
                const currentResult = await client.query(`
                SELECT score, ts, drivers, 
                       flight_count, ship_count, notam_count, exercise_count
                FROM tempo_scores 
                ORDER BY ts DESC 
                LIMIT 1
            `);

                if (currentResult.rows.length === 0) {
                    client.release();
                    // Return default values if no data yet
                    return {
                        current: {
                            score: 50.0,
                            timestamp: new Date().toISOString(),
                            status: "normal",
                            drivers: {
                                flights: 0,
                                ships: 0,
                                notams: 0,
                                exercises: 0,
                            },
                        },
                        trend: {
                            change24h: 0,
                            change7d: 0,
                            direction: "stable",
                        },
                    };
                }

                const current = currentResult.rows[0];

                // Get scores for trend calculation
                const trendResult = await client.query(`
                SELECT 
                    AVG(CASE WHEN ts > NOW() - INTERVAL '24 hours' THEN score END) as avg_24h,
                    AVG(CASE WHEN ts > NOW() - INTERVAL '7 days' THEN score END) as avg_7d,
                    AVG(CASE WHEN ts BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours' THEN score END) as avg_prev_24h,
                    AVG(CASE WHEN ts BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days' THEN score END) as avg_prev_7d
                FROM tempo_scores
                WHERE ts > NOW() - INTERVAL '14 days'
            `);

                client.release();

                const trend = trendResult.rows[0];

                // Calculate changes
                const change24h =
                    trend.avg_24h && trend.avg_prev_24h
                        ? parseFloat(
                              (trend.avg_24h - trend.avg_prev_24h).toFixed(2),
                          )
                        : 0;
                const change7d =
                    trend.avg_7d && trend.avg_prev_7d
                        ? parseFloat(
                              (trend.avg_7d - trend.avg_prev_7d).toFixed(2),
                          )
                        : 0;

                // Determine direction
                let direction = "stable";
                if (Math.abs(change24h) > 5) {
                    direction = change24h > 0 ? "increasing" : "decreasing";
                }

                // Determine status based on score
                let status = "normal";
                if (current.score >= 90) status = "very_high";
                else if (current.score >= 75) status = "high";
                else if (current.score >= 60) status = "elevated";
                else if (current.score <= 25) status = "low";

                return {
                    current: {
                        score: parseFloat(current.score),
                        timestamp: current.ts.toISOString(),
                        status,
                        drivers: current.drivers || {
                            flights: current.flight_count || 0,
                            ships: current.ship_count || 0,
                            notams: current.notam_count || 0,
                            exercises: current.exercise_count || 0,
                        },
                    },
                    trend: {
                        change24h,
                        change7d,
                        direction,
                    },
                };
            } catch (error) {
                fastify.log.error("Failed to fetch tempo index:", error);
                return reply.code(500).send({
                    code: "ERR_TEMPO_FETCH_FAILED",
                    message: "Failed to retrieve tempo index",
                });
            }
        },
    );

    // Get tempo history (requires authentication)
    fastify.get(
        "/history",
        {
            preHandler: fastify.authenticate,
            schema: {
                querystring: {
                    type: "object",
                    properties: {
                        days: {
                            type: "integer",
                            minimum: 1,
                            maximum: 90,
                            default: 7,
                        },
                        resolution: {
                            type: "string",
                            enum: ["hour", "day"],
                            default: "hour",
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { days = 7, resolution = "hour" } = request.query;

            try {
                const client = await fastify.pg.connect();

                // Build query based on resolution
                let timeFormat =
                    resolution === "day"
                        ? "date_trunc('day', ts)"
                        : "date_trunc('hour', ts)";

                const result = await client.query(`
                SELECT 
                    ${timeFormat} as period,
                    AVG(score) as avg_score,
                    MIN(score) as min_score,
                    MAX(score) as max_score,
                    SUM(flight_count) as total_flights,
                    SUM(ship_count) as total_ships,
                    SUM(notam_count) as total_notams,
                    SUM(exercise_count) as total_exercises
                FROM tempo_scores
                WHERE ts > NOW() - INTERVAL '${days} days'
                GROUP BY ${timeFormat}
                ORDER BY period ASC
            `);

                client.release();

                return {
                    timeRange: `${days} days`,
                    resolution,
                    data: result.rows.map((row) => ({
                        timestamp: row.period.toISOString(),
                        score: {
                            average: parseFloat(row.avg_score?.toFixed(2) || 0),
                            minimum: parseFloat(row.min_score?.toFixed(2) || 0),
                            maximum: parseFloat(row.max_score?.toFixed(2) || 0),
                        },
                        activity: {
                            flights: parseInt(row.total_flights || 0),
                            ships: parseInt(row.total_ships || 0),
                            notams: parseInt(row.total_notams || 0),
                            exercises: parseInt(row.total_exercises || 0),
                        },
                    })),
                };
            } catch (error) {
                fastify.log.error("Failed to fetch tempo history:", error);
                return reply.code(500).send({
                    code: "ERR_TEMPO_HISTORY_FAILED",
                    message: "Failed to retrieve tempo history",
                });
            }
        },
    );

    // Calculate current tempo score (internal/manual trigger)
    fastify.post(
        "/calculate",
        {
            preHandler: [
                fastify.authenticate,
                fastify.authorize(["admin", "analyst"]),
            ],
        },
        async (request, reply) => {
            try {
                const client = await fastify.pg.connect();

                // Get current activity counts for the last hour
                const now = new Date();
                const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

                // Count recent flights
                const flightResult = await client.query(
                    `
                SELECT COUNT(*) as count
                FROM flight_events
                WHERE ts > $1
            `,
                    [hourAgo],
                );

                // Count recent ships (noting 72h AIS delay)
                const shipResult = await client.query(
                    `
                SELECT COUNT(*) as count
                FROM ship_events
                WHERE ts > $1
            `,
                    [new Date(now.getTime() - 72 * 60 * 60 * 1000)],
                ); // 72 hours ago

                // Count active NOTAMs
                const notamResult = await client.query(
                    `
                SELECT COUNT(*) as count
                FROM notams
                WHERE ts_start <= $1 AND (ts_end IS NULL OR ts_end >= $1)
            `,
                    [now],
                );

                // Count active exercises
                const exerciseResult = await client.query(
                    `
                SELECT COUNT(*) as count
                FROM exercises
                WHERE ts_start <= $1 AND (ts_end IS NULL OR ts_end >= $1)
            `,
                    [now],
                );

                const flightCount = parseInt(flightResult.rows[0].count);
                const shipCount = parseInt(shipResult.rows[0].count);
                const notamCount = parseInt(notamResult.rows[0].count);
                const exerciseCount = parseInt(exerciseResult.rows[0].count);

                // Simple scoring algorithm (will be replaced with ML model in Phase 4)
                // Based on historical averages and standard deviations
                const baselineFlights = 50; // typical hourly flight count
                const baselineShips = 20;
                const baselineNotams = 10;
                const baselineExercises = 2;

                // Calculate z-scores and weighted sum
                const flightScore = Math.max(
                    0,
                    ((flightCount - baselineFlights) / baselineFlights) * 100,
                );
                const shipScore = Math.max(
                    0,
                    ((shipCount - baselineShips) / baselineShips) * 100,
                );
                const notamScore = Math.max(
                    0,
                    ((notamCount - baselineNotams) / baselineNotams) * 100,
                );
                const exerciseScore = Math.max(
                    0,
                    ((exerciseCount - baselineExercises) / baselineExercises) *
                        100,
                );

                // Weighted composite score
                const compositeScore = Math.min(
                    100,
                    flightScore * 0.4 +
                        shipScore * 0.2 +
                        notamScore * 0.3 +
                        exerciseScore * 0.1 +
                        50, // baseline score
                );

                // Store the score
                const hourTimestamp = new Date(
                    Math.floor(now.getTime() / (60 * 60 * 1000)) *
                        (60 * 60 * 1000),
                );

                await client.query(
                    `
                INSERT INTO tempo_scores (ts, score, drivers, flight_count, ship_count, notam_count, exercise_count)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (ts) DO UPDATE SET
                    score = EXCLUDED.score,
                    drivers = EXCLUDED.drivers,
                    flight_count = EXCLUDED.flight_count,
                    ship_count = EXCLUDED.ship_count,
                    notam_count = EXCLUDED.notam_count,
                    exercise_count = EXCLUDED.exercise_count
            `,
                    [
                        hourTimestamp,
                        compositeScore.toFixed(2),
                        JSON.stringify({
                            flight_score: flightScore.toFixed(2),
                            ship_score: shipScore.toFixed(2),
                            notam_score: notamScore.toFixed(2),
                            exercise_score: exerciseScore.toFixed(2),
                        }),
                        flightCount,
                        shipCount,
                        notamCount,
                        exerciseCount,
                    ],
                );

                client.release();

                return {
                    message: "Tempo score calculated successfully",
                    timestamp: hourTimestamp.toISOString(),
                    score: parseFloat(compositeScore.toFixed(2)),
                    components: {
                        flights: {
                            count: flightCount,
                            score: parseFloat(flightScore.toFixed(2)),
                        },
                        ships: {
                            count: shipCount,
                            score: parseFloat(shipScore.toFixed(2)),
                        },
                        notams: {
                            count: notamCount,
                            score: parseFloat(notamScore.toFixed(2)),
                        },
                        exercises: {
                            count: exerciseCount,
                            score: parseFloat(exerciseScore.toFixed(2)),
                        },
                    },
                };
            } catch (error) {
                fastify.log.error("Failed to calculate tempo score:", error);
                return reply.code(500).send({
                    code: "ERR_TEMPO_CALCULATION_FAILED",
                    message: "Failed to calculate tempo score",
                });
            }
        },
    );
}

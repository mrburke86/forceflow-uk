// OpenSky Network data ingestion service for ForceFlow UK
// Based on PRD: Live Flight Layer using OpenSky Network API

import axios from "axios";
import cron from "node-cron";

class OpenSkyService {
    constructor(fastify) {
        this.fastify = fastify;
        this.baseUrl =
            process.env.OPENSKY_BASE_URL || "https://opensky-network.org/api";
        this.username = process.env.OPENSKY_USERNAME;
        this.password = process.env.OPENSKY_PASSWORD;
        this.isRunning = false;

        // UK bounding box for filtering (approximate)
        this.ukBounds = {
            lamin: 49.5, // Southern England
            lamax: 61.0, // Northern Scotland
            lomin: -11.0, // Western Ireland
            lomax: 2.0, // Eastern England
        };

        // RAF/Military aircraft hex code patterns
        this.militaryPatterns = [
            /^43C/, // RAF aircraft
            /^400/, // UK military ranges
            /^ADF8/, // Some RAF aircraft
            /^ADF9/, // Some RAF aircraft
        ];

        // Military callsign patterns
        this.militaryCallsigns = [
            /^RRR/, // RAF callsigns
            /^ASCOT/, // RAF transport
            /^KNIFE/, // RAF training
            /^TARTAN/, // Scottish aircraft
            /^RESCUE/, // Search and rescue
            /^ROYAL/, // Royal flights
        ];
    }

    // Check if aircraft is likely military based on hex code or callsign
    isMilitaryAircraft(hexCode, callsign) {
        if (hexCode) {
            const hex = hexCode.toUpperCase();
            if (this.militaryPatterns.some((pattern) => pattern.test(hex))) {
                return true;
            }
        }

        if (callsign) {
            const cs = callsign.toUpperCase();
            if (this.militaryCallsigns.some((pattern) => pattern.test(cs))) {
                return true;
            }
        }

        return false;
    }

    // Fetch current aircraft states from OpenSky
    async fetchStates() {
        try {
            const url = `${this.baseUrl}/states/all`;
            const params = {
                lamin: this.ukBounds.lamin,
                lamax: this.ukBounds.lamax,
                lomin: this.ukBounds.lomin,
                lomax: this.ukBounds.lomax,
            };

            const config = {
                params,
                timeout: 30000, // 30 second timeout
                headers: {
                    "User-Agent": "ForceFlow-UK/1.0",
                },
            };

            // Add authentication if provided
            if (this.username && this.password) {
                config.auth = {
                    username: this.username,
                    password: this.password,
                };
            }

            this.fastify.log.info("Fetching aircraft states from OpenSky...");
            const response = await axios.get(url, config);

            if (!response.data || !response.data.states) {
                this.fastify.log.warn("No states data received from OpenSky");
                return [];
            }

            const states = response.data.states;
            this.fastify.log.info(
                `Received ${states.length} aircraft states from OpenSky`,
            );

            return states;
        } catch (error) {
            if (error.response) {
                this.fastify.log.error(
                    `OpenSky API error: ${error.response.status} - ${error.response.statusText}`,
                );
                if (error.response.status === 429) {
                    this.fastify.log.warn(
                        "OpenSky rate limit exceeded, backing off...",
                    );
                }
            } else if (error.request) {
                this.fastify.log.error(
                    "No response from OpenSky API:",
                    error.message,
                );
            } else {
                this.fastify.log.error(
                    "OpenSky request setup error:",
                    error.message,
                );
            }
            throw error;
        }
    }

    // Process and store aircraft states
    async processStates(states) {
        if (!states || states.length === 0) {
            return;
        }

        const client = await this.fastify.pg.connect();
        let processed = 0;
        let militaryCount = 0;

        try {
            await client.query("BEGIN");

            for (const state of states) {
                try {
                    // OpenSky state vector format:
                    // [icao24, callsign, origin_country, time_position, last_contact,
                    //  longitude, latitude, baro_altitude, on_ground, velocity,
                    //  true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source]

                    const [
                        icao24,
                        callsign,
                        originCountry,
                        timePosition,
                        lastContact,
                        longitude,
                        latitude,
                        baroAltitude,
                        onGround,
                        velocity,
                        trueTrack,
                        verticalRate,
                        sensors,
                        geoAltitude,
                        squawk,
                        spi,
                        positionSource,
                    ] = state;

                    // Skip if no position data
                    if (!latitude || !longitude || !icao24) {
                        continue;
                    }

                    // Check if this is a military aircraft
                    const isMilitary = this.isMilitaryAircraft(
                        icao24,
                        callsign,
                    );

                    // For now, only process military aircraft (as per PRD focus)
                    if (!isMilitary) {
                        continue;
                    }

                    militaryCount++;

                    // Find or create asset
                    let asset = await client.query(
                        "SELECT id FROM assets WHERE code = $1",
                        [icao24.toUpperCase()],
                    );

                    let assetId;
                    if (asset.rows.length === 0) {
                        // Create new asset
                        const newAsset = await client.query(
                            `
                            INSERT INTO assets (type, code, callsign, country_code)
                            VALUES ('aircraft', $1, $2, $3)
                            RETURNING id
                        `,
                            [
                                icao24.toUpperCase(),
                                callsign?.trim() || null,
                                originCountry,
                            ],
                        );
                        assetId = newAsset.rows[0].id;
                    } else {
                        assetId = asset.rows[0].id;

                        // Update callsign if changed
                        if (callsign && callsign.trim()) {
                            await client.query(
                                "UPDATE assets SET callsign = $1, updated_at = NOW() WHERE id = $2",
                                [callsign.trim(), assetId],
                            );
                        }
                    }

                    // Insert flight event (use lastContact as timestamp)
                    const timestamp = new Date(lastContact * 1000);

                    await client.query(
                        `
                        INSERT INTO flight_events 
                        (asset_id, ts, lat, lon, alt, velocity, heading, vertical_rate, on_ground)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (asset_id, ts) DO UPDATE SET
                            lat = EXCLUDED.lat,
                            lon = EXCLUDED.lon,
                            alt = EXCLUDED.alt,
                            velocity = EXCLUDED.velocity,
                            heading = EXCLUDED.heading,
                            vertical_rate = EXCLUDED.vertical_rate,
                            on_ground = EXCLUDED.on_ground
                    `,
                        [
                            assetId,
                            timestamp,
                            latitude,
                            longitude,
                            baroAltitude, // altitude in meters, convert if needed
                            velocity, // velocity in m/s
                            trueTrack, // heading in degrees
                            verticalRate, // vertical rate in m/s
                            onGround || false,
                        ],
                    );

                    processed++;
                } catch (stateError) {
                    this.fastify.log.error(
                        "Error processing aircraft state:",
                        stateError,
                    );
                    // Continue processing other states
                }
            }

            await client.query("COMMIT");

            this.fastify.log.info(
                `Processed ${processed} flight events (${militaryCount} military aircraft) from ${states.length} total states`,
            );
        } catch (error) {
            await client.query("ROLLBACK");
            this.fastify.log.error("Failed to process aircraft states:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Main ingestion function
    async ingestData() {
        if (this.isRunning) {
            this.fastify.log.warn(
                "OpenSky ingestion already running, skipping...",
            );
            return;
        }

        this.isRunning = true;

        try {
            const states = await this.fetchStates();
            await this.processStates(states);
        } catch (error) {
            this.fastify.log.error("OpenSky data ingestion failed:", error);
        } finally {
            this.isRunning = false;
        }
    }

    // Start the scheduled ingestion
    start() {
        this.fastify.log.info("Starting OpenSky data ingestion service...");

        // Run every 10 seconds (respecting OpenSky rate limits)
        cron.schedule("*/10 * * * * *", async () => {
            await this.ingestData();
        });

        // Run initial ingestion
        setTimeout(() => {
            this.ingestData();
        }, 5000); // Wait 5 seconds after startup

        this.fastify.log.info(
            "OpenSky ingestion service started (every 10 seconds)",
        );
    }

    // Stop the service
    stop() {
        this.isRunning = false;
        this.fastify.log.info("OpenSky ingestion service stopped");
    }

    // Get service status
    getStatus() {
        return {
            service: "OpenSky Network",
            running: this.isRunning,
            lastRun: this.lastRun || null,
            configured: !!(this.username && this.password),
            bounds: this.ukBounds,
        };
    }
}

export default OpenSkyService;

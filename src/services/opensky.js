import axios from "axios";
import cron from "node-cron";

class OpenSkyService {
    constructor(fastify) {
        this.fastify = fastify;
        this.baseUrl =
            process.env.OPENSKY_BASE_URL || "https://opensky-network.org/api";

        // ✅ ADDED: OAuth2 authentication URL
        this.authUrl =
            "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

        // ✅ ADDED: OAuth2 credentials from environment
        this.clientId = process.env.OPENSKY_CLIENT_ID;
        this.clientSecret = process.env.OPENSKY_CLIENT_SECRET;

        this.username = process.env.OPENSKY_USERNAME;
        this.password = process.env.OPENSKY_PASSWORD;

        this.isRunning = false;

        // ✅ ADDED: OAuth2 token management properties
        this.accessToken = null;
        this.tokenExpiry = null;
        this.lastRun = null;

        this.ukBounds = {
            lamin: 49.5,
            lamax: 61.0,
            lomin: -11.0,
            lomax: 2.0,
        };

        this.militaryPatterns = [/^43C/, /^400/, /^ADF8/, /^ADF9/];

        this.militaryCallsigns = [
            /^RRR/,
            /^ASCOT/,
            /^KNIFE/,
            /^TARTAN/,
            /^RESCUE/,
            /^ROYAL/,
        ];

        // ✅ ADDED: Country name to ISO code mapping
        this.countryCodeMap = {
            "United Kingdom": "GB",
            Germany: "DE",
            France: "FR",
            Netherlands: "NL",
            Belgium: "BE",
            Switzerland: "CH",
            Austria: "AT",
            Italy: "IT",
            Spain: "ES",
            Poland: "PL",
            "Czech Republic": "CZ",
            Slovakia: "SK",
            Hungary: "HU",
            Slovenia: "SI",
            Croatia: "HR",
            Serbia: "RS",
            "Bosnia and Herzegovina": "BA",
            Montenegro: "ME",
            Albania: "AL",
            "North Macedonia": "MK",
            Bulgaria: "BG",
            Romania: "RO",
            Moldova: "MD",
            Ukraine: "UA",
            Belarus: "BY",
            Lithuania: "LT",
            Latvia: "LV",
            Estonia: "EE",
            Finland: "FI",
            Sweden: "SE",
            Norway: "NO",
            Denmark: "DK",
            Iceland: "IS",
            Ireland: "IE",
            Portugal: "PT",
            Luxembourg: "LU",
            Liechtenstein: "LI",
            Malta: "MT",
            Cyprus: "CY",
            Greece: "GR",
            Turkey: "TR",
            Russia: "RU",
            "United States": "US",
            Canada: "CA",
            Mexico: "MX",
        };
    }

    // ✅ ADDED: OAuth2 token management method
    async getAccessToken() {
        if (
            this.accessToken &&
            this.tokenExpiry &&
            Date.now() < this.tokenExpiry
        ) {
            return this.accessToken;
        }

        if (!this.clientId || !this.clientSecret) {
            this.fastify.log.warn(
                "No OpenSky OAuth2 credentials configured, using anonymous access",
            );
            return null;
        }

        try {
            this.fastify.log.info("Obtaining OpenSky OAuth2 access token...");

            const response = await axios.post(
                this.authUrl,
                new URLSearchParams({
                    grant_type: "client_credentials",
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                }),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    timeout: 10000,
                },
            );

            this.accessToken = response.data.access_token;
            this.tokenExpiry =
                Date.now() + (response.data.expires_in - 300) * 1000;

            this.fastify.log.info("OpenSky OAuth2 token obtained successfully");
            return this.accessToken;
        } catch (error) {
            this.fastify.log.error(
                "Failed to obtain OpenSky OAuth2 token:",
                error.message,
            );

            this.accessToken = null;
            this.tokenExpiry = null;

            throw error;
        }
    }

    // ✅ ADDED: Convert country name to ISO code
    getCountryCode(countryName) {
        if (!countryName) return null;

        // If it's already a 2-character code, return as-is
        if (countryName.length === 2) {
            return countryName.toUpperCase();
        }

        // Look up in mapping table
        const isoCode = this.countryCodeMap[countryName];
        if (isoCode) {
            return isoCode;
        }

        // Fallback: take first 2 characters
        return countryName.substring(0, 2).toUpperCase();
    }

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

    // ⚠️ MODIFIED: Enhanced authentication with OAuth2 support
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
                timeout: 30000,
                headers: {
                    "User-Agent": "ForceFlow-UK/1.0",
                },
            };

            // ⚠️ MODIFIED: Try OAuth2 first, then fallback
            try {
                const token = await this.getAccessToken();
                if (token) {
                    config.headers.Authorization = `Bearer ${token}`;
                    this.fastify.log.info(
                        "Using OpenSky OAuth2 authentication",
                    );
                }
            } catch (tokenError) {
                this.fastify.log.warn(
                    "OAuth2 token failed, falling back to basic auth or anonymous",
                );

                if (this.username && this.password) {
                    config.auth = {
                        username: this.username,
                        password: this.password,
                    };
                    this.fastify.log.info(
                        "Using OpenSky basic authentication (deprecated)",
                    );
                } else {
                    this.fastify.log.info(
                        "Using OpenSky anonymous access (limited rate)",
                    );
                }
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
                // ⚠️ MODIFIED: Enhanced error handling for OAuth2
                if (error.response.status === 401) {
                    this.fastify.log.error(
                        "OpenSky authentication failed - check credentials or token expiry",
                    );
                    this.accessToken = null;
                    this.tokenExpiry = null;
                } else if (error.response.status === 429) {
                    this.fastify.log.warn(
                        "OpenSky rate limit exceeded, backing off...",
                    );
                } else {
                    this.fastify.log.error(
                        `OpenSky API error: ${error.response.status} - ${error.response.statusText}`,
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

    // ✅ ADDED: Safe data conversion helper
    safeInteger(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === "number") return Math.round(value);
        if (typeof value === "string") {
            const parsed = parseFloat(value);
            return isNaN(parsed) ? null : Math.round(parsed);
        }
        return null;
    }

    // ✅ ADDED: Safe float conversion helper
    safeFloat(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === "number") return value;
        if (typeof value === "string") {
            const parsed = parseFloat(value);
            return isNaN(parsed) ? null : parsed;
        }
        return null;
    }

    // ⚠️ MODIFIED: Enhanced error handling with individual transactions
    async processStates(states) {
        if (!states || states.length === 0) {
            return;
        }

        const client = await this.fastify.pg.connect();
        let processed = 0;
        let militaryCount = 0;
        let errors = 0;

        try {
            // ⚠️ MODIFIED: Process each aircraft in its own transaction to prevent cascading failures
            for (const state of states) {
                // ⚠️ MODIFIED: Moved variable declarations outside try block
                let icao24, callsign, originCountry, timePosition, lastContact;
                let longitude, latitude, baroAltitude, onGround, velocity;
                let trueTrack,
                    verticalRate,
                    sensors,
                    geoAltitude,
                    squawk,
                    spi,
                    positionSource;

                try {
                    // ✅ ADDED: Individual transaction per aircraft
                    await client.query("BEGIN");

                    [
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

                    if (!latitude || !longitude || !icao24) {
                        await client.query("ROLLBACK");
                        continue;
                    }

                    const isMilitary = this.isMilitaryAircraft(
                        icao24,
                        callsign,
                    );

                    if (!isMilitary) {
                        await client.query("ROLLBACK");
                        continue;
                    }

                    militaryCount++;

                    // ✅ ADDED: Convert country name to ISO code
                    const countryCode = this.getCountryCode(originCountry);

                    let asset = await client.query(
                        "SELECT id FROM assets WHERE code = $1",
                        [icao24.toUpperCase()],
                    );

                    let assetId;
                    if (asset.rows.length === 0) {
                        const newAsset = await client.query(
                            `
                            INSERT INTO assets (type, code, callsign, country_code)
                            VALUES ('aircraft', $1, $2, $3)
                            RETURNING id
                        `,
                            [
                                icao24.toUpperCase(),
                                callsign?.trim() || null,
                                countryCode, // ⚠️ MODIFIED: Use converted country code
                            ],
                        );
                        assetId = newAsset.rows[0].id;
                    } else {
                        assetId = asset.rows[0].id;

                        if (callsign && callsign.trim()) {
                            await client.query(
                                "UPDATE assets SET callsign = $1, updated_at = NOW() WHERE id = $2",
                                [callsign.trim(), assetId],
                            );
                        }
                    }

                    // ✅ ADDED: Validate timestamp before creating Date
                    if (!lastContact || lastContact <= 0) {
                        this.fastify.log.warn(
                            `Invalid timestamp for aircraft ${icao24}: ${lastContact}`,
                        );
                        await client.query("ROLLBACK");
                        continue;
                    }

                    const timestamp = new Date(lastContact * 1000);

                    // ✅ ADDED: Validate timestamp is reasonable (not in future, not too old)
                    const now = Date.now();
                    const timestampMs = timestamp.getTime();
                    if (
                        timestampMs > now + 60000 ||
                        timestampMs < now - 86400000
                    ) {
                        // Allow 1 min future, 24h past
                        this.fastify.log.warn(
                            `Unreasonable timestamp for aircraft ${icao24}: ${timestamp.toISOString()}`,
                        );
                        await client.query("ROLLBACK");
                        continue;
                    }

                    // ✅ ADDED: Safe data conversion for all numeric fields
                    const safeAltitude = this.safeInteger(baroAltitude);
                    const safeVelocity = this.safeFloat(velocity);
                    const safeHeading = this.safeFloat(trueTrack);
                    const safeVerticalRate = this.safeFloat(verticalRate);
                    const safeLatitude = this.safeFloat(latitude);
                    const safeLongitude = this.safeFloat(longitude);

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
                            safeLatitude, // ⚠️ MODIFIED: Use safely converted values
                            safeLongitude,
                            safeAltitude,
                            safeVelocity,
                            safeHeading,
                            safeVerticalRate,
                            onGround || false,
                        ],
                    );

                    // ✅ ADDED: Commit individual transaction
                    await client.query("COMMIT");
                    processed++;
                } catch (stateError) {
                    // ✅ ADDED: Rollback individual transaction on error
                    try {
                        await client.query("ROLLBACK");
                    } catch (rollbackError) {
                        // Ignore rollback errors for already rolled back transactions
                    }

                    errors++;

                    // ⚠️ MODIFIED: Enhanced error logging with detailed information
                    this.fastify.log.error(
                        `Error processing aircraft ${icao24 || "unknown"}: ${
                            stateError.message || "Unknown error"
                        } (Code: ${stateError.code || "N/A"})`,
                    );
                    this.fastify.log.error(`Aircraft details:`, {
                        icao24: icao24 || "undefined",
                        callsign: callsign || "undefined",
                        originCountry: originCountry || "undefined",
                        countryCode: this.getCountryCode(originCountry),
                        timestamp: lastContact
                            ? new Date(lastContact * 1000).toISOString()
                            : "invalid",
                        altitude: baroAltitude,
                        velocity: velocity,
                        heading: trueTrack,
                        verticalRate: verticalRate,
                    });
                    if (stateError.stack) {
                        this.fastify.log.error(
                            `Stack trace: ${stateError.stack}`,
                        );
                    }

                    // ✅ ADDED: Continue with next aircraft instead of breaking
                    continue;
                }
            }

            this.fastify.log.info(
                `Processed ${processed} flight events (${militaryCount} military aircraft, ${errors} errors) from ${states.length} total states`,
            );
        } catch (error) {
            this.fastify.log.error("Failed to process aircraft states:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // ⚠️ MODIFIED: Added success tracking
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
            this.lastRun = new Date().toISOString(); // ✅ ADDED: Track successful runs
        } catch (error) {
            this.fastify.log.error("OpenSky data ingestion failed:", error);
        } finally {
            this.isRunning = false;
        }
    }

    start() {
        this.fastify.log.info("Starting OpenSky data ingestion service...");

        cron.schedule("*/10 * * * * *", async () => {
            await this.ingestData();
        });

        setTimeout(() => {
            this.ingestData();
        }, 5000);

        this.fastify.log.info(
            "OpenSky ingestion service started (every 10 seconds)",
        );
    }

    stop() {
        this.isRunning = false;
        this.fastify.log.info("OpenSky ingestion service stopped");
    }

    // ⚠️ MODIFIED: Enhanced status reporting with authentication details
    getStatus() {
        return {
            service: "OpenSky Network",
            running: this.isRunning,
            lastRun: this.lastRun || null,
            authentication: {
                oauth2_configured: !!(this.clientId && this.clientSecret),
                basic_auth_configured: !!(this.username && this.password),
                token_valid: !!(
                    this.accessToken &&
                    this.tokenExpiry &&
                    Date.now() < this.tokenExpiry
                ),
                method: this.accessToken
                    ? "oauth2"
                    : this.username
                    ? "basic_auth"
                    : "anonymous",
            },
            bounds: this.ukBounds,
        };
    }
}

export default OpenSkyService;

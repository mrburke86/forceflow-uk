-- src\db\schema.sql
-- ForceFlow UK Database Schema
-- Based on Backend Structure Document specifications

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- Asset types enum
CREATE TYPE asset_type AS ENUM ('aircraft', 'ship');

-- Core Assets table
CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type asset_type NOT NULL,
    code TEXT UNIQUE NOT NULL, -- hex code for aircraft, MMSI for ships
    callsign TEXT,
    name TEXT,
    country_code CHAR(2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index on type for filtering
CREATE INDEX idx_assets_type ON assets(type);
CREATE INDEX idx_assets_code ON assets(code);

-- Flight Events table (TimescaleDB hypertable)
CREATE TABLE flight_events (
    id UUID DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    alt INTEGER, -- altitude in feet
    velocity REAL, -- ground speed in knots
    heading REAL, -- true heading in degrees
    vertical_rate REAL, -- vertical rate in ft/min
    on_ground BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to hypertable (1 hour partitions)
SELECT create_hypertable('flight_events', 'ts', chunk_time_interval => INTERVAL '1 hour');

-- Composite unique constraint to prevent duplicates
ALTER TABLE flight_events ADD CONSTRAINT unique_flight_event 
UNIQUE (asset_id, ts);

-- Spatial and time indexes
CREATE INDEX idx_flight_events_asset_time ON flight_events(asset_id, ts DESC);
CREATE INDEX idx_flight_events_location ON flight_events USING GIST (ll_to_earth(lat, lon));
CREATE INDEX idx_flight_events_ts ON flight_events(ts DESC);

-- Ship Events table (TimescaleDB hypertable)
CREATE TABLE ship_events (
    id UUID DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sog REAL, -- speed over ground in knots
    cog REAL, -- course over ground in degrees
    heading REAL, -- true heading
    nav_status INTEGER, -- navigation status code
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to hypertable
SELECT create_hypertable('ship_events', 'ts', chunk_time_interval => INTERVAL '1 hour');

-- Composite unique constraint
ALTER TABLE ship_events ADD CONSTRAINT unique_ship_event 
UNIQUE (asset_id, ts);

-- Indexes
CREATE INDEX idx_ship_events_asset_time ON ship_events(asset_id, ts DESC);
CREATE INDEX idx_ship_events_location ON ship_events USING GIST (ll_to_earth(lat, lon));

-- NOTAMs table
CREATE TABLE notams (
    id TEXT PRIMARY KEY,
    ts_start TIMESTAMPTZ NOT NULL,
    ts_end TIMESTAMPTZ,
    title TEXT,
    description TEXT,
    category TEXT,
    geom GEOGRAPHY(POLYGON, 4326), -- spatial boundary
    source_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- BRIN index on time for efficient range queries
CREATE INDEX idx_notams_time_brin ON notams USING BRIN(ts_start, ts_end);
CREATE INDEX idx_notams_geom ON notams USING GIST(geom);

-- Exercise/Training Areas table
CREATE TABLE exercises (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    ts_start TIMESTAMPTZ NOT NULL,
    ts_end TIMESTAMPTZ,
    area_geom GEOGRAPHY(POLYGON, 4326),
    description TEXT,
    exercise_type TEXT,
    source_document TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exercises_time ON exercises(ts_start, ts_end);
CREATE INDEX idx_exercises_geom ON exercises USING GIST(area_geom);

-- Tempo Scores table (hourly aggregation)
CREATE TABLE tempo_scores (
    ts TIMESTAMPTZ PRIMARY KEY,
    score NUMERIC(5,2) NOT NULL,
    drivers JSONB, -- breakdown of contributing factors
    flight_count INTEGER DEFAULT 0,
    ship_count INTEGER DEFAULT 0,
    notam_count INTEGER DEFAULT 0,
    exercise_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to hypertable
SELECT create_hypertable('tempo_scores', 'ts', chunk_time_interval => INTERVAL '1 day');

-- User management tables
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    role TEXT DEFAULT 'viewer' CHECK (role IN ('viewer', 'analyst', 'admin')),
    api_key_hash TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_api_key ON users(api_key_hash);

-- Alert subscriptions
CREATE TABLE alert_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    webhook_url TEXT,
    email_enabled BOOLEAN DEFAULT true,
    threshold NUMERIC(5,2) DEFAULT 90.0,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Data retention policies (TimescaleDB compression and drop)
-- Compress data older than 30 days
SELECT add_compression_policy('flight_events', INTERVAL '30 days');
SELECT add_compression_policy('ship_events', INTERVAL '30 days');
SELECT add_compression_policy('tempo_scores', INTERVAL '30 days');

-- Drop data older than 2 years for tempo_scores
SELECT add_retention_policy('tempo_scores', INTERVAL '2 years');

-- Drop raw events older than 90 days (as per PRD requirements)
SELECT add_retention_policy('flight_events', INTERVAL '90 days');
SELECT add_retention_policy('ship_events', INTERVAL '90 days');

-- Views for common queries
CREATE VIEW recent_flights AS
SELECT 
    a.code,
    a.callsign,
    fe.ts,
    fe.lat,
    fe.lon,
    fe.alt,
    fe.velocity,
    fe.heading
FROM flight_events fe
JOIN assets a ON fe.asset_id = a.id
WHERE fe.ts > NOW() - INTERVAL '1 hour'
ORDER BY fe.ts DESC;

CREATE VIEW recent_ships AS
SELECT 
    a.code as mmsi,
    a.callsign,
    se.ts,
    se.lat,
    se.lon,
    se.sog,
    se.cog
FROM ship_events se
JOIN assets a ON se.asset_id = a.id
WHERE se.ts > NOW() - INTERVAL '1 hour'
ORDER BY se.ts DESC;
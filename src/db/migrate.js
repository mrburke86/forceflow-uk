// Database migration script for ForceFlow UK
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

async function runMigration() {
    const client = new Client({
        connectionString:
            process.env.DATABASE_URL ||
            "postgresql://postgres:password@localhost:5432/forceflow_uk",
    });

    try {
        console.log("🔌 Connecting to PostgreSQL...");
        await client.connect();

        console.log("📊 Checking database connection...");
        const result = await client.query("SELECT version()");
        console.log(
            "✅ Connected to:",
            result.rows[0].version.split(" ").slice(0, 2).join(" "),
        );

        // Check if TimescaleDB is available
        try {
            await client.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
            console.log("✅ TimescaleDB extension enabled");
        } catch (error) {
            console.log(
                "⚠️  TimescaleDB not available, continuing with regular PostgreSQL",
            );
        }

        // Check if PostGIS is available
        try {
            await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
            console.log("✅ PostGIS extension enabled");
        } catch (error) {
            console.log(
                "⚠️  PostGIS not available, some spatial features may not work",
            );
        }

        // Read and execute schema
        console.log("📋 Reading schema file...");
        const schemaPath = path.join(__dirname, "schema.sql");
        const schemaSql = fs.readFileSync(schemaPath, "utf8");

        console.log("🚀 Executing schema migration...");

        // Split by semicolon and execute each statement separately
        const statements = schemaSql
            .split(";")
            .map((stmt) => stmt.trim())
            .filter((stmt) => stmt.length > 0 && !stmt.startsWith("--"));

        for (const statement of statements) {
            if (statement.trim()) {
                try {
                    await client.query(statement);
                } catch (error) {
                    // Log but continue for non-critical errors
                    if (
                        error.message.includes("already exists") ||
                        error.message.includes("timescaledb") ||
                        error.message.includes("postgis")
                    ) {
                        console.log("⚠️ ", error.message.split("\n")[0]);
                    } else {
                        throw error;
                    }
                }
            }
        }

        console.log("✅ Schema migration completed successfully!");

        // Verify tables were created
        const tables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name
        `);

        console.log("📋 Created tables:");
        tables.rows.forEach((row) => {
            console.log(`   - ${row.table_name}`);
        });
    } catch (error) {
        console.error("❌ Migration failed:", error.message);
        process.exit(1);
    } finally {
        await client.end();
        console.log("🔌 Database connection closed");
    }
}

// Check if this script is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runMigration();
}

export default runMigration;

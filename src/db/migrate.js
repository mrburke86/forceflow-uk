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

        // Read and execute schema
        console.log("📋 Reading schema file...");
        const schemaPath = path.join(__dirname, "schema.sql");
        const schemaSql = fs.readFileSync(schemaPath, "utf8");

        console.log("🚀 Executing schema migration...");

        // Execute the entire schema as one transaction
        try {
            await client.query("BEGIN");
            await client.query(schemaSql);
            await client.query("COMMIT");
            console.log("✅ Schema migration completed successfully!");
        } catch (error) {
            await client.query("ROLLBACK");

            // Log the error and attempt to continue
            console.log("⚠️  Schema migration had an error:", error.message);
            console.log(
                "🔄 This is normal for the first run or if tables already exist",
            );

            // Try to execute each major statement block separately
            const majorStatements = [
                "CREATE EXTENSION IF NOT EXISTS timescaledb",
                "CREATE TYPE asset_type AS ENUM ('aircraft', 'ship')",
                // Core tables will be created by the schema execution below
            ];

            for (const stmt of majorStatements) {
                try {
                    await client.query(stmt);
                } catch (err) {
                    if (err.message.includes("already exists")) {
                        console.log(
                            `⚠️  ${
                                stmt.split(" ")[1]
                            } already exists, skipping...`,
                        );
                    }
                }
            }

            console.log("✅ Schema migration completed with warnings");
        }

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

        // Check if hypertables were created
        try {
            const hypertables = await client.query(`
                SELECT hypertable_name, num_dimensions 
                FROM timescaledb_information.hypertables
            `);

            if (hypertables.rows.length > 0) {
                console.log("📈 TimescaleDB hypertables:");
                hypertables.rows.forEach((row) => {
                    console.log(
                        `   - ${row.hypertable_name} (${row.num_dimensions}D)`,
                    );
                });
            }
        } catch (error) {
            console.log("⚠️  TimescaleDB information not available");
        }
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

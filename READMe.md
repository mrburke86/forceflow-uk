# ForceFlow UK - Phase 1: Core Foundation

**UK Military OSINT Dashboard - Backend API Foundation**

This is Phase 1 of ForceFlow UK, implementing the core backend infrastructure with PostgreSQL/TimescaleDB, Fastify API, and OpenSky flight data ingestion.

## 🏗️ Phase 1 Features

-   ✅ **PostgreSQL + TimescaleDB** database with military-focused schema
-   ✅ **Fastify 5 API** with JWT authentication and rate limiting
-   ✅ **OpenSky Network integration** for live UK military flight tracking
-   ✅ **Health monitoring** and service status endpoints
-   ✅ **Docker Compose** development environment
-   ✅ **Basic tempo index calculation** (simple algorithm, ML in Phase 4)

## 🚀 Quick Start

### Prerequisites

-   **Node.js 20+** (LTS recommended)
-   **Docker & Docker Compose**
-   **OpenSky Network account** (optional, for better rate limits)

### 1. Clone and Setup

```bash
git clone <repository-url>
cd forceflow-uk
cp .env.example .env
```

### 2. Configure Environment

Edit `.env` file:

```bash
# Required
DATABASE_URL=postgresql://postgres:password@localhost:5432/forceflow_uk

# Optional (for better OpenSky rate limits)
OPENSKY_USERNAME=your_username
OPENSKY_PASSWORD=your_password

# JWT Secret (change in production!)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
```

### 3. Start with Docker Compose

```bash
# Start core services
docker-compose up -d postgres redis

# Wait for database to be ready (30 seconds)
docker-compose logs postgres

# Start the API
docker-compose up api
```

### 4. Alternative: Local Development

```bash
# Install dependencies
npm install

# Start local PostgreSQL + Redis (via Docker)
docker-compose up -d postgres redis

# Run migrations
npm run db:migrate

# Start development server
npm run dev
```

## 🧪 Verification Commands

### Database Connection Test

```bash
# Test database connectivity
curl http://localhost:3000/health/detailed

# Expected response should show database: "healthy"
```

### API Authentication Test

```bash
# Register a test user
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@forceflow.uk",
    "password": "testpassword123",
    "role": "analyst"
  }'

# Save the returned token and test authenticated endpoint
TOKEN="<token-from-registration>"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/flights/recent
```

### OpenSky Data Ingestion Test

```bash
# Check service status
curl http://localhost:3000/api/v1/services/status

# Check for military flight data (may take 10-30 seconds after startup)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v1/flights/recent?minutes=60"

# Check flight statistics
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/flights/stats
```

### Tempo Index Test

```bash
# Get current tempo index (public endpoint)
curl http://localhost:3000/api/v1/tempo/index

# Manually trigger tempo calculation (requires analyst+ role)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/tempo/calculate
```

### Database Verification

```bash
# Connect to database directly
docker-compose exec postgres psql -U postgres -d forceflow_uk

# Check tables and recent data
\dt
SELECT COUNT(*) FROM flight_events;
SELECT COUNT(*) FROM assets WHERE type = 'aircraft';
SELECT * FROM tempo_scores ORDER BY ts DESC LIMIT 5;
```

## 📊 Expected Data Flow

1. **OpenSky Ingestion**: Every 10 seconds, the service fetches UK military aircraft
2. **Data Storage**: Flight events stored in TimescaleDB with automatic compression
3. **Tempo Calculation**: Hourly calculation based on activity levels
4. **API Access**: RESTful endpoints for flight data and tempo metrics

## 🐛 Troubleshooting

### No Flight Data Appearing

-   Check OpenSky service status: `curl http://localhost:3000/api/v1/services/status`
-   Verify UK military aircraft are currently flying (check during business hours GMT)
-   Check logs: `docker-compose logs api`

### Database Connection Issues

-   Ensure PostgreSQL is running: `docker-compose ps postgres`
-   Check database logs: `docker-compose logs postgres`
-   Verify connection string in `.env`

### Authentication Errors

-   Ensure JWT_SECRET is set in `.env`
-   Check token expiry (15 minutes default)
-   Use `/api/v1/auth/refresh` to get new token

## 📈 Next Steps (Phase 2)

Phase 1 provides the solid foundation. Phase 2 will add:

-   **React frontend** with Leaflet mapping
-   **Real-time WebSocket** updates
-   **Enhanced UI components** for analyst workflows

## 🔧 API Documentation

### Core Endpoints

-   `GET /health` - Basic health check
-   `GET /health/detailed` - Full system health
-   `POST /api/v1/auth/register` - User registration
-   `POST /api/v1/auth/login` - User login
-   `GET /api/v1/flights/recent` - Recent military flights
-   `GET /api/v1/tempo/index` - Current operational tempo

### Development URLs

-   **API**: http://localhost:3000
-   **pgAdmin** (optional): http://localhost:8080 (admin@forceflow.uk / admin)
-   **Redis Commander** (optional): http://localhost:8081

---

**📋 This completes Phase 1 - Core Foundation!**

The backend is now ready to ingest real military flight data and calculate basic operational tempo metrics. Ready for Phase 2 frontend development!

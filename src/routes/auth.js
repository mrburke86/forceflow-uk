//

// Authentication routes for ForceFlow UK
import bcrypt from "bcrypt";
import crypto from "crypto";

export default async function authRoutes(fastify, options) {
    // User registration (for development/admin setup)
    fastify.post(
        "/register",
        {
            schema: {
                body: {
                    type: "object",
                    required: ["email", "password"],
                    properties: {
                        email: { type: "string", format: "email" },
                        password: { type: "string", minLength: 8 },
                        role: {
                            type: "string",
                            enum: ["viewer", "analyst", "admin"],
                            default: "viewer",
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { email, password, role = "viewer" } = request.body;

            try {
                const client = await fastify.pg.connect();

                // Check if user already exists
                const existingUser = await client.query(
                    "SELECT id FROM users WHERE email = $1",
                    [email.toLowerCase()],
                );

                if (existingUser.rows.length > 0) {
                    client.release();
                    return reply.code(409).send({
                        code: "ERR_USER_EXISTS",
                        message: "User with this email already exists",
                    });
                }

                // Hash password
                const passwordHash = await bcrypt.hash(password, 12);

                // Generate API key
                const apiKey = crypto.randomBytes(32).toString("hex");
                const apiKeyHash = await bcrypt.hash(apiKey, 12);

                // Create user
                const result = await client.query(
                    `
                INSERT INTO users (email, password_hash, role, api_key_hash)
                VALUES ($1, $2, $3, $4)
                RETURNING id, email, role, created_at
            `,
                    [email.toLowerCase(), passwordHash, role, apiKeyHash],
                );

                client.release();

                const user = result.rows[0];

                // Generate JWT token
                const token = fastify.jwt.sign({
                    userId: user.id,
                    email: user.email,
                    role: user.role,
                });

                return {
                    message: "User created successfully",
                    user: {
                        id: user.id,
                        email: user.email,
                        role: user.role,
                        createdAt: user.created_at,
                    },
                    token,
                    apiKey, // Return API key only once
                };
            } catch (error) {
                fastify.log.error("Registration failed:", error);
                return reply.code(500).send({
                    code: "ERR_REGISTRATION_FAILED",
                    message: "Failed to create user account",
                });
            }
        },
    );

    // User login
    fastify.post(
        "/login",
        {
            schema: {
                body: {
                    type: "object",
                    required: ["email", "password"],
                    properties: {
                        email: { type: "string", format: "email" },
                        password: { type: "string" },
                    },
                },
            },
        },
        async (request, reply) => {
            const { email, password } = request.body;

            try {
                const client = await fastify.pg.connect();

                // Find user
                const result = await client.query(
                    `
                SELECT id, email, password_hash, role, last_login
                FROM users 
                WHERE email = $1
            `,
                    [email.toLowerCase()],
                );

                if (result.rows.length === 0) {
                    client.release();
                    return reply.code(401).send({
                        code: "ERR_INVALID_CREDENTIALS",
                        message: "Invalid email or password",
                    });
                }

                const user = result.rows[0];

                // Verify password
                const passwordValid = await bcrypt.compare(
                    password,
                    user.password_hash,
                );

                if (!passwordValid) {
                    client.release();
                    return reply.code(401).send({
                        code: "ERR_INVALID_CREDENTIALS",
                        message: "Invalid email or password",
                    });
                }

                // Update last login
                await client.query(
                    `
                UPDATE users 
                SET last_login = NOW()
                WHERE id = $1
            `,
                    [user.id],
                );

                client.release();

                // Generate JWT token
                const token = fastify.jwt.sign({
                    userId: user.id,
                    email: user.email,
                    role: user.role,
                });

                return {
                    message: "Login successful",
                    user: {
                        id: user.id,
                        email: user.email,
                        role: user.role,
                        lastLogin: user.last_login,
                    },
                    token,
                };
            } catch (error) {
                fastify.log.error("Login failed:", error);
                return reply.code(500).send({
                    code: "ERR_LOGIN_FAILED",
                    message: "Login failed",
                });
            }
        },
    );

    // Token refresh
    fastify.post(
        "/refresh",
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            try {
                // Generate new token with current user data
                const token = fastify.jwt.sign({
                    userId: request.user.userId,
                    email: request.user.email,
                    role: request.user.role,
                });

                return {
                    message: "Token refreshed successfully",
                    token,
                };
            } catch (error) {
                fastify.log.error("Token refresh failed:", error);
                return reply.code(500).send({
                    code: "ERR_TOKEN_REFRESH_FAILED",
                    message: "Failed to refresh token",
                });
            }
        },
    );

    // Get current user profile
    fastify.get(
        "/profile",
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            try {
                const client = await fastify.pg.connect();

                const result = await client.query(
                    `
                SELECT id, email, role, created_at, last_login
                FROM users 
                WHERE id = $1
            `,
                    [request.user.userId],
                );

                client.release();

                if (result.rows.length === 0) {
                    return reply.code(404).send({
                        code: "ERR_USER_NOT_FOUND",
                        message: "User not found",
                    });
                }

                const user = result.rows[0];

                return {
                    user: {
                        id: user.id,
                        email: user.email,
                        role: user.role,
                        createdAt: user.created_at,
                        lastLogin: user.last_login,
                    },
                };
            } catch (error) {
                fastify.log.error("Failed to fetch user profile:", error);
                return reply.code(500).send({
                    code: "ERR_PROFILE_FETCH_FAILED",
                    message: "Failed to retrieve user profile",
                });
            }
        },
    );

    // Generate new API key
    fastify.post(
        "/api-key",
        {
            preHandler: fastify.authenticate,
        },
        async (request, reply) => {
            try {
                const client = await fastify.pg.connect();

                // Generate new API key
                const apiKey = crypto.randomBytes(32).toString("hex");
                const apiKeyHash = await bcrypt.hash(apiKey, 12);

                // Update user's API key
                await client.query(
                    `
                UPDATE users 
                SET api_key_hash = $1
                WHERE id = $2
            `,
                    [apiKeyHash, request.user.userId],
                );

                client.release();

                return {
                    message: "API key generated successfully",
                    apiKey, // Return new API key only once
                };
            } catch (error) {
                fastify.log.error("API key generation failed:", error);
                return reply.code(500).send({
                    code: "ERR_API_KEY_GENERATION_FAILED",
                    message: "Failed to generate API key",
                });
            }
        },
    );
}

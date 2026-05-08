import pg from "pg"

const connectionString = process.env.DATABASE_URL

// RDS Postgres enforces SSL by default. Local Docker Postgres does not.
// Detect RDS by hostname and skip strict cert validation (good enough for capstone scale;
// for production, download the AWS RDS CA bundle and set ca + rejectUnauthorized: true).
const useSsl = !!connectionString && /\.rds\.amazonaws\.com/i.test(connectionString)

export const pool = connectionString
  ? new pg.Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false
    })
  : null

export async function query(text, params) {
  if (!pool) {
    throw new Error("DATABASE_URL is not set")
  }
  return pool.query(text, params)
}

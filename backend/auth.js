/**
 * JWT-based session tokens for HomeSense.
 *
 * Why JWT (and not DB-backed sessions)?
 *   - Stateless: no extra Postgres lookup per request → cheap on Fargate.
 *   - No new DB table to migrate.
 *   - Easy to invalidate naturally via short expiry; password change rotates
 *     the secret bucket only if needed (we keep it simple here).
 *
 * Trade-off acknowledged:
 *   - Tokens live in browser localStorage, so an XSS hole in the frontend
 *     would let an attacker steal them. The existing app already stores the
 *     user object in localStorage, so we are not making the surface worse.
 *   - We do NOT implement refresh tokens — a single 7-day token is enough for
 *     a capstone and simpler to reason about.
 *
 * The auth middleware checks two things:
 *   1. The token's signature is valid and it has not expired.
 *   2. The token's `sub` (user id) matches the `:userId` URL param.
 *      (Without this, user A with a valid token could read user B's data.)
 */

import jwt from "jsonwebtoken"

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const TOKEN_ISSUER = "homesense"
const TOKEN_AUDIENCE = "homesense-web"

/**
 * Resolve the signing secret. We refuse to run with a weak/missing secret in
 * production to avoid silently issuing forgeable tokens.
 *
 * Local dev: any non-empty string in backend/.env works.
 * Prod (ECS): set from SSM SecureString /senior-capstone/JWT_SECRET.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET || ""
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET is not set. Refusing to start the API without a signing secret in production."
      )
    }
    console.warn(
      "[auth] JWT_SECRET is not set; using a weak dev fallback. DO NOT ship this to production."
    )
    return "dev-only-insecure-jwt-secret-change-me"
  }
  if (secret.length < 32 && process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET is shorter than 32 characters. Use a strong random secret (>= 32 chars)."
    )
  }
  return secret
}

/**
 * Issue a JWT for a freshly authenticated user. We keep the payload tiny —
 * just `sub` (user id). Display name/email come from /api/users/:id/profile
 * after login; we don't bake them into the token so renames take effect
 * immediately without forcing a re-login.
 */
export function signToken(user) {
  if (!user || !Number.isFinite(Number(user.id))) {
    throw new Error("signToken requires a user with a numeric id")
  }
  return jwt.sign(
    {},
    getJwtSecret(),
    {
      subject: String(user.id),
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: TOKEN_TTL_SECONDS
    }
  )
}

/**
 * Verify a token and return the decoded payload (or null if invalid).
 * Never throws — callers should treat `null` as "not authenticated".
 */
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null
  try {
    return jwt.verify(token, getJwtSecret(), {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE
    })
  } catch {
    return null
  }
}

/**
 * Express middleware. Extracts the bearer token, verifies it, and ensures the
 * token's user id matches `:userId` in the URL.
 *
 * On any failure we return 401 — the frontend's `request()` wrapper turns
 * that into a localStorage wipe + redirect to /login.
 */
export function requireAuth(req, res, res_next) {
  // Support both express signatures: (req, res, next) and the rare
  // (req, res) call (e.g. when used as a sub-handler). Default to next.
  const next = typeof res_next === "function" ? res_next : () => {}

  const header = String(req.headers?.authorization || req.headers?.Authorization || "")
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return res.status(401).json({ message: "Missing or invalid Authorization header" })
  }
  const token = match[1].trim()
  const payload = verifyToken(token)
  if (!payload || !payload.sub) {
    return res.status(401).json({ message: "Invalid or expired session token" })
  }

  const tokenUserId = Number.parseInt(payload.sub, 10)
  if (!Number.isFinite(tokenUserId)) {
    return res.status(401).json({ message: "Malformed session token" })
  }

  // Critical check: even with a valid token, you can only act on your OWN
  // user id. Without this, a valid token for user 1 could read /api/users/2.
  const urlUserId = Number.parseInt(req.params?.userId, 10)
  if (Number.isFinite(urlUserId) && urlUserId !== tokenUserId) {
    return res.status(403).json({ message: "Not authorized for this user" })
  }

  // Stash on req so handlers can trust this is the authenticated user.
  req.auth = { userId: tokenUserId }
  return next()
}

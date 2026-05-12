/**
 * API client for the backend.
 * - Docker (nginx): leave VITE_API_URL unset → same-origin `/api/...` (nginx proxies to backend).
 * - `npm run dev`: Vite proxies `/api` to the backend; optional `.env` VITE_API_URL=http://localhost:3001
 *
 * Auth model: JWT in localStorage under `homesense_token`. Every request
 * automatically attaches it as `Authorization: Bearer <token>`. If the server
 * rejects with 401 (token missing / invalid / expired), we wipe localStorage
 * and bounce the user to /login so they can sign in again. The login &
 * register endpoints are exempt from the 401-bounce — those calls land you
 * on /login as a normal error.
 */
const rawBase = import.meta.env.VITE_API_URL
const API_BASE =
  rawBase !== undefined && rawBase !== null && String(rawBase).trim() !== ''
    ? String(rawBase).replace(/\/$/, '')
    : ''

const TOKEN_STORAGE_KEY = 'homesense_token'
const USER_STORAGE_KEY = 'homesense_user'

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function setStoredToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, String(token))
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    /* localStorage unavailable — best effort */
  }
}

export function clearStoredAuth() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    localStorage.removeItem(USER_STORAGE_KEY)
  } catch {
    /* best effort */
  }
}

function isAuthEndpoint(path) {
  return path === '/api/login' || path === '/api/register'
}

async function request(path, options = {}) {
  const url = API_BASE ? `${API_BASE}${path}` : path
  const token = getStoredToken()
  // Only attach the bearer token to non-auth endpoints. Login/register don't
  // need it and shouldn't trigger a 401-bounce on bad credentials.
  const authHeaders = token && !isAuthEndpoint(path) ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...options.headers },
    ...options,
  })
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return {} } })() : {}
  if (!res.ok) {
    // 401 on a protected endpoint means our session is no longer valid.
    // Wipe localStorage and send the user to /login (only when we're in a
    // browser context — guards against tests / SSR).
    if (res.status === 401 && !isAuthEndpoint(path)) {
      clearStoredAuth()
      // App.jsx routes "/" -> Login. Send the user there to re-authenticate.
      if (typeof window !== 'undefined' && window.location && window.location.pathname !== '/') {
        window.location.assign('/')
      }
    }
    throw new Error(data.message || `Request failed (${res.status})`)
  }
  return data
}

export async function login(email, password) {
  return request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function createAccount(email, password) {
  return request('/api/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function fetchDeviceOverview(userId) {
  return request(`/api/users/${userId}/devices/overview`)
}

export async function patchDevice(userId, deviceId, body) {
  return request(`/api/users/${userId}/devices/${deviceId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function fetchAlertHistory(userId, limit = 25) {
  return request(`/api/users/${userId}/alerts?limit=${limit}`)
}

export async function fetchDeviceReadings(userId, deviceId, limit = 60) {
  return request(`/api/users/${userId}/devices/${deviceId}/readings?limit=${limit}`)
}

export async function fetchDeviceTimeseries(
  userId,
  deviceId,
  { range = '1h', resolution = 'auto', metric = 'readings', limit } = {}
) {
  const params = new URLSearchParams()
  params.set('range', range)
  params.set('resolution', resolution)
  params.set('metric', metric)
  if (limit !== undefined && limit !== null) {
    params.set('limit', String(limit))
  }
  return request(`/api/users/${userId}/devices/${deviceId}/readings/timeseries?${params.toString()}`)
}

export async function fetchAgentInsights(userId, deviceId, body = {}) {
  return request(`/api/users/${userId}/devices/${deviceId}/agent/insights`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function fetchProfile(userId) {
  return request(`/api/users/${userId}/profile`)
}

export async function patchProfile(userId, body) {
  return request(`/api/users/${userId}/profile`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function patchPassword(userId, body) {
  return request(`/api/users/${userId}/password`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteAccount(userId, password) {
  return request(`/api/users/${userId}`, {
    method: 'DELETE',
    body: JSON.stringify({ password }),
  })
}

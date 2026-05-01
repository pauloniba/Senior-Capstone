/**
 * API client for the backend.
 * - Docker (nginx): leave VITE_API_URL unset → same-origin `/api/...` (nginx proxies to backend).
 * - `npm run dev`: Vite proxies `/api` to the backend; optional `.env` VITE_API_URL=http://localhost:3001
 */
const rawBase = import.meta.env.VITE_API_URL
const API_BASE =
  rawBase !== undefined && rawBase !== null && String(rawBase).trim() !== ''
    ? String(rawBase).replace(/\/$/, '')
    : ''

async function request(path, options = {}) {
  const url = API_BASE ? `${API_BASE}${path}` : path
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  const text = await res.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return {} } })() : {}
  if (!res.ok) {
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

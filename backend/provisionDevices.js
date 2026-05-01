/**
 * Default demo devices per user. device_uid = `${userId}-${suffix}` (globally unique).
 */
export const DEFAULT_DEVICE_TEMPLATES = [
  ["Attic humidity node", "dev-attic-01"],
  ["Basement moisture", "dev-basement-01"],
  ["Kitchen appliance health", "dev-kitchen-01"]
]

export function deviceUidForUser(userId, uidSuffix) {
  return `${userId}-${uidSuffix}`
}

/**
 * Insert the three template devices for this user (idempotent per device_uid).
 */
export async function provisionDefaultDevices(query, userId) {
  for (const [name, suffix] of DEFAULT_DEVICE_TEMPLATES) {
    const deviceUid = deviceUidForUser(userId, suffix)
    await query(
      `INSERT INTO devices (user_id, name, device_uid)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_uid) DO NOTHING`,
      [userId, name, deviceUid]
    )
  }

  await query(
    `INSERT INTO device_thresholds (device_id, sensor_type, warning_min, warning_max, critical_min, critical_max)
     SELECT
       d.id,
       CASE
         WHEN d.device_uid LIKE '%dev-attic-01' THEN 'temperature'
         WHEN d.device_uid LIKE '%dev-basement-01' THEN 'moisture'
         WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 'vibration'
         ELSE 'custom'
       END AS sensor_type,
       CASE
         WHEN d.device_uid LIKE '%dev-basement-01' THEN 28
         ELSE NULL
       END AS warning_min,
       CASE
         WHEN d.device_uid LIKE '%dev-attic-01' THEN 27
         WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 0.5
         ELSE NULL
       END AS warning_max,
       CASE
         WHEN d.device_uid LIKE '%dev-basement-01' THEN 20
         ELSE NULL
       END AS critical_min,
       CASE
         WHEN d.device_uid LIKE '%dev-attic-01' THEN 30
         WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 1
         ELSE NULL
       END AS critical_max
     FROM devices d
     WHERE d.user_id = $1
       AND (
         d.device_uid LIKE '%dev-attic-01'
         OR d.device_uid LIKE '%dev-basement-01'
         OR d.device_uid LIKE '%dev-kitchen-01'
       )
     ON CONFLICT (device_id, sensor_type) DO NOTHING`,
    [userId]
  )
}

/**
 * True if user has at least one device.
 */
export async function userHasDevices(query, userId) {
  const { rows } = await query(
    "SELECT 1 AS ok FROM devices WHERE user_id = $1 LIMIT 1",
    [userId]
  )
  return rows.length > 0
}

-- Home Sensor database (plain PostgreSQL — runs on RDS or local Postgres)
-- Runs once when the Postgres data volume is first created (docker-entrypoint-initdb.d).
-- If you change this file, reset the volume: docker compose down -v && docker compose up -d

CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL UNIQUE,
    password   VARCHAR(255) NOT NULL,
    first_name    VARCHAR(100),
    last_name     VARCHAR(100),
    display_name  VARCHAR(150),
    phone         VARCHAR(40),
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(150);

CREATE TABLE IF NOT EXISTS devices (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       VARCHAR(255) NOT NULL,
    device_uid VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices (user_id);

CREATE TABLE IF NOT EXISTS device_thresholds (
    id           SERIAL PRIMARY KEY,
    device_id    INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    sensor_type  VARCHAR(64) NOT NULL,
    warning_min  DOUBLE PRECISION,
    warning_max  DOUBLE PRECISION,
    critical_min DOUBLE PRECISION,
    critical_max DOUBLE PRECISION,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, sensor_type)
);

CREATE INDEX IF NOT EXISTS device_thresholds_device_idx
    ON device_thresholds (device_id);

CREATE TABLE IF NOT EXISTS sensor_readings (
    id          BIGSERIAL PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    sensor_type VARCHAR(64) NOT NULL,
    value       DOUBLE PRECISION NOT NULL,
    unit        VARCHAR(32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sensor_readings_device_time_idx
    ON sensor_readings (device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS sensor_readings_type_time_idx
    ON sensor_readings (sensor_type, recorded_at DESC);

-- Test account (password: password123) — bcrypt hash generated for bcryptjs
INSERT INTO users (email, password, first_name, last_name, display_name)
VALUES (
    'test@homesense.local',
    '$2b$10$.3FKziO02YYZgzh9toi9ee6crDMbVADnF3RdQ3Xc9xPQ08Py6wyAK',
    'Test',
    'User',
    'Test User'
)
ON CONFLICT (email) DO NOTHING;

UPDATE users
SET first_name = COALESCE(first_name, 'Test'),
    last_name = COALESCE(last_name, 'User'),
    display_name = COALESCE(NULLIF(TRIM(display_name), ''), 'Test User')
WHERE email = 'test@homesense.local';

-- device_uid is globally unique: {user_id}-{template_suffix}
INSERT INTO devices (user_id, name, device_uid)
SELECT u.id, v.name, (u.id::text || '-' || v.uid)
FROM users u
CROSS JOIN (VALUES
    ('Attic humidity node', 'dev-attic-01'),
    ('Basement moisture', 'dev-basement-01'),
    ('Kitchen appliance health', 'dev-kitchen-01')
) AS v(name, uid)
WHERE u.email = 'test@homesense.local'
ON CONFLICT (device_uid) DO NOTHING;

INSERT INTO device_thresholds (device_id, sensor_type, warning_min, warning_max, critical_min, critical_max)
SELECT
    d.id,
    CASE
        WHEN d.device_uid LIKE '%dev-attic-01' THEN 'temperature'
        WHEN d.device_uid LIKE '%dev-basement-01' THEN 'moisture'
        WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 'vibration'
        ELSE 'custom'
    END AS sensor_type,
    CASE
        WHEN d.device_uid LIKE '%dev-attic-01' THEN NULL
        WHEN d.device_uid LIKE '%dev-basement-01' THEN 28
        WHEN d.device_uid LIKE '%dev-kitchen-01' THEN NULL
        ELSE NULL
    END AS warning_min,
    CASE
        WHEN d.device_uid LIKE '%dev-attic-01' THEN 27
        WHEN d.device_uid LIKE '%dev-basement-01' THEN NULL
        WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 0.5
        ELSE NULL
    END AS warning_max,
    CASE
        WHEN d.device_uid LIKE '%dev-attic-01' THEN NULL
        WHEN d.device_uid LIKE '%dev-basement-01' THEN 20
        WHEN d.device_uid LIKE '%dev-kitchen-01' THEN NULL
        ELSE NULL
    END AS critical_min,
    CASE
        WHEN d.device_uid LIKE '%dev-attic-01' THEN 30
        WHEN d.device_uid LIKE '%dev-basement-01' THEN NULL
        WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 1
        ELSE NULL
    END AS critical_max
FROM devices d
WHERE d.device_uid LIKE '%dev-attic-01'
   OR d.device_uid LIKE '%dev-basement-01'
   OR d.device_uid LIKE '%dev-kitchen-01'
ON CONFLICT (device_id, sensor_type) DO NOTHING;

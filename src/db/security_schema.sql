-- ═══════════════════════════════════════════════════════════════
-- SugoNow — Security Schema Additions
-- Run: psql -U sugonow_user -d sugonow -f security_schema.sql
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. CASH DEPOSIT BOND
-- ─────────────────────────────────────────────
-- Each driver deposits a refundable bond before going live.
-- Commission from cash rides is deducted from this bond automatically.
-- Driver is paused when bond < low_water_mark.

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS bond_amount         NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS bond_status         VARCHAR(20)   NOT NULL DEFAULT 'unpaid'
    CHECK (bond_status IN ('unpaid','paid','paused','refunded')),
  ADD COLUMN IF NOT EXISTS bond_paid_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bond_gcash_ref      VARCHAR(200),
  ADD COLUMN IF NOT EXISTS cash_commission_owed NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS cash_wallet_balance  NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS daily_payout_total   NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS daily_payout_reset   DATE          NOT NULL DEFAULT CURRENT_DATE;

-- Bond transactions ledger
CREATE TABLE IF NOT EXISTS bond_transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id     UUID NOT NULL REFERENCES users(id),
  type          VARCHAR(30) NOT NULL
                CHECK (type IN ('deposit','commission_deduct','top_up','refund','penalty')),
  amount        NUMERIC(10,2) NOT NULL,  -- positive = credit, negative = debit
  balance_after NUMERIC(10,2) NOT NULL,
  note          TEXT,
  booking_id    UUID REFERENCES bookings(id),
  gcash_ref     VARCHAR(200),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bond_tx_driver ON bond_transactions(driver_id);
CREATE INDEX IF NOT EXISTS idx_bond_tx_type   ON bond_transactions(type);

-- ─────────────────────────────────────────────
-- 2. GPS MOVEMENT VERIFICATION
-- ─────────────────────────────────────────────
-- Stores GPS pings during active rides for fraud detection.
-- A ride cannot be completed unless movement is verified.

CREATE TABLE IF NOT EXISTS ride_gps_pings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  driver_id   UUID NOT NULL REFERENCES users(id),
  lat         NUMERIC(10,7) NOT NULL,
  lng         NUMERIC(10,7) NOT NULL,
  accuracy_m  NUMERIC(8,2),           -- GPS accuracy in metres
  speed_kmh   NUMERIC(6,2),           -- speed at ping time
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gps_pings_booking ON ride_gps_pings(booking_id);
CREATE INDEX IF NOT EXISTS idx_gps_pings_driver  ON ride_gps_pings(driver_id);

-- Add movement verification columns to bookings
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS gps_verified        BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_distance_km   NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS gps_ping_count      INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_photo_url VARCHAR(500),  -- photo taken at payment
  ADD COLUMN IF NOT EXISTS fraud_flag          BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fraud_reason        TEXT;

-- ─────────────────────────────────────────────
-- 3. DEVICE FINGERPRINTS (account takeover prevention)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  device_id       VARCHAR(200) NOT NULL,   -- unique device fingerprint
  device_model    VARCHAR(100),
  os_version      VARCHAR(50),
  app_version     VARCHAR(20),
  ip_address      VARCHAR(45),
  is_trusted      BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user   ON device_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_device_sessions_device ON device_sessions(device_id);

-- ─────────────────────────────────────────────
-- 4. FRAUD FLAGS LOG
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_flags (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id   UUID REFERENCES users(id),
  customer_id UUID REFERENCES users(id),
  booking_id  UUID REFERENCES bookings(id),
  flag_type   VARCHAR(50) NOT NULL,
  severity    VARCHAR(20) NOT NULL DEFAULT 'medium'
              CHECK (severity IN ('low','medium','high','critical')),
  details     TEXT,
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_driver ON fraud_flags(driver_id);

-- ─────────────────────────────────────────────
-- 5. CONSTANTS (configurable per zone)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_config (key, value, description) VALUES
  ('bond_required_amount',    '500',  'Cash deposit bond amount in PHP'),
  ('bond_low_water_mark',     '100',  'Pause driver when bond drops below this'),
  ('cash_commission_cap',     '200',  'Max unremitted commission before pausing cash rides'),
  ('daily_payout_limit',      '2000', 'Max payout per driver per day'),
  ('min_gps_pings_per_km',    '2',    'Minimum GPS pings per km to verify movement'),
  ('ghost_ride_min_distance', '0.2',  'Minimum distance km to accept ride completion'),
  ('jwt_expiry_hours',        '24',   'JWT token expiry in hours'),
  ('otp_daily_limit',         '10',   'Max OTPs per IP per day')
ON CONFLICT (key) DO NOTHING;

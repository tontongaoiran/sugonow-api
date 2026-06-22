-- SugoNow Database Schema
-- PostgreSQL 14+
-- Run: psql -U postgres -f schema.sql

-- Create database and user
CREATE DATABASE sugonow;
CREATE USER sugonow_user WITH PASSWORD 'your_strong_password_here';
GRANT ALL PRIVILEGES ON DATABASE sugonow TO sugonow_user;

\c sugonow

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
-- ZONES (Flora → Luna → Province-wide)
-- ─────────────────────────────────────────────
CREATE TABLE zones (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(100) NOT NULL,
  slug         VARCHAR(50)  NOT NULL UNIQUE,  -- 'flora', 'luna', 'province'
  base_fare    NUMERIC(8,2) NOT NULL DEFAULT 15.00,
  per_km_rate  NUMERIC(8,2) NOT NULL DEFAULT 5.00,
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Seed zones
INSERT INTO zones (name, slug, base_fare, per_km_rate, is_active) VALUES
  ('Flora, Apayao',       'flora',    15.00, 5.00, TRUE),
  ('Luna, Apayao',        'luna',     18.00, 6.00, FALSE),
  ('Province-wide, Apayao','province', 20.00, 7.00, FALSE);

-- ─────────────────────────────────────────────
-- USERS (customers + drivers share this table)
-- ─────────────────────────────────────────────
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name       VARCHAR(200) NOT NULL,
  email           VARCHAR(200) UNIQUE,
  mobile          VARCHAR(20)  NOT NULL UNIQUE,
  password_hash   VARCHAR(255),                -- NULL if social login
  role            VARCHAR(20)  NOT NULL CHECK (role IN ('customer','driver','admin')),
  zone_id         UUID REFERENCES zones(id),
  barangay        VARCHAR(100),
  profile_photo   VARCHAR(500),                -- public CDN URL
  emergency_name  VARCHAR(200),
  emergency_phone VARCHAR(20),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  mobile_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- DRIVER PROFILES (extends users where role='driver')
-- ─────────────────────────────────────────────
CREATE TABLE driver_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate_number    VARCHAR(20)  NOT NULL,
  vehicle_type    VARCHAR(50)  NOT NULL DEFAULT 'Tricycle',
  id_type         VARCHAR(50)  NOT NULL,         -- 'philsys', 'voters_id', etc.
  id_front_url    VARCHAR(500) NOT NULL,          -- private S3 URL
  id_back_url     VARCHAR(500) NOT NULL,          -- private S3 URL
  selfie_url      VARCHAR(500) NOT NULL,          -- private S3 URL
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','verified','rejected','suspended')),
  admin_note      TEXT,                           -- rejection reason
  rating          NUMERIC(3,2) DEFAULT 5.00,
  total_trips     INTEGER DEFAULT 0,
  total_earnings  NUMERIC(12,2) DEFAULT 0.00,
  is_online       BOOLEAN DEFAULT FALSE,
  current_lat     NUMERIC(10,7),
  current_lng     NUMERIC(10,7),
  reviewed_by     UUID REFERENCES users(id),     -- admin who approved/rejected
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- OTP VERIFICATION
-- ─────────────────────────────────────────────
CREATE TABLE otp_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mobile      VARCHAR(20) NOT NULL,
  code        VARCHAR(6)  NOT NULL,
  purpose     VARCHAR(30) NOT NULL DEFAULT 'registration', -- 'registration' | 'login'
  is_used     BOOLEAN DEFAULT FALSE,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- BOOKINGS
-- ─────────────────────────────────────────────
CREATE TABLE bookings (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id      UUID NOT NULL REFERENCES users(id),
  driver_id        UUID REFERENCES users(id),
  zone_id          UUID NOT NULL REFERENCES zones(id),
  service_type     VARCHAR(20) NOT NULL CHECK (service_type IN ('ride','food','delivery','custom')),
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','in_progress','completed','cancelled')),
  pickup_lat       NUMERIC(10,7) NOT NULL,
  pickup_lng       NUMERIC(10,7) NOT NULL,
  pickup_address   VARCHAR(300),
  dropoff_lat      NUMERIC(10,7),
  dropoff_lng      NUMERIC(10,7),
  dropoff_address  VARCHAR(300),
  custom_note      TEXT,                          -- for custom/delivery orders
  distance_km      NUMERIC(8,2),
  estimated_fare   NUMERIC(8,2),
  final_fare       NUMERIC(8,2),
  payment_method   VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','gcash')),
  payment_status   VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed')),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- COMMISSIONS (auto-split per booking)
-- ─────────────────────────────────────────────
CREATE TABLE commissions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id        UUID NOT NULL REFERENCES bookings(id),
  driver_id         UUID NOT NULL REFERENCES users(id),
  total_fare        NUMERIC(8,2) NOT NULL,
  commission_rate   NUMERIC(5,4) NOT NULL,        -- e.g. 0.1000 = 10%
  commission_amount NUMERIC(8,2) NOT NULL,        -- developer's cut
  driver_amount     NUMERIC(8,2) NOT NULL,        -- driver's earnings
  transfer_status   VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (transfer_status IN ('pending','sent','failed')),
  transfer_ref      VARCHAR(200),                 -- PayMongo/GCash reference
  transfer_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- DRIVER RATINGS / REVIEWS
-- ─────────────────────────────────────────────
CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  driver_id   UUID NOT NULL REFERENCES users(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- BUSINESSES (food / delivery partners)
-- ─────────────────────────────────────────────
CREATE TABLE businesses (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID REFERENCES users(id),
  name         VARCHAR(200) NOT NULL,
  category     VARCHAR(50),                       -- 'food', 'grocery', 'pharmacy'
  zone_id      UUID REFERENCES zones(id),
  address      VARCHAR(300),
  lat          NUMERIC(10,7),
  lng          NUMERIC(10,7),
  phone        VARCHAR(20),
  logo_url     VARCHAR(500),
  is_open      BOOLEAN DEFAULT TRUE,
  is_featured  BOOLEAN DEFAULT FALSE,             -- paid listing
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- DRIVER LOCATION HISTORY (for tracking)
-- ─────────────────────────────────────────────
CREATE TABLE driver_locations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id  UUID NOT NULL REFERENCES users(id),
  booking_id UUID REFERENCES bookings(id),
  lat        NUMERIC(10,7) NOT NULL,
  lng        NUMERIC(10,7) NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- REPORTS (safety)
-- ─────────────────────────────────────────────
CREATE TABLE reports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID NOT NULL REFERENCES users(id),
  driver_id   UUID NOT NULL REFERENCES users(id),
  booking_id  UUID REFERENCES bookings(id),
  reason      VARCHAR(100) NOT NULL,
  details     TEXT,
  status      VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','reviewed','resolved')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX idx_users_mobile          ON users(mobile);
CREATE INDEX idx_users_role            ON users(role);
CREATE INDEX idx_driver_profiles_status ON driver_profiles(status);
CREATE INDEX idx_driver_profiles_online ON driver_profiles(is_online);
CREATE INDEX idx_bookings_customer     ON bookings(customer_id);
CREATE INDEX idx_bookings_driver       ON bookings(driver_id);
CREATE INDEX idx_bookings_status       ON bookings(status);
CREATE INDEX idx_commissions_driver    ON commissions(driver_id);
CREATE INDEX idx_commissions_transfer  ON commissions(transfer_status);
CREATE INDEX idx_otp_mobile            ON otp_codes(mobile);
CREATE INDEX idx_driver_locations_driver ON driver_locations(driver_id);

-- ─────────────────────────────────────────────
-- UPDATED_AT auto-trigger
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_driver_profiles_updated
  BEFORE UPDATE ON driver_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_bookings_updated
  BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed admin user (change password after first run!)
INSERT INTO users (full_name, email, mobile, role, mobile_verified)
VALUES ('Lester B.', 'admin@sugonow.app', '+639000000000', 'admin', TRUE);

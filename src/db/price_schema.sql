-- ═══════════════════════════════════════════════════════════════
-- SugoNow — Price Management Schema
-- Run: psql -U sugonow_user -d sugonow -f price_schema.sql
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. PRODUCT PRICES (current live prices)
-- ─────────────────────────────────────────────
-- Supports both exchange items (LPG, water)
-- and regular single-direction items (food, grocery).

CREATE TABLE IF NOT EXISTS product_prices (
  id                UUID    PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id       UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_name      VARCHAR(200) NOT NULL,
  product_type      VARCHAR(30)  NOT NULL DEFAULT 'standard'
                    CHECK (product_type IN ('standard','exchange','returnable')),
  -- For standard items
  base_price        NUMERIC(10,2),
  -- For exchange items (LPG, water containers)
  exchange_price    NUMERIC(10,2),    -- customer HAS empty to return
  no_tank_price     NUMERIC(10,2),    -- customer has NO empty (buys new tank/container)
  -- Delivery & handling (added on top of product price)
  delivery_fee      NUMERIC(8,2)  NOT NULL DEFAULT 40.00,
  handling_fee      NUMERIC(8,2)  NOT NULL DEFAULT 10.00,
  -- Tolerance before driver must notify customer of price change
  price_tolerance   NUMERIC(8,2)  NOT NULL DEFAULT 20.00,
  -- Deposit when customer has no empty container
  container_deposit NUMERIC(8,2)  DEFAULT 0.00,
  -- Metadata
  unit              VARCHAR(50)   DEFAULT 'per unit',  -- 'per 11kg tank', 'per 5-gal jug'
  brand             VARCHAR(100),
  image_url         VARCHAR(500),
  is_available      BOOLEAN       NOT NULL DEFAULT TRUE,
  effective_from    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  reason            VARCHAR(200),
  updated_by        UUID          REFERENCES users(id),
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_prices_business ON product_prices(business_id);
CREATE INDEX IF NOT EXISTS idx_product_prices_type     ON product_prices(product_type);
CREATE INDEX IF NOT EXISTS idx_product_prices_avail    ON product_prices(is_available);

-- ─────────────────────────────────────────────
-- 2. PRICE HISTORY (full audit trail, never deleted)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_price_id    UUID NOT NULL REFERENCES product_prices(id),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  product_name        VARCHAR(200) NOT NULL,
  -- Before
  old_base_price      NUMERIC(10,2),
  old_exchange_price  NUMERIC(10,2),
  old_no_tank_price   NUMERIC(10,2),
  -- After
  new_base_price      NUMERIC(10,2),
  new_exchange_price  NUMERIC(10,2),
  new_no_tank_price   NUMERIC(10,2),
  -- Change summary
  exchange_change     NUMERIC(10,2),  -- positive = increase, negative = decrease
  no_tank_change      NUMERIC(10,2),
  reason              VARCHAR(200),
  changed_by          UUID REFERENCES users(id),
  changed_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product  ON price_history(product_price_id);
CREATE INDEX IF NOT EXISTS idx_price_history_business ON price_history(business_id);
CREATE INDEX IF NOT EXISTS idx_price_history_date     ON price_history(changed_at DESC);

-- ─────────────────────────────────────────────
-- 3. PRICE DISCREPANCIES (driver-reported actual prices)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_discrepancies (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id       UUID NOT NULL REFERENCES bookings(id),
  product_price_id UUID REFERENCES product_prices(id),
  driver_id        UUID NOT NULL REFERENCES users(id),
  customer_id      UUID NOT NULL REFERENCES users(id),
  app_price        NUMERIC(10,2) NOT NULL,   -- what customer saw in app
  actual_price     NUMERIC(10,2) NOT NULL,   -- what driver found at dealer
  difference       NUMERIC(10,2) NOT NULL,   -- actual - app
  within_tolerance BOOLEAN NOT NULL,
  -- Customer response when notified
  customer_action  VARCHAR(20)   -- 'accepted','cancelled','timeout','auto_proceed'
                   CHECK (customer_action IN ('accepted','cancelled','timeout','auto_proceed')),
  notified_at      TIMESTAMPTZ,
  responded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discrepancies_booking ON price_discrepancies(booking_id);
CREATE INDEX IF NOT EXISTS idx_discrepancies_driver  ON price_discrepancies(driver_id);

-- ─────────────────────────────────────────────
-- 4. CONTAINER DEPOSITS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS container_deposits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     UUID NOT NULL REFERENCES users(id),
  booking_id      UUID NOT NULL REFERENCES bookings(id),
  business_id     UUID NOT NULL REFERENCES businesses(id),
  product_name    VARCHAR(200) NOT NULL,
  deposit_amount  NUMERIC(10,2) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'held'
                  CHECK (status IN ('held','returned','forfeited')),
  -- When returned
  return_booking_id UUID REFERENCES bookings(id),
  returned_at     TIMESTAMPTZ,
  -- Auto-forfeiture
  forfeiture_date DATE NOT NULL,    -- 60 days from order
  forfeited_at    TIMESTAMPTZ,
  forfeiture_note TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposits_customer ON container_deposits(customer_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status   ON container_deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_forfeiture ON container_deposits(forfeiture_date)
  WHERE status = 'held';

-- ─────────────────────────────────────────────
-- 5. DOE PRICE FEED LOG (auto-sync records)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doe_price_feed (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bulletin_date   DATE NOT NULL UNIQUE,
  region          VARCHAR(100) DEFAULT 'Cagayan Valley',
  lpg_11kg_price  NUMERIC(10,2),   -- DOE suggested consumer price
  raw_data        JSONB,           -- full parsed bulletin data
  source_url      VARCHAR(500),
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  applied         BOOLEAN NOT NULL DEFAULT FALSE,
  applied_at      TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- 6. ADD MISSING COLUMNS TO BOOKINGS
-- ─────────────────────────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS product_price_id    UUID REFERENCES product_prices(id),
  ADD COLUMN IF NOT EXISTS is_exchange_order   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_empty_container BOOLEAN,
  ADD COLUMN IF NOT EXISTS quoted_price        NUMERIC(10,2),  -- price shown to customer at booking
  ADD COLUMN IF NOT EXISTS confirmed_price     NUMERIC(10,2),  -- price confirmed by driver at pickup
  ADD COLUMN IF NOT EXISTS exchange_leg_status VARCHAR(20) DEFAULT 'pending'
    CHECK (exchange_leg_status IN ('pending','outbound_complete','return_complete','na')),
  ADD COLUMN IF NOT EXISTS empty_collected     BOOLEAN DEFAULT FALSE;

-- ─────────────────────────────────────────────
-- 7. TRIGGERS: auto update_at + price history
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_product_price_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_product_prices_updated
  BEFORE UPDATE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION update_product_price_updated_at();

-- Auto-log price history when exchange_price or no_tank_price changes
CREATE OR REPLACE FUNCTION log_price_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.exchange_price IS DISTINCT FROM NEW.exchange_price
  OR OLD.no_tank_price  IS DISTINCT FROM NEW.no_tank_price
  OR OLD.base_price     IS DISTINCT FROM NEW.base_price THEN
    INSERT INTO price_history (
      product_price_id, business_id, product_name,
      old_base_price, old_exchange_price, old_no_tank_price,
      new_base_price, new_exchange_price, new_no_tank_price,
      exchange_change, no_tank_change,
      reason, changed_by
    ) VALUES (
      NEW.id, NEW.business_id, NEW.product_name,
      OLD.base_price, OLD.exchange_price, OLD.no_tank_price,
      NEW.base_price, NEW.exchange_price, NEW.no_tank_price,
      NEW.exchange_price - COALESCE(OLD.exchange_price, 0),
      NEW.no_tank_price  - COALESCE(OLD.no_tank_price,  0),
      NEW.reason, NEW.updated_by
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_log_price_change
  AFTER UPDATE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION log_price_change();

-- ─────────────────────────────────────────────
-- 8. SEED DATA — example LPG products for Flora
-- ─────────────────────────────────────────────
-- Run after inserting the Flora LPG business into businesses table.
-- Replace 'YOUR_BUSINESS_UUID' with the actual business UUID.

-- INSERT INTO product_prices
--   (business_id, product_name, product_type, exchange_price, no_tank_price,
--    delivery_fee, handling_fee, price_tolerance, container_deposit, unit, brand, reason)
-- VALUES
--   ('YOUR_BUSINESS_UUID', 'Gasul 11kg',    'exchange', 1450, 2850, 40, 10, 20, 0, 'per 11kg tank', 'Gasul',    'Initial listing'),
--   ('YOUR_BUSINESS_UUID', 'Shellane 11kg', 'exchange', 1460, 2860, 40, 10, 20, 0, 'per 11kg tank', 'Shellane', 'Initial listing'),
--   ('YOUR_BUSINESS_UUID', 'Solane 11kg',   'exchange', 1450, 2850, 40, 10, 20, 0, 'per 11kg tank', 'Solane',   'Initial listing'),
--   ('YOUR_WATER_UUID',    '5-gallon refill','exchange', 35,   115,  20,  5, 10, 0, 'per 5-gal jug', NULL,       'Initial listing');

-- Update app_config for price-related settings
INSERT INTO app_config (key, value, description) VALUES
  ('price_discrepancy_tolerance',   '20',   'Pesos difference before driver must notify customer'),
  ('price_confirm_timeout_minutes', '5',    'Minutes customer has to respond to price change'),
  ('container_deposit_days',        '60',   'Days before unreturned deposit is forfeited'),
  ('doe_sync_day',                  'Monday','Day to check DOE price bulletin'),
  ('price_change_sms_threshold',    '50',   'Pesos change that triggers customer SMS notification')
ON CONFLICT (key) DO NOTHING;

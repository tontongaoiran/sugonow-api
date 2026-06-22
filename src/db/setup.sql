-- SugoNow v2 — Run ONCE in pgAdmin Query Tool

-- 1. Enable pgcrypto for bcrypt fallback
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Update zone fares (PHP 25 base)
UPDATE zones SET base_fare=25.00, per_km_rate=8.00 WHERE slug='flora';
UPDATE zones SET base_fare=28.00, per_km_rate=9.00 WHERE slug='luna';
UPDATE zones SET base_fare=30.00, per_km_rate=10.00 WHERE slug='province';

-- 3. Zone boundaries for location validation
ALTER TABLE zones ADD COLUMN IF NOT EXISTS center_lat NUMERIC(10,7) DEFAULT 17.5423;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS center_lng NUMERIC(10,7) DEFAULT 121.4219;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS radius_km  NUMERIC(8,2) DEFAULT 15.0;

UPDATE zones SET center_lat=17.5423, center_lng=121.4219, radius_km=15.0 WHERE slug='flora';
UPDATE zones SET center_lat=17.6234, center_lng=121.3456, radius_km=12.0 WHERE slug='luna';

-- 4. Store/seller support
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS is_store     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS seller_id    UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS store_hours  VARCHAR(100) DEFAULT '6:00 AM - 10:00 PM',
  ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(8,2) DEFAULT 30.00,
  ADD COLUMN IF NOT EXISTS min_order    NUMERIC(8,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS banner_url   VARCHAR(500),
  ADD COLUMN IF NOT EXISTS store_type   VARCHAR(50)  DEFAULT 'general';

-- 5. Menu enhancements
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS image_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS stock     INTEGER DEFAULT 999,
  ADD COLUMN IF NOT EXISTS category  VARCHAR(100) DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS unit      VARCHAR(50)  DEFAULT 'piece';

-- 6. User tracking
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_booking_used BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_bookings     INTEGER NOT NULL DEFAULT 0;

-- 7. Booking enhancements
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS passenger_count    INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS discount_amount    NUMERIC(8,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_note      TEXT,
  ADD COLUMN IF NOT EXISTS pickup_distance_km NUMERIC(8,2) DEFAULT 0;

-- 8. Store orders
CREATE TABLE IF NOT EXISTS store_orders (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id   UUID NOT NULL REFERENCES bookings(id),
  business_id  UUID NOT NULL REFERENCES businesses(id),
  customer_id  UUID NOT NULL REFERENCES users(id),
  seller_id    UUID REFERENCES users(id),
  driver_id    UUID REFERENCES users(id),
  items        JSONB NOT NULL DEFAULT '[]',
  subtotal     NUMERIC(10,2) NOT NULL,
  delivery_fee NUMERIC(8,2)  NOT NULL DEFAULT 30.00,
  total_amount NUMERIC(10,2) NOT NULL,
  status       VARCHAR(30) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','confirmed','preparing','ready','picked_up','delivered','cancelled')),
  seller_note  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Seller notifications
CREATE TABLE IF NOT EXISTS seller_notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_id  UUID NOT NULL REFERENCES users(id),
  order_id   UUID REFERENCES store_orders(id),
  type       VARCHAR(50) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Add seller role
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('customer','driver','admin','seller'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Role constraint update skipped';
END $$;

-- 11. Seed Flora LPG Dealer for testing
INSERT INTO businesses (name, category, zone_id, address, lat, lng, phone, is_active, is_open, is_store, delivery_fee)
SELECT 'Flora LPG Dealer', 'lpg', z.id, 'Poblacion, Flora, Apayao', 17.5423, 121.4219, '+639544778258', TRUE, TRUE, FALSE, 40.00
FROM zones z WHERE z.slug='flora'
ON CONFLICT DO NOTHING;

-- 12. Seed Gasul 11kg product for testing
INSERT INTO product_prices (business_id, product_name, product_type, exchange_price, no_tank_price, delivery_fee, handling_fee, price_tolerance, unit, brand, reason)
SELECT b.id, 'Gasul 11kg', 'exchange', 1450, 2850, 40, 10, 20, 'per 11kg tank', 'Gasul', 'Initial setup'
FROM businesses b WHERE b.name='Flora LPG Dealer'
ON CONFLICT DO NOTHING;

SELECT 'SugoNow v2 schema ready! Test mode active.' AS result;

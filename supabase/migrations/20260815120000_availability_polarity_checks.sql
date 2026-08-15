-- Defence-in-depth CHECKs for availability polarity (schema refine shipped c4b5a73).
-- general rows must be available; holiday rows must be unavailable.
ALTER TABLE availability
  ADD CONSTRAINT availability_general_must_be_available
    CHECK (type <> 'general' OR is_available = true),
  ADD CONSTRAINT availability_holiday_must_be_unavailable
    CHECK (type <> 'holiday' OR is_available = false);

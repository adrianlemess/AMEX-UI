-- Store only the four digits exposed by the CSV account identifier, never full account data.
CREATE TABLE amex_cards (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  last_four char(4) NOT NULL CHECK(last_four ~ '^[0-9]{4}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id),
  UNIQUE(household_id,last_four)
);
ALTER TABLE amex_activity ADD COLUMN card_last_four char(4) CHECK(card_last_four ~ '^[0-9]{4}$');
ALTER TABLE amex_import_review_rows ADD COLUMN card_last_four char(4) CHECK(card_last_four ~ '^[0-9]{4}$');
CREATE INDEX amex_activity_card_date ON amex_activity(household_id,card_last_four,activity_date);

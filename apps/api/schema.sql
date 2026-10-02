-- AMEX-only schema for a fresh PostgreSQL 17 database. No household rows or secrets.

-- initialMigration

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_lowercase CHECK (email = lower(email))
);
CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE auth_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('login', 'logout')),
  created_at timestamptz NOT NULL DEFAULT now()
);


-- amexActivityMigration

CREATE TABLE amex_activity (
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 reference text NOT NULL, activity_date date NOT NULL, description text NOT NULL,
 merchant text NOT NULL, amount_cents bigint NOT NULL, source_category text NOT NULL,
 fingerprint char(64) NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (household_id,reference)
);
CREATE INDEX amex_activity_dates ON amex_activity(household_id,activity_date);
CREATE TABLE amex_merchant_categories (
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 merchant text NOT NULL, category text NOT NULL, source text NOT NULL CHECK(source IN ('user','ai')),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(household_id,merchant)
);


-- amexAiCategoriesMigration

CREATE TABLE amex_spending_categories (
 household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 48),
 source text NOT NULL CHECK(source IN ('user','ai')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,name)
);
CREATE UNIQUE INDEX amex_spending_categories_casefold ON amex_spending_categories(household_id,lower(name));
INSERT INTO amex_spending_categories(household_id,name,source)
 SELECT DISTINCT ON (household_id,lower(category)) household_id,category,source FROM amex_merchant_categories
 WHERE category <> 'Needs review' ORDER BY household_id,lower(category),category
ON CONFLICT DO NOTHING;


-- amexAnalyticsMigration

CREATE TABLE amex_imports (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  filename text NOT NULL, file_hash char(64) NOT NULL,
  from_date date, through_date date,
  transaction_count integer NOT NULL, imported_count integer NOT NULL,
  duplicate_count integer NOT NULL, invalid_count integer NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id)
);
CREATE INDEX amex_imports_household_date ON amex_imports(household_id,imported_at DESC);
CREATE TABLE amex_merchants (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id), UNIQUE(household_id,name)
);
CREATE UNIQUE INDEX amex_merchants_casefold ON amex_merchants(household_id,lower(name));
CREATE TABLE amex_merchant_aliases (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL,
  pattern text NOT NULL CHECK(length(pattern) BETWEEN 1 AND 300),
  match_type text NOT NULL CHECK(match_type IN ('exact','prefix')),
  source text NOT NULL CHECK(source IN ('user','ai','rule')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id), UNIQUE(household_id,pattern,match_type),
  FOREIGN KEY(household_id,merchant_id) REFERENCES amex_merchants(household_id,id)
);
CREATE INDEX amex_alias_merchant ON amex_merchant_aliases(household_id,merchant_id);
ALTER TABLE amex_spending_categories ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE amex_spending_categories ADD UNIQUE(household_id,id);
ALTER TABLE amex_activity ADD COLUMN import_id uuid;
ALTER TABLE amex_activity ADD COLUMN merchant_id uuid;
ALTER TABLE amex_activity ADD COLUMN currency char(3) NOT NULL DEFAULT 'EUR';
ALTER TABLE amex_activity ADD COLUMN category_override text;
ALTER TABLE amex_activity ADD COLUMN merchant_source text NOT NULL DEFAULT 'rule'
  CHECK(merchant_source IN ('rule','ai','user'));
ALTER TABLE amex_activity ADD COLUMN merchant_confidence numeric(4,3);
ALTER TABLE amex_activity ADD COLUMN merchant_review boolean NOT NULL DEFAULT true;
ALTER TABLE amex_activity ADD CONSTRAINT amex_activity_import_fk FOREIGN KEY(household_id,import_id) REFERENCES amex_imports(household_id,id);
ALTER TABLE amex_activity ADD CONSTRAINT amex_activity_merchant_fk FOREIGN KEY(household_id,merchant_id) REFERENCES amex_merchants(household_id,id);
CREATE INDEX amex_activity_merchant_date ON amex_activity(household_id,merchant_id,activity_date);
CREATE TABLE amex_alert_rules (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK(type IN ('merchant_monthly','category_monthly','transaction_amount')),
  merchant_id uuid, category text, threshold_cents bigint NOT NULL CHECK(threshold_cents > 0),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id),
  FOREIGN KEY(household_id,merchant_id) REFERENCES amex_merchants(household_id,id),
  CHECK((type='merchant_monthly' AND merchant_id IS NOT NULL AND category IS NULL)
    OR (type='category_monthly' AND category IS NOT NULL AND merchant_id IS NULL)
    OR (type='transaction_amount' AND merchant_id IS NULL AND category IS NULL))
);
CREATE TABLE amex_alert_events (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(), rule_id uuid NOT NULL,
  trigger_key text NOT NULL, period_key text NOT NULL,
  current_cents bigint NOT NULL, threshold_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','seen','dismissed')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id), UNIQUE(household_id,rule_id,trigger_key),
  FOREIGN KEY(household_id,rule_id) REFERENCES amex_alert_rules(household_id,id) ON DELETE CASCADE
);
CREATE INDEX amex_alert_feed ON amex_alert_events(household_id,active,status,created_at DESC);


-- amexClassificationCacheMigration

CREATE TABLE amex_change_log (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK(action IN ('merchant_category','transaction_category','merchant_rename','merchant_alias','merchant_merge')),
  entity_key text NOT NULL, previous_value text, next_value text,
  affected_rows integer NOT NULL CHECK(affected_rows >= 0),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id)
);
CREATE INDEX amex_change_log_recent ON amex_change_log(household_id,changed_at DESC);
CREATE TABLE amex_classification_attempts (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  merchant_hash char(64) NOT NULL,
  status text NOT NULL CHECK(status IN ('review','failed')),
  attempts integer NOT NULL DEFAULT 1,
  last_attempt timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,merchant_hash)
);


-- amexReviewMigration

  ALTER TABLE amex_imports ADD COLUMN mapping_version text NOT NULL DEFAULT 'legacy-unknown';
  ALTER TABLE amex_imports ALTER COLUMN mapping_version SET DEFAULT 'german-eur-v1';
 CREATE TABLE amex_recurring_reviews (
   household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
   merchant_id uuid NOT NULL,
   status text NOT NULL CHECK(status IN ('confirmed','dismissed')),
   reviewed_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(household_id,merchant_id),
   FOREIGN KEY(household_id,merchant_id) REFERENCES amex_merchants(household_id,id) ON DELETE CASCADE
 );
 ALTER TABLE amex_change_log DROP CONSTRAINT amex_change_log_action_check;
 ALTER TABLE amex_change_log ADD CONSTRAINT amex_change_log_action_check
   CHECK(action IN ('merchant_category','transaction_category','merchant_rename','merchant_alias','merchant_merge','recurring_review'));


-- amexAmbiguousImportMigration

 ALTER TABLE amex_imports ADD COLUMN review_count integer NOT NULL DEFAULT 0;
 CREATE TABLE amex_import_review_rows (
   household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
   id uuid NOT NULL DEFAULT gen_random_uuid(),
   import_id uuid NOT NULL,
   file_hash char(64) NOT NULL,
   record_number integer NOT NULL CHECK(record_number > 1),
   activity_date date NOT NULL, description text NOT NULL,
   amount_cents bigint NOT NULL, source_category text NOT NULL,
   status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','distinct','dismissed')),
   resolved_reference text,
   reviewed_at timestamptz,
   PRIMARY KEY(household_id,id), UNIQUE(household_id,file_hash,record_number),
   FOREIGN KEY(household_id,import_id) REFERENCES amex_imports(household_id,id) ON DELETE CASCADE
 );
 CREATE INDEX amex_import_review_pending ON amex_import_review_rows(household_id,status,activity_date);
 ALTER TABLE amex_change_log DROP CONSTRAINT amex_change_log_action_check;
 ALTER TABLE amex_change_log ADD CONSTRAINT amex_change_log_action_check
   CHECK(action IN ('merchant_category','transaction_category','merchant_rename','merchant_alias','merchant_merge','recurring_review','import_review'));


-- amexSpendingOnlyMigration

-- AMEX analytics is purchase/credit only; settlements are not financial activity here.
DELETE FROM amex_activity WHERE amount_cents < 0 AND (
  description ~* '^ZAHLUNG/.*ERHALTEN[[:space:]]+BESTEN[[:space:]]+DANK'
  OR description ~* '^PAYMENT (RECEIVED|THANK YOU)'
);
DELETE FROM amex_import_review_rows WHERE amount_cents < 0 AND (
  description ~* '^ZAHLUNG/.*ERHALTEN[[:space:]]+BESTEN[[:space:]]+DANK'
  OR description ~* '^PAYMENT (RECEIVED|THANK YOU)'
);
INSERT INTO amex_spending_categories(household_id,name,source)
SELECT h.id, names.name, 'user' FROM households h
CROSS JOIN (VALUES ('Gifts'),('Pets')) AS names(name)
WHERE NOT EXISTS (SELECT 1 FROM amex_spending_categories c
  WHERE c.household_id=h.id AND lower(c.name)=lower(names.name));


CREATE TABLE amex_ai_attempts (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed','failed')),
  response jsonb,
  PRIMARY KEY(household_id,purpose)
);
CREATE INDEX amex_ai_attempts_recent ON amex_ai_attempts(household_id,started_at DESC);
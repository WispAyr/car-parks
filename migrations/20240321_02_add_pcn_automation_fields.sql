-- Only create the index if it does not already exist
CREATE INDEX idx_rules_auto_enforce ON rules(siteId, isActive, autoEnforce); 
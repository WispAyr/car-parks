-- Add new fields for advanced rule generation
ALTER TABLE rules
    ADD COLUMN priority INTEGER DEFAULT 0,
    ADD COLUMN activeDays VARCHAR(32) DEFAULT 'All',
    ADD COLUMN activeStartTime TIME DEFAULT NULL,
    ADD COLUMN activeEndTime TIME DEFAULT NULL,
    ADD COLUMN gracePeriodMinutes INTEGER DEFAULT 0,
    ADD COLUMN maxDailyDurationMinutes INTEGER DEFAULT NULL,
    ADD COLUMN maxWeeklyDurationMinutes INTEGER DEFAULT NULL,
    ADD COLUMN maxMonthlyDurationMinutes INTEGER DEFAULT NULL,
    ADD COLUMN notes TEXT DEFAULT NULL;

-- Create rule audit/history table
CREATE TABLE IF NOT EXISTS rule_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ruleId INTEGER,
    action VARCHAR(16),
    changedBy VARCHAR(64),
    changeTime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    oldValue TEXT,
    newValue TEXT
); 
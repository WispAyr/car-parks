-- Add carParkType to carparks table
ALTER TABLE carparks
ADD COLUMN carParkType ENUM('public', 'private') DEFAULT 'public';

-- Add new rule types and fields to rules table
ALTER TABLE rules
ADD COLUMN freePeriodMinutes INT DEFAULT NULL,
ADD COLUMN requiresRegistration BOOLEAN DEFAULT false,
ADD COLUMN requiresPayment BOOLEAN DEFAULT false,
ADD COLUMN gracePeriodMinutes INT DEFAULT 0;

-- Update rule types to include new options
ALTER TABLE rules
MODIFY COLUMN ruleType ENUM('time_limit', 'whitelist', 'payment', 'registration', 'free_period') NOT NULL; 
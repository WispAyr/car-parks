-- Add autoEnforce and notification fields to rules table
ALTER TABLE rules
    ADD COLUMN autoEnforce BOOLEAN DEFAULT true,
    ADD COLUMN notifyEmails TEXT,
    ADD COLUMN customMessage TEXT; 
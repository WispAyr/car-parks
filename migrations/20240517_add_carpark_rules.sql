-- Migration: Add rule fields to carparks table
ALTER TABLE carparks
  ADD COLUMN maxStayMinutes INT DEFAULT NULL,
  ADD COLUMN allowedHours VARCHAR(255) DEFAULT NULL; 
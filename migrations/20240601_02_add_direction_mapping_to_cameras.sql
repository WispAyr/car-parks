-- Migration: Add entryDirection and exitDirection columns to cameras table
ALTER TABLE cameras
    ADD COLUMN entryDirection VARCHAR(32) DEFAULT NULL,
    ADD COLUMN exitDirection VARCHAR(32) DEFAULT NULL; 
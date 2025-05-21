-- Migration: Add admin_url column to cameras table
ALTER TABLE cameras
    ADD COLUMN admin_url VARCHAR(255) DEFAULT NULL; 
-- Migration: Add admin_username and admin_password columns to cameras table
ALTER TABLE cameras
    ADD COLUMN admin_username VARCHAR(128) DEFAULT NULL,
    ADD COLUMN admin_password VARCHAR(128) DEFAULT NULL; 
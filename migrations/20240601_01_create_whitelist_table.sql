-- Migration: Create whitelist table for car parks
CREATE TABLE IF NOT EXISTS whitelist (
    id INT AUTO_INCREMENT PRIMARY KEY,
    carParkId VARCHAR(32) NOT NULL,
    VRM VARCHAR(16) NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
); 
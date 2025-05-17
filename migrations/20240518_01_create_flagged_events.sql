-- Flagged events for ambiguous/unpaired detections
CREATE TABLE IF NOT EXISTS flagged_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    VRM VARCHAR(32),
    siteId VARCHAR(50),
    detectionId INT,
    timestamp DATETIME,
    reason VARCHAR(128),
    status VARCHAR(32) DEFAULT 'open',
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
); 
CREATE TABLE IF NOT EXISTS carpark_processing_status (
    siteId VARCHAR(50) PRIMARY KEY,
    isEnabled BOOLEAN DEFAULT true,
    reason TEXT,
    lastUpdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES carparks(siteId)
);

-- Insert initial data for existing car parks
INSERT IGNORE INTO carpark_processing_status (siteId, isEnabled)
SELECT siteId, true FROM carparks; 
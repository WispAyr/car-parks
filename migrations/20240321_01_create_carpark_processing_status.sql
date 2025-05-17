-- Create table for tracking car park processing status
CREATE TABLE IF NOT EXISTS carpark_processing_status (
    siteId VARCHAR(50) PRIMARY KEY,
    isEnabled BOOLEAN DEFAULT true,
    reason TEXT,
    lastUpdated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES carparks(siteId)
); 
-- PCN automation and notification preferences per car park
CREATE TABLE IF NOT EXISTS pcn_automation_settings (
    siteId VARCHAR(50) PRIMARY KEY,
    isEnabled BOOLEAN DEFAULT true,
    notifyEmails TEXT,
    gracePeriodMinutes INT DEFAULT 0,
    lastChecked TIMESTAMP NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES carparks(siteId)
); 
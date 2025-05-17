-- Create rules table for car park rules management
CREATE TABLE IF NOT EXISTS rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    siteId VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    ruleType VARCHAR(50) NOT NULL,
    description TEXT,
    maxDurationMinutes INT,
    maxDailyDurationMinutes INT,
    maxWeeklyDurationMinutes INT,
    maxMonthlyDurationMinutes INT,
    startTime TIME,
    endTime TIME,
    daysOfWeek VARCHAR(32),
    isActive BOOLEAN DEFAULT true,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES carparks(siteId)
); 
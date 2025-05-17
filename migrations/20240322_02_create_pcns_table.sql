-- Create pcns table for penalty charge notices management
CREATE TABLE IF NOT EXISTS pcns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    siteId VARCHAR(50) NOT NULL,
    VRM VARCHAR(32) NOT NULL,
    ruleId INT,
    issueTime DATETIME NOT NULL,
    status VARCHAR(32) DEFAULT 'issued',
    notes TEXT,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES carparks(siteId),
    FOREIGN KEY (ruleId) REFERENCES rules(id)
); 
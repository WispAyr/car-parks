-- Create pcns table for penalty charge notices management
CREATE TABLE IF NOT EXISTS pcns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    siteId VARCHAR(50) NOT NULL,
    eventId INT,
    VRM VARCHAR(32) NOT NULL,
    ruleId INT,
    issueTime DATETIME NOT NULL,
    issueDate DATE NOT NULL,
    dueDate DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL DEFAULT 150.00,
    reason TEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'possible',
    notes TEXT,
    reference VARCHAR(12) UNIQUE,
    evidence JSON,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES carparks(siteId),
    FOREIGN KEY (eventId) REFERENCES parking_events(id),
    FOREIGN KEY (ruleId) REFERENCES rules(id)
); 
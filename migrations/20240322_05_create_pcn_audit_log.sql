-- PCN audit log for automated actions
CREATE TABLE IF NOT EXISTS pcn_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pcnId INT,
    eventId INT,
    ruleId INT,
    siteId VARCHAR(50),
    action VARCHAR(32),
    message TEXT,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pcnId) REFERENCES pcns(id),
    FOREIGN KEY (eventId) REFERENCES parking_events(id),
    FOREIGN KEY (ruleId) REFERENCES rules(id),
    FOREIGN KEY (siteId) REFERENCES carparks(siteId)
); 
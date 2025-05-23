CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    siteId VARCHAR(16) NOT NULL,
    vrm VARCHAR(32) NOT NULL,
    paymentStart DATETIME NOT NULL,
    paymentEnd DATETIME NOT NULL,
    source VARCHAR(32) DEFAULT 'matrix',
    transactionSerial VARCHAR(32),
    importedAt DATETIME DEFAULT CURRENT_TIMESTAMP
); 
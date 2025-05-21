-- Create cameras table
CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    carParkId TEXT,
    isEntryTrigger BOOLEAN DEFAULT FALSE,
    isExitTrigger BOOLEAN DEFAULT FALSE,
    direction TEXT,
    entryDirection TEXT,
    exitDirection TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (carParkId) REFERENCES carparks(siteId)
);

-- Create index on carParkId for faster lookups
CREATE INDEX IF NOT EXISTS idx_cameras_carParkId ON cameras(carParkId); 
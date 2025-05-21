// correctDetectionTimestamps.js
// Utility to patch ANPR detection timestamps by +1 hour and set time_corrected flag
// Usage: node utils/correctDetectionTimestamps.js

require('dotenv').config();
const pool = require('../dbPool');
const { logger } = require('./logger');

async function correctAllDetectionTimestamps() {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all detections that have not been time-corrected
        const rows = await conn.query('SELECT id, timestamp FROM anpr_detections WHERE time_corrected = 0');
        logger.info(`[TIME PATCH] Found ${rows.length} detections to correct.`);
        let updated = 0;
        for (const row of rows) {
            if (!row.timestamp) continue;
            const dt = new Date(row.timestamp);
            dt.setHours(dt.getHours() + 1);
            const newTimestamp = dt.toISOString().slice(0, 19).replace('T', ' ');
            await conn.query('UPDATE anpr_detections SET timestamp = ?, time_corrected = 1 WHERE id = ?', [newTimestamp, row.id]);
            updated++;
            if (updated % 1000 === 0) logger.info(`[TIME PATCH] Corrected ${updated} so far...`);
        }
        logger.info(`[TIME PATCH] Done. Corrected ${updated} detection timestamps.`);
        return updated;
    } catch (err) {
        logger.error('[TIME PATCH] Error correcting detection timestamps:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

// If run directly, execute the correction
if (require.main === module) {
    correctAllDetectionTimestamps().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { correctAllDetectionTimestamps }; 
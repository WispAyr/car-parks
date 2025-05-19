// eventGeneration.js

// Import dependencies
require('dotenv').config();
const pool = require('./dbPool');

// --- Helper functions (copy from server.js) ---
function normalizeVRM(vrm) {
    if (!vrm) return vrm;
    return vrm.replace(/\s+/g, '').toUpperCase();
}
function isValidVRM(vrm) {
    if (!vrm || vrm === 'UNKNOWN') return false;
    return /^[A-Z0-9]{2,7}$/.test(vrm);
}
function fuzzyVRMMatch(vrm1, vrm2) {
    if (!vrm1 || !vrm2) return false;
    if (vrm1 === vrm2) return true;
    const commonErrors = { '0': 'O', '1': 'I', '5': 'S', '8': 'B' };
    let vrm1Fixed = vrm1, vrm2Fixed = vrm2;
    Object.entries(commonErrors).forEach(([wrong, correct]) => {
        vrm1Fixed = vrm1Fixed.replace(new RegExp(wrong, 'g'), correct);
        vrm2Fixed = vrm2Fixed.replace(new RegExp(wrong, 'g'), correct);
    });
    return vrm1Fixed === vrm2Fixed;
}
function isLikelyThroughTraffic(detection, previousDetections) {
    // Look for detections within the last 5 minutes
    const recentDetections = previousDetections.filter(d =>
        Math.abs(new Date(d.timestamp) - new Date(detection.timestamp)) < 300000
    );
    
    // If we have multiple detections of the same VRM within 5 minutes, it's likely through traffic
    if (recentDetections.length > 1) {
        return true;
    }
    
    // Also check if this detection is part of a sequence of detections
    const sortedDetections = [...recentDetections, detection].sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // If we have at least 2 detections and they're close together, it's likely through traffic
    if (sortedDetections.length >= 2) {
        const timeDiff = Math.abs(
            new Date(sortedDetections[sortedDetections.length - 1].timestamp) - 
            new Date(sortedDetections[0].timestamp)
        );
        return timeDiff < 300000; // 5 minutes
    }
    
    return false;
}
function safeToISOString(val, fallback) {
    if (!val) return fallback;
    const d = new Date(val);
    return isNaN(d.getTime()) ? fallback : d.toISOString();
}

// --- processBuffer (copy from server.js) ---
async function processBuffer(siteId, VRM, buffer, throughLimit, minEventDuration, entriesByVRM) {
    // Filter out detections with unknown direction or invalid VRM
    buffer = buffer.filter(d => {
        const normalizedVRM = normalizeVRM(d.VRM);
        return d.direction && 
               d.direction !== 'unknown' && 
               isValidVRM(normalizedVRM);
    });
    
    buffer.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    console.log(`[EVENT GEN] Buffer for VRM=${VRM}:`);
    buffer.forEach(d => {
        console.log(`  id=${d.id}, ts=${d.timestamp}, cam=${d.cameraID}, direction=${d.direction}, VRM=${d.VRM}`);
    });

    // Group detections by direction
    const entryDetections = buffer.filter(d => d.direction === 'in' || d.direction === 'towards');
    const exitDetections = buffer.filter(d => d.direction === 'out' || d.direction === 'away');
    
    const events = [];
    
    // If we have both entry and exit detections
    if (entryDetections.length > 0 && exitDetections.length > 0) {
        // Use first entry and last exit
        const firstEntry = entryDetections[0];
        const lastExit = exitDetections[exitDetections.length - 1];
        
        const entryTime = new Date(firstEntry.timestamp);
        const exitTime = new Date(lastExit.timestamp);
        const duration = (exitTime - entryTime) / (1000 * 60); // duration in minutes
        
        // Only create event if exit is after entry
        if (exitTime > entryTime) {
            console.log(`[EVENT GEN] Creating event: VRM=${VRM}, entryId=${firstEntry.id}, exitId=${lastExit.id}, entryTime=${firstEntry.timestamp}, exitTime=${lastExit.timestamp}, duration=${duration}`);
            
            events.push({
                siteId: siteId,
                VRM: VRM,
                entryTime: firstEntry.timestamp,
                exitTime: lastExit.timestamp,
                durationMinutes: Math.round(duration * 10) / 10,
                throughTraffic: duration <= throughLimit,
                entryDetectionId: firstEntry.id,
                exitDetectionId: lastExit.id,
                entryCameraId: firstEntry.cameraID,
                exitCameraId: lastExit.cameraID
            });
        } else {
            console.log(`[EVENT GEN] Invalid event (exit before entry): VRM=${VRM}, entryId=${firstEntry.id}, exitId=${lastExit.id}`);
        }
    } else if (entryDetections.length > 0) {
        // Only entry detections - create open event
        const firstEntry = entryDetections[0];
        console.log(`[EVENT GEN] Open event (entry only): VRM=${VRM}, entryId=${firstEntry.id}, time=${firstEntry.timestamp}`);
        
        events.push({
            siteId: siteId,
            VRM: VRM,
            entryTime: firstEntry.timestamp,
            exitTime: null,
            durationMinutes: null,
            throughTraffic: false,
            entryDetectionId: firstEntry.id,
            exitDetectionId: null,
            entryCameraId: firstEntry.cameraID,
            exitCameraId: null
        });
    } else if (exitDetections.length > 0) {
        // Only exit detections - create exit-only event
        const lastExit = exitDetections[exitDetections.length - 1];
        console.log(`[EVENT GEN] Exit-only event: VRM=${VRM}, exitId=${lastExit.id}, time=${lastExit.timestamp}`);
        
        events.push({
            siteId: siteId,
            VRM: VRM,
            entryTime: null,
            exitTime: lastExit.timestamp,
            durationMinutes: null,
            throughTraffic: false,
            entryDetectionId: null,
            exitDetectionId: lastExit.id,
            entryCameraId: null,
            exitCameraId: lastExit.cameraID
        });
    }
    
    return events;
}

// --- getUnprocessedDetections (copy from server.js) ---
async function getUnprocessedDetections(carParkId, startDate, endDate) {
    let conn;
    try {
        conn = await pool.getConnection();
        console.log(`[DEBUG] Getting unprocessed detections for car park ${carParkId} between ${startDate} and ${endDate}`);
        
        const query = `
            SELECT d.*, c.direction as cameraDir
            FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.name
            WHERE c.carParkId = ?
            AND d.timestamp BETWEEN ? AND ?
            AND d.processed = FALSE
            ORDER BY d.timestamp ASC
        `;
        const rows = await conn.query(query, [carParkId, startDate, endDate]);
        console.log(`[DEBUG] Found ${rows.length} unprocessed detections for car park ${carParkId}`);
        return rows || [];
    } catch (err) {
        console.error('Error in getUnprocessedDetections:', err);
        return [];
    } finally {
        if (conn) conn.release();
    }
}

// --- generateParkingEvents (copy from server.js, with progressCallback) ---
async function generateParkingEvents(startDate, endDate, clearFlaggedEvents = false, progressCallback) {
    let conn;
    const allEvents = [];
    try {
        conn = await pool.getConnection();
        if (clearFlaggedEvents) {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            await conn.query('TRUNCATE TABLE parking_events');
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
        const carParks = await conn.query('SELECT * FROM carparks');
        for (let idx = 0; idx < carParks.length; idx++) {
            const carPark = carParks[idx];
            const start = safeToISOString(startDate, '1970-01-01T00:00:00Z');
            const end = safeToISOString(endDate, '2100-01-01T00:00:00Z');
            const detections = await getUnprocessedDetections(carPark.siteId, start, end);
            if (detections.length === 0) continue;
            const detectionsByVRM = {};
            for (const detection of detections) {
                const normalizedVRM = normalizeVRM(detection.VRM);
                if (!detectionsByVRM[normalizedVRM]) {
                    detectionsByVRM[normalizedVRM] = [];
                }
                detectionsByVRM[normalizedVRM].push(detection);
            }
            const events = [];
            const vrms = Object.entries(detectionsByVRM);
            for (let vIdx = 0; vIdx < vrms.length; vIdx++) {
                const [vrm, vrmDetections] = vrms[vIdx];
                const processedEvents = await processBuffer(
                    carPark.siteId,
                    vrm,
                    vrmDetections,
                    carPark.throughLimit || 10,
                    carPark.minEventDurationMinutes || 1,
                    detectionsByVRM
                );
                if (Array.isArray(processedEvents)) {
                    events.push(...processedEvents);
                }
                if (progressCallback) {
                    const percent = Math.round((idx + vIdx / vrms.length) / carParks.length * 100);
                    progressCallback(percent);
                }
            }
            if (events.length > 0) {
                const batchSize = 100;
                for (let i = 0; i < events.length; i += batchSize) {
                    const batch = events.slice(i, i + batchSize);
                    const values = batch.map(event => [
                        event.siteId,
                        event.VRM,
                        new Date(event.entryTime).toISOString().slice(0, 19).replace('T', ' '),
                        event.exitTime ? new Date(event.exitTime).toISOString().slice(0, 19).replace('T', ' ') : null,
                        event.durationMinutes,
                        event.throughTraffic ? 1 : 0,
                        event.entryDetectionId,
                        event.exitDetectionId,
                        event.entryCameraId,
                        event.exitCameraId
                    ]);
                    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
                    const query = `
                        INSERT INTO parking_events 
                        (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic, entryDetectionId, exitDetectionId, entryCameraId, exitCameraId)
                        VALUES ${placeholders}
                        ON DUPLICATE KEY UPDATE
                            exitTime = VALUES(exitTime),
                            durationMinutes = VALUES(durationMinutes),
                            throughTraffic = VALUES(throughTraffic),
                            exitDetectionId = VALUES(exitDetectionId),
                            exitCameraId = VALUES(exitCameraId)
                    `;
                    await conn.query(query, values.flat());
                }
            }
            const detectionIds = detections.map(d => d.id);
            if (detectionIds.length > 0) {
                await conn.query('UPDATE anpr_detections SET processed = TRUE WHERE id IN (?)', [detectionIds]);
            }
            allEvents.push(...events);
        }
        if (progressCallback) progressCallback(100);
        return allEvents;
    } catch (err) {
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function markDetectionAsProcessed(detectionId) {
    let conn;
    try {
        conn = await pool.getConnection();
        const query = `
            UPDATE anpr_detections
            SET processed = TRUE,
                processed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `;
        await conn.query(query, [detectionId]);
    } catch (err) {
        console.error('Error in markDetectionAsProcessed:', err);
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { generateParkingEvents }; 
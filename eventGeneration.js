// eventGeneration.js

// Import dependencies
require('dotenv').config();

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
    const recentDetections = previousDetections.filter(d =>
        Math.abs(new Date(d.timestamp) - new Date(detection.timestamp)) < 300000
    );
    return recentDetections.length > 1;
}
function safeToISOString(val, fallback) {
    if (!val) return fallback;
    const d = new Date(val);
    return isNaN(d.getTime()) ? fallback : d.toISOString();
}

// --- processBuffer (copy from server.js) ---
async function processBuffer(siteId, VRM, buffer, throughLimit, minEventDuration, entriesByVRM) {
    buffer.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const events = [];
    let i = 0;
    while (i < buffer.length) {
        const entry = buffer[i];
        if (!isValidVRM(VRM)) { i++; continue; }
        if (isLikelyThroughTraffic(entry, buffer)) { i++; continue; }
        let exit = null;
        let j = i + 1;
        while (j < buffer.length) {
            const potentialExit = buffer[j];
            if (fuzzyVRMMatch(VRM, potentialExit.VRM)) {
                const duration = (new Date(potentialExit.timestamp) - new Date(entry.timestamp)) / (1000 * 60);
                if (duration >= minEventDuration) {
                    exit = potentialExit;
                    break;
                }
            }
            j++;
        }
        if (exit) {
            const entryTime = new Date(entry.timestamp);
            const exitTime = new Date(exit.timestamp);
            const duration = (exitTime - entryTime) / (1000 * 60);
            const isThroughTraffic = duration <= throughLimit;
            if (duration < minEventDuration) { i = j + 1; continue; }
            events.push({
                siteId: siteId,
                VRM: VRM,
                entryTime: entry.timestamp,
                exitTime: exit.timestamp,
                durationMinutes: Math.round(duration * 10) / 10,
                throughTraffic: isThroughTraffic,
                entryDetectionId: entry.detectionId,
                exitDetectionId: exit.detectionId,
                entryCameraId: entry.cameraID,
                exitCameraId: exit.cameraID
            });
            i = j + 1;
        } else if (entry.isEntry) {
            events.push({
                siteId: siteId,
                VRM: VRM,
                entryTime: entry.timestamp,
                exitTime: null,
                durationMinutes: null,
                throughTraffic: false,
                entryDetectionId: entry.detectionId,
                exitDetectionId: null,
                entryCameraId: entry.cameraID,
                exitCameraId: null
            });
            i++;
        } else {
            const exitTime = new Date(entry.timestamp);
            let foundEntry = null;
            const lookbackMins = 30;
            const lookbackStart = new Date(exitTime.getTime() - lookbackMins * 60 * 1000);
            const possibleEntries = (entriesByVRM[normalizeVRM(VRM)] || []).filter(det => {
                const ts = new Date(det.timestamp);
                return ts >= lookbackStart && ts <= exitTime;
            });
            for (const det of possibleEntries) {
                if (fuzzyVRMMatch(VRM, det.VRM)) {
                    foundEntry = det;
                    break;
                }
            }
            if (foundEntry) {
                const duration = (exitTime - new Date(foundEntry.timestamp)) / (1000 * 60);
                events.push({
                    siteId: siteId,
                    VRM: VRM,
                    entryTime: foundEntry.timestamp,
                    exitTime: entry.timestamp,
                    durationMinutes: Math.round(duration * 10) / 10,
                    throughTraffic: duration <= throughLimit,
                    entryDetectionId: foundEntry.detectionId || foundEntry.id,
                    exitDetectionId: entry.detectionId,
                    entryCameraId: foundEntry.cameraID,
                    exitCameraId: entry.cameraID
                });
            }
            i++;
        }
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
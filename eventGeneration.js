// eventGeneration.js

// Import dependencies
require('dotenv').config();
const pool = require('./dbPool');
const logger = require('./utils/logger');

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

// --- Helper to build camera map ---
async function getCameraMap() {
    let conn;
    try {
        conn = await pool.getConnection();
        const cameras = await conn.query('SELECT * FROM cameras');
        const cameraMap = {};
        cameras.forEach(cam => {
            cameraMap[cam.name] = cam;
        });
        return cameraMap;
    } catch (err) {
        logger.error('Error building camera map:', err);
        return {};
    } finally {
        if (conn) conn.release();
    }
}

// --- processBuffer (copy from server.js) ---
async function processBuffer(siteId, vrm, detections, throughLimit, minEventDurationMinutes, allDetectionsByVRM, cameraMap) {
    try {
        const stats = {
            totalDetections: detections.length,
            eventsCreated: 0,
            eventsCompleted: 0,
            eventsSkipped: {
                durationTooShort: 0,
                throughTraffic: 0,
                missingExit: 0,
                invalidDirection: 0
            },
            directionStats: {
                entry: 0,
                exit: 0,
                unknown: 0
            }
        };

        logger.info(`[DEBUG] Processing buffer for VRM ${vrm} in car park ${siteId}`);
        logger.info(`[DEBUG] Buffer contains ${detections.length} detections`);
        logger.info(`[DEBUG] Settings - Through limit: ${throughLimit}min, Min duration: ${minEventDurationMinutes}min`);
        
        // Sort detections by timestamp
        detections.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        const events = [];
        let openEvent = null;
        
        for (const detection of detections) {
            // Flexible direction mapping
            let mappedDirection = 'unknown';
            const camera = cameraMap[detection.cameraID];
            const rawDir = detection.direction?.trim().toLowerCase();
            if (camera) {
                if (camera.entryDirection && rawDir === camera.entryDirection.trim().toLowerCase()) {
                    mappedDirection = 'entry';
                } else if (camera.exitDirection && rawDir === camera.exitDirection.trim().toLowerCase()) {
                    mappedDirection = 'exit';
                }
            }
            // Fallback to legacy mapping if not set
            if (mappedDirection === 'unknown') {
                const legacyMap = {
                    'towards': 'entry',
                    'away': 'exit',
                    'in': 'entry',
                    'out': 'exit',
                    'entry': 'entry',
                    'exit': 'exit'
                };
                mappedDirection = legacyMap[rawDir] || 'unknown';
            }
            
            // Track direction statistics
            if (mappedDirection === 'entry') stats.directionStats.entry++;
            else if (mappedDirection === 'exit') stats.directionStats.exit++;
            else stats.directionStats.unknown++;
            
            logger.info(`[DEBUG] Processing detection ${detection.id} from camera ${detection.cameraID}`);
            logger.info(`[DEBUG] - Original direction: ${detection.direction}`);
            logger.info(`[DEBUG] - Mapped direction: ${mappedDirection}`);
            logger.info(`[DEBUG] - Timestamp: ${detection.timestamp}`);
            
            if (mappedDirection === 'entry') {
                if (openEvent) {
                    logger.info(`[DEBUG] Previous event for VRM ${vrm} never closed, marking as incomplete and starting new event.`);
                    openEvent.incomplete = true;
                    events.push(openEvent);
                }
                openEvent = {
                    siteId,
                    VRM: vrm,
                    entryTime: detection.timestamp,
                    exitTime: null,
                    durationMinutes: null,
                    throughTraffic: false,
                    entryDetectionId: detection.id,
                    exitDetectionId: null,
                    entryCameraId: detection.cameraID,
                    exitCameraId: null,
                    incomplete: false
                };
                stats.eventsCreated++;
                logger.info(`[DEBUG] Started new event for VRM ${vrm} with entry detection ${detection.id}`);
            } else if (mappedDirection === 'exit') {
                if (openEvent) {
                    logger.info(`[DEBUG] Closing open event for VRM ${vrm} at ${detection.timestamp} (exit)`);
                    openEvent.exitTime = detection.timestamp;
                    openEvent.exitDetectionId = detection.id;
                    openEvent.exitCameraId = detection.cameraID;
                    const duration = (new Date(detection.timestamp) - new Date(openEvent.entryTime)) / (1000 * 60);
                    openEvent.durationMinutes = duration;
                    openEvent.throughTraffic = duration <= throughLimit;
                    logger.info(`[DEBUG] Completed event for VRM ${vrm}: entry at ${openEvent.entryTime}, exit at ${detection.timestamp}, duration ${duration.toFixed(2)} min, throughTraffic: ${openEvent.throughTraffic}`);
                    if (duration >= minEventDurationMinutes) {
                        events.push({...openEvent});
                        stats.eventsCompleted++;
                        logger.info(`[DEBUG] Added event to output (duration >= ${minEventDurationMinutes} min)`);
                    } else {
                        stats.eventsSkipped.durationTooShort++;
                        logger.info(`[DEBUG] Event for VRM ${vrm} skipped: duration ${duration.toFixed(2)} min < minEventDurationMinutes (${minEventDurationMinutes})`);
                    }
                    if (openEvent.throughTraffic) {
                        stats.eventsSkipped.throughTraffic++;
                        logger.info(`[THROUGH TRAFFIC] Event for VRM ${vrm} is through traffic (duration ${duration.toFixed(2)} min <= limit ${throughLimit} min)`);
                    }
                    openEvent = null;
                } else {
                    logger.info(`[DEBUG] No open event. Got exit for VRM ${vrm} at ${detection.timestamp} (exit-only)`);
                    stats.eventsSkipped.missingExit++;
                    logger.info(`[THROUGH TRAFFIC] Creating exit-only event for VRM ${vrm} at ${detection.timestamp}`);
                    events.push({
                        siteId,
                        VRM: vrm,
                        entryTime: detection.timestamp,
                        exitTime: detection.timestamp,
                        durationMinutes: 0,
                        throughTraffic: true,
                        entryDetectionId: null,
                        exitDetectionId: detection.id,
                        entryCameraId: null,
                        exitCameraId: detection.cameraID,
                        incomplete: false
                    });
                }
            } else {
                logger.info(`[DEBUG] Skipped detection with invalid direction: ${detection.direction}`);
                stats.eventsSkipped.invalidDirection++;
            }
        }
        
        if (openEvent) {
            logger.info(`[DEBUG] Buffer ended with open event for VRM ${vrm} (entry at ${openEvent.entryTime}) - marking as incomplete (still parked)`);
            openEvent.incomplete = true;
            stats.eventsSkipped.missingExit++;
            events.push(openEvent);
        }
        
        // Print detailed statistics
        logger.info('\n[STATS] Event Processing Statistics for VRM ' + vrm);
        logger.info('==========================================');
        logger.info(`Total Detections: ${stats.totalDetections}`);
        logger.info(`Events Created: ${stats.eventsCreated}`);
        logger.info(`Events Completed: ${stats.eventsCompleted}`);
        logger.info('\nSkipped Events:');
        logger.info(`- Duration Too Short: ${stats.eventsSkipped.durationTooShort}`);
        logger.info(`- Through Traffic: ${stats.eventsSkipped.throughTraffic}`);
        logger.info(`- Missing Exit: ${stats.eventsSkipped.missingExit}`);
        logger.info(`- Invalid Direction: ${stats.eventsSkipped.invalidDirection}`);
        logger.info('\nDirection Statistics:');
        logger.info(`- Entry Detections: ${stats.directionStats.entry}`);
        logger.info(`- Exit Detections: ${stats.directionStats.exit}`);
        logger.info(`- Unknown Directions: ${stats.directionStats.unknown}`);
        
        return events;
    } catch (err) {
        logger.error(`[ERROR] Error processing buffer for VRM ${vrm}:`, err);
        return [];
    }
}

// --- getUnprocessedDetections (copy from server.js) ---
async function getUnprocessedDetections(carParkId, startDate, endDate) {
    let conn;
    try {
        conn = await pool.getConnection();
        logger.info(`[DEBUG] Getting unprocessed detections for car park ${carParkId} between ${startDate} and ${endDate}`);
        
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
        logger.info(`[DEBUG] Found ${rows.length} unprocessed detections for car park ${carParkId}`);
        return rows || [];
    } catch (err) {
        logger.error('Error in getUnprocessedDetections:', err);
        return [];
    } finally {
        if (conn) conn.release();
    }
}

// --- generateParkingEvents (copy from server.js, with progressCallback) ---
async function generateParkingEvents(startDate, endDate, clearFlaggedEvents = false, progressCallback) {
    let conn;
    const allEvents = [];
    const stats = {
        carParks: {},
        totalDetections: 0,
        totalUnknownDirections: 0,
        totalUnknownVRMs: 0,
        totalEvents: {
            created: 0,
            completed: 0,
            skipped: {
                durationTooShort: 0,
                throughTraffic: 0,
                missingExit: 0,
                invalidDirection: 0
            }
        }
    };
    
    try {
        conn = await pool.getConnection();
        if (clearFlaggedEvents) {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            await conn.query('TRUNCATE TABLE parking_events');
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
        const carParks = await conn.query('SELECT * FROM carparks');
        
        // Add debug logging for total car parks
        logger.info(`[DEBUG] Processing events for ${carParks.length} car parks`);
        
        for (let idx = 0; idx < carParks.length; idx++) {
            const carPark = carParks[idx];
            logger.info(`\n[DEBUG] Processing car park ${carPark.siteId} (${carPark.name})`);
            
            // Initialize stats for this car park
            stats.carParks[carPark.siteId] = {
                name: carPark.name,
                totalDetections: 0,
                unknownDirections: 0,
                unknownVRMs: 0,
                events: {
                    created: 0,
                    completed: 0,
                    skipped: {
                        durationTooShort: 0,
                        throughTraffic: 0,
                        missingExit: 0,
                        invalidDirection: 0
                    }
                }
            };
            
            const start = safeToISOString(startDate, '1970-01-01T00:00:00Z');
            const end = safeToISOString(endDate, '2100-01-01T00:00:00Z');
            const detections = await getUnprocessedDetections(carPark.siteId, start, end);
            
            if (detections.length === 0) {
                logger.info(`[DEBUG] No unprocessed detections found for car park ${carPark.siteId}`);
                continue;
            }
            
            logger.info(`[DEBUG] Found ${detections.length} unprocessed detections for car park ${carPark.siteId}`);
            
            // Update total detections
            stats.totalDetections += detections.length;
            stats.carParks[carPark.siteId].totalDetections = detections.length;
            
            const detectionsByVRM = {};
            for (const detection of detections) {
                // Track unknown directions
                if (!detection.direction || detection.direction.toLowerCase() === 'unknown') {
                    stats.totalUnknownDirections++;
                    stats.carParks[carPark.siteId].unknownDirections++;
                }
                
                // Track unknown VRMs
                if (!detection.VRM || detection.VRM === 'UNKNOWN') {
                    stats.totalUnknownVRMs++;
                    stats.carParks[carPark.siteId].unknownVRMs++;
                }
                
                const normalizedVRM = normalizeVRM(detection.VRM);
                if (!detectionsByVRM[normalizedVRM]) {
                    detectionsByVRM[normalizedVRM] = [];
                }
                detectionsByVRM[normalizedVRM].push(detection);
            }
            
            const events = [];
            const vrms = Object.entries(detectionsByVRM);
            logger.info(`[DEBUG] Processing ${vrms.length} unique VRMs for car park ${carPark.siteId}`);
            
            for (let vIdx = 0; vIdx < vrms.length; vIdx++) {
                const [vrm, vrmDetections] = vrms[vIdx];
                const cameraMap = await getCameraMap();
                const processedEvents = await processBuffer(
                    carPark.siteId,
                    vrm,
                    vrmDetections,
                    carPark.throughLimit || 10,
                    carPark.minEventDurationMinutes || 1,
                    detectionsByVRM,
                    cameraMap
                );
                if (Array.isArray(processedEvents)) {
                    events.push(...processedEvents);
                    
                    // Update car park statistics with VRM-level stats
                    stats.carParks[carPark.siteId].events.created += processedEvents.length;
                    stats.totalEvents.created += processedEvents.length;
                    
                    // Count completed events
                    const completedEvents = processedEvents.filter(e => e.exitTime);
                    stats.carParks[carPark.siteId].events.completed += completedEvents.length;
                    stats.totalEvents.completed += completedEvents.length;
                    
                    // Count through traffic
                    const throughTraffic = processedEvents.filter(e => e.throughTraffic);
                    stats.carParks[carPark.siteId].events.skipped.throughTraffic += throughTraffic.length;
                    stats.totalEvents.skipped.throughTraffic += throughTraffic.length;
                }
                if (progressCallback) {
                    const percent = Math.round((idx + vIdx / vrms.length) / carParks.length * 100);
                    progressCallback(percent);
                }
            }
            
            logger.info(`[DEBUG] Generated ${events.length} events for car park ${carPark.siteId}`);
            
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
        
        // Print final statistics
        logger.info('\n[STATS] Event Generation Statistics:');
        logger.info('===================================');
        logger.info(`Total Detections: ${stats.totalDetections}`);
        logger.info(`Total Unknown Directions: ${stats.totalUnknownDirections} (${((stats.totalUnknownDirections / stats.totalDetections) * 100).toFixed(2)}%)`);
        logger.info(`Total Unknown VRMs: ${stats.totalUnknownVRMs} (${((stats.totalUnknownVRMs / stats.totalDetections) * 100).toFixed(2)}%)`);
        
        logger.info('\nEvent Statistics:');
        logger.info('================');
        logger.info(`Total Events Created: ${stats.totalEvents.created}`);
        logger.info(`Total Events Completed: ${stats.totalEvents.completed}`);
        logger.info('\nSkipped Events:');
        logger.info(`- Duration Too Short: ${stats.totalEvents.skipped.durationTooShort}`);
        logger.info(`- Through Traffic: ${stats.totalEvents.skipped.throughTraffic}`);
        logger.info(`- Missing Exit: ${stats.totalEvents.skipped.missingExit}`);
        logger.info(`- Invalid Direction: ${stats.totalEvents.skipped.invalidDirection}`);
        
        logger.info('\nPer Car Park Statistics:');
        logger.info('=======================');
        
        Object.entries(stats.carParks).forEach(([siteId, parkStats]) => {
            if (parkStats.totalDetections > 0) {
                logger.info(`\nCar Park: ${parkStats.name} (${siteId})`);
                logger.info(`Total Detections: ${parkStats.totalDetections}`);
                logger.info(`Unknown Directions: ${parkStats.unknownDirections} (${((parkStats.unknownDirections / parkStats.totalDetections) * 100).toFixed(2)}%)`);
                logger.info(`Unknown VRMs: ${parkStats.unknownVRMs} (${((parkStats.unknownVRMs / parkStats.totalDetections) * 100).toFixed(2)}%)`);
                logger.info('\nEvents:');
                logger.info(`- Created: ${parkStats.events.created}`);
                logger.info(`- Completed: ${parkStats.events.completed}`);
                logger.info(`- Through Traffic: ${parkStats.events.skipped.throughTraffic}`);
            }
        });
        
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
        logger.error('Error in markDetectionAsProcessed:', err);
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { generateParkingEvents }; 
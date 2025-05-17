const express = require('express');
const mariadb = require('mariadb');
require('dotenv').config();
const bodyParser = require('body-parser');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layouts/main');
app.use(express.static('public'));

// Configure body-parser middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Disable ETag generation
app.disable('etag');

// Database connection pool
const pool = mariadb.createPool({
    host: '192.168.1.151',
    user: 'root',
    password: 'RBTeeyKM142!',
    database: 'nocobase',
    connectionLimit: 10,
    connectTimeout: 5000,
    acquireTimeout: 5000,
    idleTimeout: 60000,
    trace: false,
    resetAfterUse: true
});

// Mount admin router
const adminRouter = require('./routes/admin')(pool);
app.use('/admin', adminRouter);

// Function to normalize VRM
function normalizeVRM(vrm) {
    if (!vrm) return vrm;
    // Remove all spaces and convert to uppercase
    return vrm.replace(/\s+/g, '').toUpperCase();
}

// Add BigInt serialization support at the top of the file
BigInt.prototype.toJSON = function() {
    return this.toString();
};

// Helper function to process buffer of detections
function processBuffer(site, vrm, buffer, throughLimit, events) {
    // Sort buffer by timestamp
    buffer.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let i = 0;
    while (i < buffer.length) {
        const entry = buffer[i];
        if (!entry.isEntry) {
            i++;
            continue;
        }

        // Look for any exit after this entry
        let exit = null;
        let j = i + 1;
        while (j < buffer.length) {
            if (buffer[j].isExit) {
                exit = buffer[j];
                break;
            }
            j++;
        }

        if (exit) {
            // Calculate duration
            const entryTime = new Date(entry.timestamp);
            const exitTime = new Date(exit.timestamp);
            const duration = (exitTime - entryTime) / (1000 * 60);
            console.log(`[EVENT] VRM: ${vrm}, Entry: ${entryTime.toISOString()}, Exit: ${exitTime.toISOString()}, Duration: ${duration.toFixed(1)} minutes`);
            
            const isThroughTraffic = duration <= throughLimit;
            events.push({
                siteId: site,
                VRM: vrm,
                entryTime: entry.timestamp,
                exitTime: exit.timestamp,
                durationMinutes: Math.round(duration * 10) / 10, // Round to 1 decimal place
                throughTraffic: isThroughTraffic,
                entryDetectionId: entry.detectionId,
                exitDetectionId: exit.detectionId,
                entryCameraId: entry.cameraID,
                exitCameraId: exit.cameraID
            });
            // Skip to after the exit detection
            i = j + 1;
        } else {
            // No exit found, mark as still parked
            events.push({
                siteId: site,
                VRM: vrm,
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
        }
    }
}

// Function to generate parking events
async function generateParkingEvents(conn, siteId = null) {
    // Build query with optional filters
    let query = `
        SELECT 
            d.id,
            d.VRM,
            d.timestamp,
            d.direction as detectionDirection,
            d.cameraID,
            c.carParkId,
            c.isEntryTrigger,
            c.isExitTrigger,
            c.direction as cameraDirection,
            cp.throughTrafficMinutes
        FROM anpr_detections d
        JOIN cameras c ON d.cameraID = c.name
        JOIN carparks cp ON c.carParkId = cp.siteId
        JOIN carpark_processing_status cps ON cp.siteId = cps.siteId
        WHERE cps.isEnabled = true
    `;
    
    const queryParams = [];
    
    // Add car park filter if provided
    if (siteId) {
        query += ' AND c.carParkId = ?';
        queryParams.push(siteId);
    }
    // Remove the 24 hour filter to see all events
    // query += ' AND d.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)';
    
    query += ' ORDER BY d.timestamp ASC';
    
    console.log('Fetching detections with query:', query);
    console.log('Query parameters:', queryParams);
    
    const detections = await conn.query(query, queryParams);
    console.log(`Found ${detections.length} detections to process`);
    
    // Process detections and generate events
    const events = [];
    let currentSite = null;
    let currentVRM = null;
    let buffer = [];
    let throughLimit = 10;
    
    for (const detection of detections) {
        // Normalize VRM
        const normalizedVRM = normalizeVRM(detection.VRM);
        
        // Determine if this detection is entry or exit
        const detectionDir = detection.detectionDirection?.toLowerCase();
        const cameraDir = detection.cameraDirection?.toLowerCase();
        
        const isEntry = detection.isEntryTrigger && (
            (detectionDir === 'towards' && cameraDir === 'in') ||
            (detectionDir === 'away' && cameraDir === 'out')
        );
        
        const isExit = detection.isExitTrigger && (
            (detectionDir === 'away' && cameraDir === 'in') ||
            (detectionDir === 'towards' && cameraDir === 'out')
        );
        
        if (isEntry || isExit) {
            if (detection.carParkId !== currentSite || normalizedVRM !== currentVRM) {
                // Process existing buffer
                if (buffer.length > 0) {
                    processBuffer(currentSite, currentVRM, buffer, throughLimit, events);
                }
                
                // Start new buffer
                currentSite = detection.carParkId;
                currentVRM = normalizedVRM;
                throughLimit = detection.throughTrafficMinutes || 10;
                buffer = [];
            }
            
            buffer.push({
                timestamp: detection.timestamp,
                isEntry,
                isExit,
                detectionId: detection.id,
                VRM: normalizedVRM,
                cameraID: detection.cameraID
            });
        }
    }
    
    // Process final buffer
    if (buffer.length > 0) {
        processBuffer(currentSite, currentVRM, buffer, throughLimit, events);
    }
    
    return events;
}

// Route to display ANPR detections (real-time view) - now at /realtime
app.get('/realtime', async (req, res) => {
    let conn;
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    try {
        conn = await pool.getConnection();

        // Get car parks for filter dropdown (optional)
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const selectedCarPark = req.query.siteId || '';

        // Build query
        let query = `
            SELECT id, VRM, createdAt, type, timestamp, direction, confidence, tag, tagConfidence, country, cameraID, image1, image2
            FROM anpr_detections
        `;
        const queryParams = [];
        if (selectedCarPark) {
            query += ' WHERE cameraID IN (SELECT name FROM cameras WHERE carParkId = ?)';
            queryParams.push(selectedCarPark);
        }
        query += ' ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?';
        queryParams.push(limit, offset);

        const rows = await conn.query(query, queryParams);

        // Format for EJS
        const detections = rows.map(row => ({
            ...row,
            VRM: normalizeVRM(row.VRM),
            createdAt: row.createdAt instanceof Date
                ? row.createdAt.toISOString().replace('T', ' ').substring(0, 19)
                : row.createdAt,
            timestamp: row.timestamp instanceof Date
                ? row.timestamp.toISOString().replace('T', ' ').substring(0, 19)
                : row.timestamp,
            hasImage1: !!row.image1,
            hasImage2: !!row.image2
        }));

        // Pagination
        const countResult = await conn.query(selectedCarPark
            ? 'SELECT COUNT(*) as count FROM anpr_detections WHERE cameraID IN (SELECT name FROM cameras WHERE carParkId = ?)' 
            : 'SELECT COUNT(*) as count FROM anpr_detections',
            selectedCarPark ? [selectedCarPark] : []);
        const total = Number(countResult[0].count);
        const totalPages = Math.ceil(total / limit);

        res.render('realtime', {
            detections,
            page,
            totalPages,
            carparks,
            selectedCarPark
        });
    } catch (err) {
        console.error('Error fetching data:', err);
        res.status(500).render('error', { message: 'Error fetching data' });
    } finally {
        if (conn) conn.release();
    }
});

// Main dashboard: Completed Parking Events
app.get('/events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const selectedCarPark = req.query.siteId || '';
        
        // Build query to fetch only completed events
        let query = `
            SELECT 
                pe.*,
                cp.name as carParkName,
                entry_d.VRM as entryVRM,
                entry_d.timestamp as entryTimestamp,
                (LENGTH(entry_d.image1) > 0) as hasEntryImage1,
                (LENGTH(entry_d.image2) > 0) as hasEntryImage2,
                exit_d.VRM as exitVRM,
                exit_d.timestamp as exitTimestamp,
                (LENGTH(exit_d.image1) > 0) as hasExitImage1,
                (LENGTH(exit_d.image2) > 0) as hasExitImage2
            FROM parking_events pe
            JOIN carparks cp ON pe.siteId = cp.siteId
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            LEFT JOIN anpr_detections exit_d ON pe.exitDetectionId = exit_d.id
            WHERE pe.exitTime IS NOT NULL
        `;
        const queryParams = [];
        
        if (selectedCarPark) {
            query += ' AND pe.siteId = ?';
            queryParams.push(selectedCarPark);
        }
        
        query += ' ORDER BY pe.entryTime DESC';
        
        const events = await conn.query(query, queryParams);
        res.render('events', { 
            carparks,
            selectedCarPark,
            events,
            tab: 'completed'
        });
    } catch (err) {
        console.error('Error loading events:', err);
        res.status(500).render('error', { message: 'Error loading events' });
    } finally {
        if (conn) conn.release();
    }
});

// Currently Parked tab
app.get('/currently-parked', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const selectedCarPark = req.query.siteId || '';
        
        // Build query to fetch only currently parked events
        let query = `
            SELECT 
                pe.*,
                cp.name as carParkName,
                entry_d.VRM as entryVRM,
                entry_d.timestamp as entryTimestamp,
                (LENGTH(entry_d.image1) > 0) as hasEntryImage1,
                (LENGTH(entry_d.image2) > 0) as hasEntryImage2
            FROM parking_events pe
            JOIN carparks cp ON pe.siteId = cp.siteId
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            WHERE pe.exitTime IS NULL
        `;
        const queryParams = [];
        
        if (selectedCarPark) {
            query += ' AND pe.siteId = ?';
            queryParams.push(selectedCarPark);
        }
        
        query += ' ORDER BY pe.entryTime DESC';
        
        const events = await conn.query(query, queryParams);
        res.render('currently_parked', { 
            carparks,
            selectedCarPark,
            events,
            tab: 'parked'
        });
    } catch (err) {
        console.error('Error loading currently parked:', err);
        res.status(500).render('error', { message: 'Error loading currently parked' });
    } finally {
        if (conn) conn.release();
    }
});

// Keep the existing root route for backward compatibility
app.get('/', async (req, res) => {
    res.redirect('/events');
});

// Route to serve blob images
app.get('/image/:id/:type', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const detectionId = req.params.id;
        const imageType = req.params.type === '2' ? 'image2' : 'image1';

        console.log(`[IMAGE ROUTE] Fetching ${imageType} for detection ID ${detectionId}`);

        // Get the raw binary BLOB data
        const imageQuery = `
            SELECT ${imageType} as image
            FROM anpr_detections
            WHERE id = ?
        `;
        const rows = await conn.query(imageQuery, [detectionId]);

        console.log(`[IMAGE ROUTE] Query returned ${rows.length} rows`);

        if (rows.length === 0 || !rows[0].image) {
            console.log(`[IMAGE ROUTE] No image found for detection ID ${detectionId}, sending placeholder`);
            return res.status(404).sendFile(path.join(__dirname, 'public', 'images', 'placeholder.jpg'));
        }

        const img = rows[0].image;
        console.log(`[IMAGE ROUTE] Image data type: ${typeof img}, is Buffer: ${Buffer.isBuffer(img)}`);
        console.log(`[IMAGE ROUTE] Image data length: ${img.length} bytes`);

        let buffer;
        if (Buffer.isBuffer(img)) {
            // Check if it's actually base64 in a buffer (rare, but possible)
            const asString = img.toString('utf8');
            if (asString.startsWith('/9j/')) {
                console.log('[IMAGE ROUTE] Buffer contains base64 string, decoding...');
                buffer = Buffer.from(asString, 'base64');
            } else {
                buffer = img;
            }
        } else if (typeof img === 'string' && img.startsWith('/9j/')) {
            console.log('[IMAGE ROUTE] String is base64, decoding...');
            buffer = Buffer.from(img, 'base64');
        } else {
            console.log('[IMAGE ROUTE] Unknown image format, sending placeholder');
            return res.status(404).sendFile(path.join(__dirname, 'public', 'images', 'placeholder.jpg'));
        }

        // Log the first 16 bytes of the decoded buffer
        const header = buffer.slice(0, 16);
        console.log(`[IMAGE ROUTE] Decoded first 16 bytes (hex): ${header.toString('hex')}`);
        if (header[0] === 0xFF && header[1] === 0xD8) {
            console.log('[IMAGE ROUTE] Valid JPEG signature found after decoding');
        } else {
            console.log('[IMAGE ROUTE] Warning: Not a standard JPEG signature after decoding');
        }

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': buffer.length,
            'Cache-Control': 'public, max-age=31536000',
            'Accept-Ranges': 'bytes'
        });
        res.send(buffer);
        console.log(`[IMAGE ROUTE] Successfully sent image of length ${buffer.length} bytes`);
        return;
    } catch (err) {
        console.error('[IMAGE ROUTE] Error:', err);
        res.status(500).send('Error fetching image');
    } finally {
        if (conn) conn.release();
    }
});

// API endpoint to fetch latest detections as JSON (excluding image blobs)
app.get('/api/detections', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const rows = await conn.query(`SELECT id, VRM, createdAt, type, timestamp, direction, confidence, tag, tagConfidence, country, cameraId FROM anpr_detections ORDER BY id DESC LIMIT 10`);
        res.json(
          rows.map(row =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
            )
          )
        );
    } catch (err) {
        console.error('Error fetching API data:', err);
        res.status(500).json({ error: 'Error fetching data' });
    } finally {
        if (conn) conn.release();
    }
});

// API endpoint to infer parking events
app.get('/api/parking-events', async (req, res) => {
    let conn;
    const siteId = req.query.siteId;
    try {
        conn = await pool.getConnection();
        const events = await generateParkingEvents(conn, siteId);
        res.json(events);
    } catch (err) {
        console.error('Error inferring parking events:', err);
        res.status(500).json({ error: 'Error inferring parking events' });
    } finally {
        if (conn) conn.release();
    }
});

// Endpoint to generate events retrospectively
app.get('/admin/generate-events', async (req, res) => {
    let conn;
    try {
        console.log('Starting event generation...');
        conn = await pool.getConnection();
        const events = await generateParkingEvents(conn);
        
        console.log('Storing events in database...');
        // Store events in the database
        for (const event of events) {
            await conn.query(`
                INSERT INTO parking_events 
                (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic, entryDetectionId, exitDetectionId, entryCameraId, exitCameraId)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                exitTime = VALUES(exitTime),
                durationMinutes = VALUES(durationMinutes),
                throughTraffic = VALUES(throughTraffic),
                exitDetectionId = VALUES(exitDetectionId),
                exitCameraId = VALUES(exitCameraId)
            `, [
                event.siteId,
                event.VRM,
                event.entryTime,
                event.exitTime,
                event.durationMinutes,
                event.throughTraffic,
                event.entryDetectionId,
                event.exitDetectionId,
                event.entryCameraId,
                event.exitCameraId
            ]);
        }
        
        console.log('Event generation complete. Redirecting...');
        res.redirect('/?message=Generated ' + events.length + ' parking events');
    } catch (err) {
        console.error('Error generating events:', err);
        res.status(500).render('error', { message: 'Error generating events: ' + err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Keep the POST endpoint for API calls
app.post('/admin/generate-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const events = await generateParkingEvents(conn);
        
        // Store events in the database
        for (const event of events) {
            await conn.query(`
                INSERT INTO parking_events 
                (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic, entryDetectionId, exitDetectionId, entryCameraId, exitCameraId)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                exitTime = VALUES(exitTime),
                durationMinutes = VALUES(durationMinutes),
                throughTraffic = VALUES(throughTraffic),
                exitDetectionId = VALUES(exitDetectionId),
                exitCameraId = VALUES(exitCameraId)
            `, [
                event.siteId,
                event.VRM,
                event.entryTime,
                event.exitTime,
                event.durationMinutes,
                event.throughTraffic,
                event.entryDetectionId,
                event.exitDetectionId,
                event.entryCameraId,
                event.exitCameraId
            ]);
        }
        
        res.json({ 
            success: true, 
            message: `Generated ${events.length} parking events` 
        });
    } catch (err) {
        console.error('Error generating events:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Automated PCN generation job (runs every 5 minutes)
setInterval(async () => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks with automation enabled
        const carparks = await conn.query('SELECT * FROM pcn_automation_settings WHERE isEnabled = true');
        for (const cp of carparks) {
            const siteId = cp.siteId;
            const grace = cp.gracePeriodMinutes || 0;
            // Get all active, autoEnforce rules for this car park
            const rules = await conn.query('SELECT * FROM rules WHERE siteId = ? AND isActive = true AND autoEnforce = true', [siteId]);
            if (!rules.length) continue;
            // Get all completed events since lastChecked (or last 24h if never checked)
            const since = cp.lastChecked ? new Date(cp.lastChecked) : new Date(Date.now() - 24*60*60*1000);
            const events = await conn.query(
                'SELECT * FROM parking_events WHERE siteId = ? AND exitTime IS NOT NULL AND entryTime > ?',
                [siteId, since]
            );
            for (const event of events) {
                // For each rule, check for violation
                for (const rule of rules) {
                    let violated = false;
                    let reason = '';
                    
                    // Check rule type and conditions
                    switch (rule.ruleType) {
                        case 'time_limit':
                            if (rule.maxDurationMinutes && event.durationMinutes > (rule.maxDurationMinutes + grace)) {
                                violated = true;
                                reason = `Overstayed: ${event.durationMinutes} min > limit ${rule.maxDurationMinutes} min (+${grace} grace)`;
                            }
                            break;
                            
                        case 'whitelist':
                            // Check if VRM is in whitelist
                            const [whitelist] = await conn.query(
                                'SELECT COUNT(*) as count FROM rule_whitelist WHERE ruleId = ? AND VRM = ?',
                                [rule.id, event.VRM]
                            );
                            if (whitelist.count === 0) {
                                violated = true;
                                reason = 'Vehicle not in whitelist';
                            }
                            break;
                            
                        case 'payment':
                            // Check if payment was made for this event
                            const [payment] = await conn.query(
                                'SELECT COUNT(*) as count FROM payments WHERE eventId = ? AND status = "completed"',
                                [event.id]
                            );
                            if (payment.count === 0) {
                                violated = true;
                                reason = 'No payment made for parking';
                            }
                            break;
                    }
                    
                    if (violated) {
                        // Check if PCN already exists for this event/rule
                        const existing = await conn.query(
                            'SELECT id FROM pcns WHERE siteId = ? AND VRM = ? AND ruleId = ? AND issueTime = ?',
                            [siteId, event.VRM, rule.id, event.exitTime]
                        );
                        if (existing.length) continue;
                        
                        // Generate PCN
                        const dueDate = new Date();
                        dueDate.setDate(dueDate.getDate() + 28); // 28 days to pay
                        
                        const [pcn] = await conn.query(
                            `INSERT INTO pcns (
                                siteId, VRM, ruleId, eventId, issueTime, dueDate, 
                                amount, reason, status
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
                            [
                                siteId, event.VRM, rule.id, event.id, event.exitTime,
                                dueDate, rule.pcnAmount, reason || rule.pcnReason
                            ]
                        );
                        
                        // Log PCN generation
                        await conn.query(
                            `INSERT INTO pcn_audit_log (
                                pcnId, action, details
                            ) VALUES (?, 'issued', ?)`,
                            [pcn.insertId, JSON.stringify({
                                ruleId: rule.id,
                                eventId: event.id,
                                reason: reason || rule.pcnReason
                            })]
                        );
                        
                        // Send notifications if enabled
                        if (rule.notifyOnIssue && cp.notifyEmails) {
                            const emails = cp.notifyEmails.split(',').map(e => e.trim());
                            for (const email of emails) {
                                // TODO: Implement actual email sending
                                console.log(`Would send PCN notification to ${email} for PCN #${pcn.insertId}`);
                            }
                        }
                    }
                }
            }
            
            // Update lastChecked timestamp
            await conn.query(
                'UPDATE pcn_automation_settings SET lastChecked = NOW() WHERE siteId = ?',
                [siteId]
            );
        }
    } catch (err) {
        console.error('Error in PCN automation job:', err);
    } finally {
        if (conn) conn.release();
    }
}, 5 * 60 * 1000); // Run every 5 minutes

// Admin navigation
app.get('/admin', (req, res) => {
    res.render('admin_nav');
});

// Car parks management
app.get('/admin/carparks', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        res.render('admin/carparks', { 
            carparks,
            selectedCarPark: null
        });
    } catch (err) {
        console.error('Error loading car parks:', err);
        res.status(500).render('error', { message: 'Error loading car parks' });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/carparks/add', async (req, res) => {
    let conn;
    try {
        const { siteId, name, throughTrafficMinutes } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'INSERT INTO carparks (siteId, name, throughTrafficMinutes) VALUES (?, ?, ?)',
            [siteId, name, throughTrafficMinutes]
        );
        res.redirect('/admin/carparks');
    } catch (err) {
        console.error('Error adding car park:', err);
        res.status(500).render('error', { message: 'Error adding car park' });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/carparks/edit', async (req, res) => {
    let conn;
    try {
        const { originalSiteId, siteId, name, throughTrafficMinutes } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE carparks SET siteId = ?, name = ?, throughTrafficMinutes = ? WHERE siteId = ?',
            [siteId, name, throughTrafficMinutes, originalSiteId]
        );
        res.redirect('/admin/carparks');
    } catch (err) {
        console.error('Error updating car park:', err);
        res.status(500).render('error', { message: 'Error updating car park' });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/carparks/delete', async (req, res) => {
    let conn;
    try {
        const { siteId } = req.body;
        conn = await pool.getConnection();
        
        // Check if car park has cameras
        const cameras = await conn.query('SELECT COUNT(*) as count FROM cameras WHERE carParkId = ?', [siteId]);
        if (cameras[0].count > 0) {
            return res.status(400).render('error', { message: 'Cannot delete car park: has cameras assigned' });
        }
        
        await conn.query('DELETE FROM carparks WHERE siteId = ?', [siteId]);
        res.redirect('/admin/carparks');
    } catch (err) {
        console.error('Error deleting car park:', err);
        res.status(500).render('error', { message: 'Error deleting car park' });
    } finally {
        if (conn) conn.release();
    }
});

// Cameras management
app.get('/admin/cameras', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get cameras with their associated car park names
        const cameras = await conn.query(`
            SELECT DISTINCT 
                c.name,
                c.carParkId,
                c.isEntryTrigger,
                c.isExitTrigger,
                c.direction,
                cp.name as carparkName
            FROM cameras c
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId
            ORDER BY c.name
        `);
        
        // Get car parks for the dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        
        res.render('admin/cameras', { 
            cameras,
            carparks,
            selectedCarPark: null
        });
    } catch (err) {
        console.error('Error fetching cameras:', err);
        res.status(500).send('Error fetching cameras: ' + err.message);
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/cameras/edit', async (req, res) => {
    let conn;
    try {
        const { originalName, name, carParkId, isEntryTrigger, isExitTrigger, direction } = req.body;
        conn = await pool.getConnection();
        
        // Check if another camera has this name (excluding the current camera)
        if (name !== originalName) {
            const existing = await conn.query('SELECT name FROM cameras WHERE name = ?', [name]);
            if (existing.length > 0) {
                res.status(400).json({ error: 'Another camera already has this name' });
                return;
            }
        }
        
        // Convert checkbox values to booleans
        const isEntry = isEntryTrigger === 'on' || isEntryTrigger === true || isEntryTrigger === 'true';
        const isExit = isExitTrigger === 'on' || isExitTrigger === true || isExitTrigger === 'true';
        
        // Update camera
        await conn.query(`
            UPDATE cameras 
            SET name = ?,
                carParkId = ?, 
                isEntryTrigger = ?, 
                isExitTrigger = ?, 
                direction = ?
            WHERE name = ?
        `, [
            name,
            carParkId || null,  // Keep as string
            isEntry,
            isExit,
            direction, 
            originalName
        ]);
        
        // Get updated camera data
        const updatedCamera = await conn.query(`
            SELECT 
                c.name,
                c.carParkId,
                c.isEntryTrigger,
                c.isExitTrigger,
                c.direction,
                cp.name as carparkName
            FROM cameras c
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId
            WHERE c.name = ?
        `, [name]);
        
        res.json({ 
            success: true,
            camera: updatedCamera[0]
        });
    } catch (err) {
        console.error('Error updating camera:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/cameras/add', async (req, res) => {
    let conn;
    try {
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction } = req.body;
        conn = await pool.getConnection();
        
        // Check if camera with this name already exists
        const existing = await conn.query('SELECT name FROM cameras WHERE name = ?', [name]);
        if (existing.length > 0) {
            res.status(400).json({ error: 'A camera with this name already exists' });
            return;
        }
        
        // Convert checkbox values to booleans
        const isEntry = isEntryTrigger === 'on' || isEntryTrigger === true || isEntryTrigger === 'true';
        const isExit = isExitTrigger === 'on' || isExitTrigger === true || isExitTrigger === 'true';
        
        // Insert new camera
        await conn.query(`
            INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction)
            VALUES (?, ?, ?, ?, ?)
        `, [name, carParkId || null, isEntry, isExit, direction]);
        
        // Get the newly created camera with car park info
        const newCamera = await conn.query(`
            SELECT 
                c.name,
                c.carParkId,
                c.isEntryTrigger,
                c.isExitTrigger,
                c.direction,
                cp.name as carparkName
            FROM cameras c
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId
            WHERE c.name = ?
        `, [name]);
        
        res.json({ 
            success: true,
            camera: newCamera[0]
        });
    } catch (err) {
        console.error('Error adding camera:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/cameras/delete', async (req, res) => {
    let conn;
    try {
        const { name } = req.body;
        conn = await pool.getConnection();
        
        // Check if camera has any detections
        const detections = await conn.query('SELECT id FROM anpr_detections WHERE cameraID = ?', [name]);
        if (detections.length > 0) {
            res.status(400).json({ error: 'Cannot delete camera: it has existing detections' });
            return;
        }
        
        await conn.query('DELETE FROM cameras WHERE name = ?', [name]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting camera:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Camera Status & Metrics Dashboard
app.get('/camera-status', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const selectedCarPark = req.query.siteId || '';
        
        // Build query with optional car park filter
        let query = `
            SELECT DISTINCT 
                c.name,
                c.isEntryTrigger,
                c.isExitTrigger,
                c.direction,
                c.carParkId,
                MAX(d.timestamp) as lastDetection,
                COUNT(d.id) as detectionCount,
                SUM(CASE WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 1 ELSE 0 END) as lastHour,
                SUM(CASE WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) as lastDay,
                SUM(CASE WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as lastMonth,
                SUM(CASE 
                    WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                    AND HOUR(d.timestamp) BETWEEN 6 AND 18 
                    THEN 1 ELSE 0 END) as day24h,
                SUM(CASE 
                    WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                    AND (HOUR(d.timestamp) < 6 OR HOUR(d.timestamp) > 18)
                    THEN 1 ELSE 0 END) as night24h,
                SUM(CASE 
                    WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                    AND HOUR(d.timestamp) BETWEEN 6 AND 18 
                    THEN 1 ELSE 0 END) as day30d,
                SUM(CASE 
                    WHEN d.timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                    AND (HOUR(d.timestamp) < 6 OR HOUR(d.timestamp) > 18)
                    THEN 1 ELSE 0 END) as night30d
            FROM cameras c
            LEFT JOIN anpr_detections d ON c.name = d.cameraID
        `;
        
        if (selectedCarPark) {
            query += ' WHERE c.carParkId = ?';
        }
        
        query += ' GROUP BY c.name, c.isEntryTrigger, c.isExitTrigger, c.direction, c.carParkId';
        
        const camerasWithStats = await conn.query(query, selectedCarPark ? [selectedCarPark] : []);
        
        // For each camera, compute avgInterval, status, and limits, and fetch last image1 detection ID
        const processedCameras = await Promise.all(camerasWithStats.map(async camera => {
            // Get all detection timestamps in last 24h for this camera
            const times = await conn.query(
                'SELECT timestamp FROM anpr_detections WHERE cameraID = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY timestamp ASC',
                [camera.name]
            );
            let avgInterval = null;
            if (times.length > 1) {
                let total = 0;
                for (let i = 1; i < times.length; i++) {
                    const prev = new Date(times[i-1].timestamp);
                    const curr = new Date(times[i].timestamp);
                    total += (curr - prev) / 60000; // minutes
                }
                avgInterval = total / (times.length - 1);
            }
            // Status logic
            let status = 'offline';
            let lastDetectionDate = camera.lastDetection ? new Date(camera.lastDetection) : null;
            if (lastDetectionDate) {
                const diffMin = (Date.now() - lastDetectionDate.getTime()) / 60000;
                if (diffMin <= 10) status = 'online';
                else if (diffMin <= 60) status = 'anomaly';
            }
            // Entry direction (if available)
            let entryDirection = null;
            if (camera.isEntryTrigger) entryDirection = camera.direction;
            // Limits (could be per-camera or global; here, use defaults)
            const greenLimit = 10;
            const yellowLimit = 60;
            // Fetch last image1 detection ID for this camera
            const [lastImageDetection] = await conn.query(
                'SELECT id FROM anpr_detections WHERE cameraID = ? AND image1 IS NOT NULL ORDER BY timestamp DESC LIMIT 1',
                [camera.name]
            );
            const lastImageDetectionId = lastImageDetection ? lastImageDetection.id : null;

            // --- Sparkline: detections per hour for last 24h ---
            const sparklineBuckets = Array(24).fill(0);
            const sparklineRows = await conn.query(
                `SELECT HOUR(TIMESTAMPDIFF(HOUR, timestamp, NOW())) as hour_diff, COUNT(*) as count
                 FROM anpr_detections
                 WHERE cameraID = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                 GROUP BY hour_diff`,
                [camera.name]
            );
            // Fill buckets: hour_diff=0 is current hour, hour_diff=23 is 23 hours ago
            sparklineRows.forEach(row => {
                const idx = 23 - row.hour_diff; // reverse so left is oldest, right is most recent
                if (idx >= 0 && idx < 24) sparklineBuckets[idx] = row.count;
            });

            return {
                ...camera,
                status,
                avgInterval,
                greenLimit,
                yellowLimit,
                entryDirection,
                lastImageDetectionId,
                sparkline: sparklineBuckets
            };
        }));
        
        res.render('camera_status', { 
            cameras: processedCameras,
            carparks,
            selectedCarPark
        });
    } catch (err) {
        console.error('Error fetching camera status:', err);
        res.status(500).render('error', { message: 'Failed to fetch camera status: ' + err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Update the regenerate events endpoint
app.get('/admin/regenerate-events', async (req, res) => {
    let conn;
    try {
        console.log('Starting event regeneration...');
        conn = await pool.getConnection();
        
        // First clear existing events
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.query('TRUNCATE TABLE parking_events');
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        
        // Generate new events
        const events = await generateParkingEvents(conn, req.query.carParkId);
        
        console.log(`Generated ${events.length} events`);
        
        // Store events in database
        console.log('Storing events in database...');
        for (const event of events) {
            try {
                await conn.query(`
                    INSERT INTO parking_events 
                    (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic, 
                     entryDetectionId, exitDetectionId, entryCameraId, exitCameraId)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                    exitTime = VALUES(exitTime),
                    durationMinutes = VALUES(durationMinutes),
                    throughTraffic = VALUES(throughTraffic),
                    exitDetectionId = VALUES(exitDetectionId),
                    exitCameraId = VALUES(exitCameraId)
                `, [
                    event.siteId,
                    event.VRM,
                    event.entryTime,
                    event.exitTime,
                    event.durationMinutes,
                    event.throughTraffic,
                    event.entryDetectionId,
                    event.exitDetectionId,
                    event.entryCameraId,
                    event.exitCameraId
                ]);
            } catch (err) {
                console.error('Error inserting event:', err);
                console.error('Event data:', event);
            }
        }
        
        console.log('Events regenerated successfully');
        res.json({ 
            success: true, 
            message: `Generated ${events.length} parking events` 
        });
        
    } catch (err) {
        console.error('Error regenerating events:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Admin route to purge all parking events
app.post('/admin/purge-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.query('TRUNCATE TABLE parking_events');
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        res.json({ success: true, message: 'All parking events purged.' });
    } catch (err) {
        console.error('Error purging parking events:', err);
        res.status(500).json({ error: 'Failed to purge parking events.' });
    } finally {
        if (conn) conn.release();
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'uploads', 'detections'));
    },
    filename: function (req, file, cb) {
        // Temporary filename, will be renamed after saving to database
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'uploads', 'detections');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created upload directory:', uploadDir);
}

// For public uploads
const publicUploadDir = path.join(__dirname, 'public', 'uploads', 'detections');
if (!fs.existsSync(publicUploadDir)) {
    fs.mkdirSync(publicUploadDir, { recursive: true });
    console.log('Created public upload directory:', publicUploadDir);
}

app.post('/api/detection', upload.array('images', 2), async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Insert the detection record
        const [result] = await conn.query(
            `INSERT INTO anpr_detections 
            (VRM, type, timestamp, direction, confidence, tag, tagConfidence, country, cameraID) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.body.VRM,
                req.body.type,
                req.body.timestamp,
                req.body.direction,
                req.body.confidence,
                req.body.tag,
                req.body.tagConfidence,
                req.body.country,
                req.body.cameraID
            ]
        );
        
        const detectionId = result.insertId;
        
        // Save images to database
        if (req.files && req.files.length > 0) {
            for (let i = 0; i < req.files.length; i++) {
                const imageField = i === 0 ? 'image1' : 'image2';
                const imageData = fs.readFileSync(req.files[i].path);
                
                // Update the detection record with image data
                await conn.query(
                    `UPDATE anpr_detections SET ${imageField} = ? WHERE id = ?`,
                    [imageData, detectionId]
                );
                
                // Clean up the temporary file
                fs.unlinkSync(req.files[i].path);
            }
        }
        
        res.json({
            success: true,
            message: 'Detection processed successfully',
            detectionId: detectionId
        });
        
    } catch (error) {
        console.error('Error processing detection:', error);
        res.status(500).json({ error: 'Failed to process detection' });
    } finally {
        if (conn) conn.release();
    }
});

// Admin utility route to check database consistency
app.get('/admin/check-images', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Get events and detections
        const events = await conn.query('SELECT * FROM parking_events');
        const detections = await conn.query('SELECT id FROM anpr_detections');
        
        const results = {
            totalEvents: events.length,
            totalDetections: detections.length,
            eventsWithMissingEntryDetection: 0,
            eventsWithMissingExitDetection: 0,
            detectionsWithMissingImages: 0,
            detectionIds: {}
        };
        
        // Check events
        for (const event of events) {
            if (event.entryDetectionId) {
                const detection = detections.find(d => d.id === event.entryDetectionId);
                if (!detection) {
                    results.eventsWithMissingEntryDetection++;
                }
            }
            
            if (event.exitDetectionId) {
                const detection = detections.find(d => d.id === event.exitDetectionId);
                if (!detection) {
                    results.eventsWithMissingExitDetection++;
                }
            }
        }
        
        // Check detections
        for (const detection of detections) {
            const id = detection.id;
            results.detectionIds[id] = {
                hasImage1: false,
                hasImage2: false
            };
            
            const imagePath1 = path.join(__dirname, 'uploads', 'detections', `${id}_1.jpg`);
            const imagePath2 = path.join(__dirname, 'uploads', 'detections', `${id}_2.jpg`);
            
            if (fs.existsSync(imagePath1)) {
                results.detectionIds[id].hasImage1 = true;
            }
            
            if (fs.existsSync(imagePath2)) {
                results.detectionIds[id].hasImage2 = true;
            }
            
            if (!results.detectionIds[id].hasImage1 && !results.detectionIds[id].hasImage2) {
                results.detectionsWithMissingImages++;
            }
        }
        
        res.json(results);
    } catch (error) {
        console.error('Error checking database consistency:', error);
        res.status(500).json({ error: 'Failed to check database consistency' });
    } finally {
        if (conn) conn.release();
    }
});

// Event details page
app.get('/events/:id', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const eventId = req.params.id;
        // Get the event and join with carpark, camera, and detection info
        const [event] = await conn.query(`
            SELECT e.*, 
                   cp.name as carparkName,
                   ec.name as entryCameraName, ec.direction as entryDirection,
                   xc.name as exitCameraName, xc.direction as exitDirection,
                   ed.confidence as entryConfidence, ed.tag as entryTag, ed.tagConfidence as entryTagConfidence, ed.country as entryCountry,
                   xd.confidence as exitConfidence, xd.tag as exitTag, xd.tagConfidence as exitTagConfidence, xd.country as exitCountry
            FROM parking_events e
            LEFT JOIN carparks cp ON e.siteId = cp.siteId
            LEFT JOIN cameras ec ON e.entryCameraId = ec.name
            LEFT JOIN cameras xc ON e.exitCameraId = xc.name
            LEFT JOIN anpr_detections ed ON e.entryDetectionId = ed.id
            LEFT JOIN anpr_detections xd ON e.exitDetectionId = xd.id
            WHERE e.id = ?
        `, [eventId]);
        if (!event) {
            return res.status(404).render('error', { message: 'Event not found' });
        }
        // Fetch other events at the same car park with the same VRM (excluding this event)
        const relatedEvents = await conn.query(`
            SELECT id, entryTime, exitTime, durationMinutes, throughTraffic
            FROM parking_events
            WHERE siteId = ? AND VRM = ? AND id != ?
            ORDER BY entryTime DESC
        `, [event.siteId, event.VRM, eventId]);
        // Fetch all detections at the same car park for the same VRM
        const relatedDetections = await conn.query(`
            SELECT d.id, d.timestamp, d.cameraID, d.direction, d.confidence, d.tag, d.tagConfidence, d.country
            FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.name
            WHERE c.carParkId = ? AND d.VRM = ?
            ORDER BY d.timestamp ASC
        `, [event.siteId, event.VRM]);
        res.render('event_details', { event, pcns: [], entryFlags: [], exitFlags: [], relatedEvents, relatedDetections });
    } catch (err) {
        console.error('Error loading event details:', err);
        res.status(500).render('error', { message: 'Error loading event details' });
    } finally {
        if (conn) conn.release();
    }
});

app.get('/test-image', (req, res) => {
    res.set('Content-Type', 'image/jpeg');
    res.sendFile(path.join(__dirname, 'public', 'images', 'test.jpg'));
    console.log('[TEST IMAGE ROUTE] Sent test image from disk');
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Ensure migrations table exists on server start
async function ensureMigrationsTable() {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query(`CREATE TABLE IF NOT EXISTS migrations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (err) {
        console.error('Error ensuring migrations table:', err);
    } finally {
        if (conn) conn.release();
    }
}
ensureMigrationsTable();

// List all migrations and their status
app.get('/admin/migrations', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // List .sql files in migrations dir
        const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
        // Get applied migrations
        const applied = await conn.query('SELECT filename, applied_at FROM migrations');
        const appliedMap = Object.fromEntries(applied.map(m => [m.filename, m.applied_at]));
        // Compose migration list
        const migrations = files.map(filename => ({
            filename,
            applied_at: appliedMap[filename] || null
        })).sort((a, b) => a.filename.localeCompare(b.filename));
        res.render('admin/migrations', { migrations });
    } catch (err) {
        console.error('Error listing migrations:', err);
        res.status(500).render('error', { message: 'Error listing migrations' });
    } finally {
        if (conn) conn.release();
    }
});

// Apply a migration by filename
app.post('/admin/migrations/apply', async (req, res) => {
    let conn;
    const { filename } = req.body;
    if (!filename || !filename.endsWith('.sql')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(MIGRATIONS_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Migration file not found' });
    }
    try {
        conn = await pool.getConnection();
        // Check if already applied
        const [existing] = await conn.query('SELECT * FROM migrations WHERE filename = ?', [filename]);
        if (existing) {
            return res.status(400).json({ error: 'Migration already applied' });
        }
        // Read and run SQL
        const sql = fs.readFileSync(filePath, 'utf8');
        await conn.query('START TRANSACTION');
        await conn.query(sql);
        await conn.query('INSERT INTO migrations (filename) VALUES (?)', [filename]);
        await conn.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        if (conn) await conn.query('ROLLBACK');
        console.error('Error applying migration:', err);
        res.status(500).json({ error: 'Error applying migration: ' + err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Admin debug: camera/detection mapping
app.get('/admin/camera-detection-mapping', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Fetch all cameras
        const cameras = await conn.query('SELECT * FROM cameras');
        // Fetch all unique cameraIDs from detections, with counts and last detection
        const detectionStats = await conn.query(`
            SELECT cameraID, COUNT(*) as count, MAX(timestamp) as lastDetection
            FROM anpr_detections
            GROUP BY cameraID
        `);
        // Build lookup maps
        const cameraNameMap = Object.fromEntries(cameras.map(c => [c.name, c]));
        const cameraNameLowerMap = Object.fromEntries(cameras.map(c => [c.name.toLowerCase().replace(/\s+/g, ''), c]));
        // Analyze mappings
        const detectionCameraIDs = detectionStats.map(d => d.cameraID);
        // Cameras with no detections
        const camerasNoDetections = cameras.filter(c => !detectionCameraIDs.includes(c.name));
        // Detections with no matching camera (exact)
        const detectionsNoCamera = detectionStats.filter(d => !cameraNameMap[d.cameraID]);
        // Detections with no matching camera (case/whitespace-insensitive)
        const detectionsNoCameraInsensitive = detectionStats.filter(d => {
            const norm = d.cameraID ? d.cameraID.toLowerCase().replace(/\s+/g, '') : '';
            return norm && !cameraNameLowerMap[norm];
        });
        res.render('admin/camera_detection_mapping', {
            cameras,
            detectionStats,
            camerasNoDetections,
            detectionsNoCamera,
            detectionsNoCameraInsensitive
        });
    } catch (err) {
        console.error('Error loading camera/detection mapping:', err);
        res.status(500).render('error', { message: 'Error loading camera/detection mapping' });
    } finally {
        if (conn) conn.release();
    }
});

// Debug endpoint to check detection timestamps and durations
app.get('/admin/debug-durations', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Get the last 20 detections
        const detections = await conn.query(`
            SELECT id, VRM, timestamp, cameraID, direction
            FROM anpr_detections 
            ORDER BY timestamp DESC 
            LIMIT 20
        `);
        
        // Get the last 20 parking events
        const events = await conn.query(`
            SELECT id, VRM, entryTime, exitTime, durationMinutes, throughTraffic
            FROM parking_events
            ORDER BY entryTime DESC
            LIMIT 20
        `);
        
        // Get camera configurations
        const cameras = await conn.query(`
            SELECT name, isEntryTrigger, isExitTrigger, direction
            FROM cameras
        `);
        
        res.json({
            detections: detections.map(d => ({
                ...d,
                timestamp: d.timestamp.toISOString()
            })),
            events: events.map(e => ({
                ...e,
                entryTime: e.entryTime ? new Date(e.entryTime).toISOString() : null,
                exitTime: e.exitTime ? new Date(e.exitTime).toISOString() : null
            })),
            cameras
        });
    } catch (err) {
        console.error('Error in debug endpoint:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Debug endpoint to check events for CP6
app.get('/debug/cp6-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const events = await conn.query(`
            SELECT e.*, 
                   cp.name as carparkName,
                   ed.VRM as entryVRM,
                   ed.timestamp as entryTimestamp,
                   xd.VRM as exitVRM,
                   xd.timestamp as exitTimestamp
            FROM parking_events e
            LEFT JOIN carparks cp ON e.siteId = cp.siteId
            LEFT JOIN anpr_detections ed ON e.entryDetectionId = ed.id
            LEFT JOIN anpr_detections xd ON e.exitDetectionId = xd.id
            WHERE e.siteId = 'CP6'
            ORDER BY e.entryTime DESC
        `);
        res.json(events);
    } catch (err) {
        console.error('Error checking CP6 events:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Debug endpoint to check CP6 configuration
app.get('/debug/cp6-config', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Get car park configuration
        const [carPark] = await conn.query(`
            SELECT * FROM carparks WHERE siteId = 'CP6'
        `);
        
        // Get camera configuration
        const cameras = await conn.query(`
            SELECT c.*, 
                   COUNT(d.id) as detectionCount,
                   MAX(d.timestamp) as lastDetection
            FROM cameras c
            LEFT JOIN anpr_detections d ON c.name = d.cameraID
            WHERE c.carParkId = 'CP6'
            GROUP BY c.name
        `);
        
        // Get recent detections
        const recentDetections = await conn.query(`
            SELECT d.*, c.name as cameraName, c.isEntryTrigger, c.isExitTrigger, c.direction as cameraDirection
            FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.name
            WHERE c.carParkId = 'CP6'
            ORDER BY d.timestamp DESC
            LIMIT 10
        `);
        
        res.json({
            carPark,
            cameras,
            recentDetections
        });
    } catch (err) {
        console.error('Error checking CP6 configuration:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Debug endpoint to test event generation for CP6
app.get('/debug/cp6-test-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Get all detections for this car park's cameras
        const detections = await conn.query(`
            SELECT d.*, c.name as cameraName, c.isEntryTrigger, c.isExitTrigger, c.direction as cameraDirection
            FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.name
            WHERE c.carParkId = 'CP6'
            ORDER BY d.timestamp ASC
        `);
        
        // Log detection processing
        const detectionLog = detections.map(d => ({
            id: d.id,
            VRM: d.VRM,
            timestamp: d.timestamp,
            camera: d.cameraName,
            direction: d.direction,
            cameraDirection: d.cameraDirection,
            isEntryTrigger: d.isEntryTrigger,
            isExitTrigger: d.isExitTrigger,
            // Calculate if this should be entry or exit
            shouldBeEntry: d.isEntryTrigger && (
                (d.direction === 'towards' && d.cameraDirection === 'in') ||
                (d.direction === 'away' && d.cameraDirection === 'out')
            ),
            shouldBeExit: d.isExitTrigger && (
                (d.direction === 'away' && d.cameraDirection === 'in') ||
                (d.direction === 'towards' && d.cameraDirection === 'out')
            )
        }));
        
        res.json({
            detections: detectionLog,
            message: "This shows how each detection would be processed for event generation"
        });
    } catch (err) {
        console.error('Error testing CP6 event generation:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Car Park Processing Status Management
app.get('/admin/carpark-processing', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query(`
            SELECT cp.*, cps.isEnabled, cps.reason, cps.lastUpdated
            FROM carparks cp
            LEFT JOIN carpark_processing_status cps ON cp.siteId = cps.siteId
            ORDER BY cp.name
        `);
        res.render('admin/carpark_processing', { carparks });
    } catch (err) {
        console.error('Error loading car park processing status:', err);
        res.status(500).render('error', { message: 'Error loading car park processing status' });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/carpark-processing/update', async (req, res) => {
    let conn;
    try {
        const { siteId, isEnabled, reason } = req.body;
        conn = await pool.getConnection();
        
        await conn.query(`
            INSERT INTO carpark_processing_status (siteId, isEnabled, reason)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
            isEnabled = VALUES(isEnabled),
            reason = VALUES(reason)
        `, [siteId, isEnabled === 'true', reason]);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating car park processing status:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// TEMPORARY: Debug endpoint to clean up old migration record
app.get('/admin/debug/cleanup-migration', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const result = await conn.query("DELETE FROM migrations WHERE filename = '20240321_01_add_carpark_processing_status.sql'");
        res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// TEMPORARY: Debug endpoint to clean up migrations table of missing files
app.get('/admin/debug/cleanup-migrations-table', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
        const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
        const rows = await conn.query('SELECT filename FROM migrations');
        const missing = rows.filter(row => !files.includes(row.filename));
        let deleted = 0;
        for (const row of missing) {
            await conn.query('DELETE FROM migrations WHERE filename = ?', [row.filename]);
            deleted++;
        }
        res.json({ success: true, deleted, missing });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Reset migrations table (dangerous!)
app.post('/admin/debug/reset-migrations-table', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('TRUNCATE TABLE migrations');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// API endpoint to get event details
app.get('/api/events/:id', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const eventId = req.params.id;
        
        // Get the event with all related information
        const [event] = await conn.query(`
            SELECT 
                pe.*,
                cp.name as carparkName,
                entry_d.VRM as entryVRM,
                entry_d.timestamp as entryTime,
                entry_d.cameraID as entryCamera,
                entry_d.image1 as entryImage,
                exit_d.VRM as exitVRM,
                exit_d.timestamp as exitTime,
                exit_d.cameraID as exitCamera,
                exit_d.image1 as exitImage
            FROM parking_events pe
            LEFT JOIN carparks cp ON pe.siteId = cp.siteId
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            LEFT JOIN anpr_detections exit_d ON pe.exitDetectionId = exit_d.id
            WHERE pe.id = ?
        `, [eventId]);

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json(event);
    } catch (err) {
        console.error('Error fetching event details:', err);
        res.status(500).json({ error: 'Error fetching event details' });
    } finally {
        if (conn) conn.release();
    }
});

// Housekeeping job: remove orphaned PCNs every 24 hours
setInterval(async () => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query(`
            DELETE FROM pcns 
            WHERE eventId IS NOT NULL 
              AND eventId NOT IN (SELECT id FROM parking_events)
        `);
        console.log('[Housekeeping] Orphaned PCNs cleaned up');
    } catch (err) {
        console.error('[Housekeeping] Error cleaning up orphaned PCNs:', err);
    } finally {
        if (conn) conn.release();
    }
}, 24 * 60 * 60 * 1000); // Run every 24 hours

// Admin endpoint to trigger PCN housekeeping manually
app.post('/admin/housekeeping/pcns', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const result = await conn.query(`
            DELETE FROM pcns 
            WHERE eventId IS NOT NULL 
              AND eventId NOT IN (SELECT id FROM parking_events)
        `);
        res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});
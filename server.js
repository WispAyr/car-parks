const express = require('express');
const mariadb = require('mariadb');
require('dotenv').config();
const bodyParser = require('body-parser');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const methodOverride = require('method-override');
const { eventGenerationQueue, eventGenerationEvents } = require('./eventGenerationQueue');
const http = require('http');
const socketio = require('socket.io');
const { generateParkingEvents } = require('./eventGeneration');
const pool = require('./dbPool');
const { fetchWhitelistsFromMonday, getCachedWhitelists, isWhitelisted } = require('./mondayWhitelistService');
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');

const app = express();
const port = process.env.PORT || 3001;

// Add request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Helper function for VRM normalization
function normalizeVRM(vrm) {
    if (!vrm) return vrm;
    return vrm.replace(/\s+/g, '').toUpperCase();
}

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

// Mount admin router
const adminRouter = require('./routes/admin')(pool);
app.use('/admin', adminRouter);

// Add BigInt serialization support at the top of the file
BigInt.prototype.toJSON = function() {
    return this.toString();
};

// --- SOCKET.IO SETUP ---
const server = http.createServer(app);
const io = socketio(server);

// Store for event generation jobs
const eventGenerationJobs = {};

// Broadcast job progress to clients
function broadcastJobProgress(jobId, progress) {
    io.emit('event-generation-progress', { jobId, progress });
}

// Listen for BullMQ job progress events
(async () => {
    eventGenerationEvents.on('progress', ({ jobId, data }) => {
        broadcastJobProgress(jobId, data);
    });
    eventGenerationEvents.on('completed', ({ jobId }) => {
        broadcastJobProgress(jobId, 100);
    });
    eventGenerationEvents.on('failed', ({ jobId, failedReason }) => {
        io.emit('event-generation-failed', { jobId, failedReason });
    });
})();

// --- API ENDPOINTS FOR EVENT GENERATION ---

// Start event generation (POST)
app.post('/api/start-event-generation', async (req, res) => {
    const { startDate, endDate, clearFlaggedEvents } = req.body;
    const job = await eventGenerationQueue.add('generate', {
        startDate, endDate, clearFlaggedEvents
    });
    res.json({ jobId: job.id });
});

// Get event generation job status
app.get('/api/event-generation-status/:jobId', async (req, res) => {
    const job = await eventGenerationQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const state = await job.getState();
    const progress = job.progress;
    res.json({ state, progress, result: job.returnvalue, failedReason: job.failedReason });
});

// --- MODIFY generateParkingEvents TO SUPPORT PROGRESS CALLBACK ---

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
        
        // Ensure count is a valid number
        const total = countResult && countResult[0] && typeof countResult[0].count !== 'undefined' ? Number(countResult[0].count) : 0;
        const totalPages = Math.ceil(total / limit);

        res.render('realtime', {
            detections,
            page,
            totalPages,
            carparks,
            selectedCarPark
        });
    } catch (err) {
        logger.error('Error fetching data:', err);
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
        const vrm = req.query.vrm || '';
        // Default to last 24 hours if no date range provided or if empty
        let startDate = req.query.startDate;
        let endDate = req.query.endDate;
        if (!startDate || !endDate || startDate.trim() === '' || endDate.trim() === '') {
            const now = new Date();
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            startDate = yesterday.toISOString().slice(0, 10);
            endDate = now.toISOString().slice(0, 10);
        }
        // Build query with filters
        let query = `
            SELECT 
                pe.id,
                pe.siteId,
                pe.VRM,
                pe.entryTime,
                pe.exitTime,
                pe.status,
                pe.entryDetectionId,
                pe.exitDetectionId,
                (LENGTH(entry_d.image1) > 0) as hasEntryImage,
                (LENGTH(exit_d.image1) > 0) as hasExitImage
            FROM parking_events pe
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            LEFT JOIN anpr_detections exit_d ON pe.exitDetectionId = exit_d.id
            WHERE 1=1
                AND pe.VRM IS NOT NULL AND pe.VRM != '' AND LOWER(pe.VRM) != 'unknown'
                AND (entry_d.direction IS NULL OR (entry_d.direction != '' AND LOWER(entry_d.direction) != 'unknown'))
        `;
        const params = [];
        if (selectedCarPark) {
            query += ' AND pe.siteId = ?';
            params.push(selectedCarPark);
        }
        if (startDate) {
            query += ' AND pe.entryTime >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND pe.entryTime <= ?';
            params.push(endDate + ' 23:59:59');
        }
        if (vrm) {
            query += ' AND pe.VRM LIKE ?';
            params.push(`%${vrm}%`);
        }
        query += ' ORDER BY pe.entryTime DESC LIMIT 100';
        console.log('EVENTS QUERY:', query, params);
        const events = await conn.query(query, params);
        res.render('events', { 
            events,
            carparks,
            selectedCarPark,
            startDate,
            endDate,
            vrm
        });
    } catch (err) {
        console.error('Error loading events (with images):', err);
        res.status(500).send('Error loading events (with images)');
    } finally {
        if (conn) conn.release();
    }
});

// Main dashboard route
app.get('/', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        // Redirect to events page which has the proper dashboard UI
        res.render('events', { 
            carparks, 
            selectedCarPark: '', 
            selectedStatus: '',
            events: [],
            tab: 'completed' // Add the tab parameter for proper navigation highlighting
        });
    } catch (err) {
        console.error('Error loading dashboard:', err);
        res.status(500).render('error', { message: 'Error loading dashboard' });
    } finally {
        if (conn) conn.release();
    }
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

// API endpoint to fetch a single detection by ID
app.get('/api/detection/:id', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const [detection] = await conn.query(`
            SELECT 
                id, VRM, createdAt, type, timestamp, direction, 
                confidence, tag, tagConfidence, country, cameraID,
                processed, processed_at
            FROM anpr_detections 
            WHERE id = ?
        `, [req.params.id]);

        if (!detection) {
            return res.status(404).json({ error: 'Detection not found' });
        }

        // Convert BigInt to Number for JSON serialization
        const formattedDetection = Object.fromEntries(
            Object.entries(detection).map(([k, v]) => [
                k, 
                typeof v === 'bigint' ? Number(v) : 
                v instanceof Date ? v.toISOString() : v
            ])
        );

        res.json(formattedDetection);
    } catch (err) {
        console.error('Error fetching detection:', err);
        res.status(500).json({ error: 'Error fetching detection' });
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

// Admin page for event generation UI
app.get('/admin/event-generation', (req, res) => {
    res.render('admin/event_generation');
});

// Legacy endpoint to generate events retrospectively
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
    try {
        const { startDate, endDate, clearFlaggedEvents } = req.body;
        const events = await generateParkingEvents(startDate, endDate, clearFlaggedEvents);
        res.json({ success: true, events });
    } catch (error) {
        console.error('Error generating events:', error);
        res.status(500).json({ error: 'Failed to generate events' });
    }
});

// Start the server
server.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the application at http://localhost:${port}`);
});


// Automated PCN generation job (runs every 5 minutes)
setInterval(async () => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks with automation enabled
        const carparks = await conn.query('SELECT * FROM pcn_automation_settings WHERE isEnabled = true');
        logger.info(`[PCN Automation] Starting job for ${carparks.length} enabled car parks`);
        
        for (const cp of carparks) {
            const siteId = cp.siteId;
            const grace = cp.gracePeriodMinutes || 0;
            logger.info(`[PCN Automation] Processing car park ${siteId} with grace period ${grace} minutes`);
            
            // Get all active, autoEnforce rules for this car park
            const rules = await conn.query('SELECT * FROM rules WHERE siteId = ? AND isActive = true AND autoEnforce = true', [siteId]);
            if (!rules.length) {
                logger.info(`[PCN Automation] No active auto-enforce rules found for car park ${siteId}`);
                continue;
            }
            logger.info(`[PCN Automation] Found ${rules.length} active auto-enforce rules for car park ${siteId}`);
            
            // Get all completed events since lastChecked (or last 24h if never checked)
            const since = cp.lastChecked ? new Date(cp.lastChecked) : new Date(Date.now() - 24*60*60*1000);
            const events = await conn.query(
                'SELECT * FROM parking_events WHERE siteId = ? AND exitTime IS NOT NULL AND entryTime > ?',
                [siteId, since]
            );
            logger.info(`[PCN Automation] Processing ${events.length} events for car park ${siteId} since ${since.toISOString()}`);
            
            // Process each event
            for (const event of events) {
                for (const rule of rules) {
                    // Check if event violates rule
                    let violated = false;
                    let reason = null;
                    
                    // Rule violation checks here...
                    
                    if (violated) {
                        // Check if PCN already exists for this event/rule
                        const existing = await conn.query(
                            'SELECT id FROM pcns WHERE siteId = ? AND VRM = ? AND ruleId = ? AND issueTime = ?',
                            [siteId, event.VRM, rule.id, event.exitTime]
                        );
                        if (existing.length) {
                            console.log(`[PCN Automation] PCN already exists for event ${event.id}, rule ${rule.id}`);
                            continue;
                        }
                        
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
                        
                        console.log(`[PCN Automation] Generated PCN #${pcn.insertId} for event ${event.id}, rule ${rule.id}, VRM ${event.VRM}`);
                        
                        // Log PCN generation
                        await conn.query(
                            `INSERT INTO pcn_audit_log (
                                pcnId, eventId, ruleId, siteId, action, message
                            ) VALUES (?, ?, ?, ?, 'issued', ?)`,
                            [pcn.insertId, event.id, rule.id, siteId, JSON.stringify({
                                ruleId: rule.id,
                                eventId: event.id,
                                reason: reason || rule.pcnReason,
                                amount: rule.pcnAmount,
                                dueDate: dueDate
                            })]
                        );
                        
                        // Send notifications if enabled
                        if (rule.notifyOnIssue && cp.notifyEmails) {
                            const emails = cp.notifyEmails.split(',').map(e => e.trim());
                            console.log(`[PCN Automation] Sending notifications to ${emails.length} recipients for PCN #${pcn.insertId}`);
                            for (const email of emails) {
                                // TODO: Implement actual email sending
                                console.log(`[PCN Automation] Would send PCN notification to ${email} for PCN #${pcn.insertId}`);
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
            console.log(`[PCN Automation] Completed processing for car park ${siteId}`);
        }
    } catch (err) {
        console.error('[PCN Automation] Error in PCN automation job:', err);
    } finally {
        if (conn) conn.release();
    }
}, 5 * 60 * 1000);

// Admin navigation
app.get('/admin', (req, res) => {
    res.render('admin/index');
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
        console.log(`[CARPARK] Added: siteId=${siteId}, name=${name}, throughTrafficMinutes=${throughTrafficMinutes}, at ${new Date().toISOString()}`);
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
        console.log(`[CARPARK] Edited: originalSiteId=${originalSiteId}, newSiteId=${siteId}, name=${name}, throughTrafficMinutes=${throughTrafficMinutes}, at ${new Date().toISOString()}`);
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
        console.log(`[CARPARK] Deleted: siteId=${siteId}, at ${new Date().toISOString()}`);
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
                c.entryDirection,
                c.exitDirection,
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
        const { originalName, name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection } = req.body;
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
                direction = ?,
                entryDirection = ?,
                exitDirection = ?
            WHERE name = ?
        `, [
            name,
            carParkId || null,  // Keep as string
            isEntry,
            isExit,
            direction,
            entryDirection,
            exitDirection,
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
                c.entryDirection,
                c.exitDirection,
                cp.name as carparkName
            FROM cameras c
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId
            WHERE c.name = ?
        `, [name]);
        
        res.json({ 
            success: true,
            camera: updatedCamera[0]
        });
        console.log(`[CAMERA] Edited: originalName=${originalName}, newName=${name}, carParkId=${carParkId}, isEntryTrigger=${isEntry}, isExitTrigger=${isExit}, direction=${direction}, entryDirection=${entryDirection}, exitDirection=${exitDirection}, at ${new Date().toISOString()}`);
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
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection } = req.body;
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
            INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [name, carParkId || null, isEntry, isExit, direction, entryDirection, exitDirection]);
        
        // Get the newly created camera with car park info
        const newCamera = await conn.query(`
            SELECT 
                c.name,
                c.carParkId,
                c.isEntryTrigger,
                c.isExitTrigger,
                c.direction,
                c.entryDirection,
                c.exitDirection,
                cp.name as carparkName
            FROM cameras c
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId
            WHERE c.name = ?
        `, [name]);
        
        res.json({ 
            success: true,
            camera: newCamera[0]
        });
        console.log(`[CAMERA] Added: name=${name}, carParkId=${carParkId}, isEntryTrigger=${isEntry}, isExitTrigger=${isExit}, direction=${direction}, entryDirection=${entryDirection}, exitDirection=${exitDirection}, at ${new Date().toISOString()}`);
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
        console.log(`[CAMERA] Deleted: name=${name}, at ${new Date().toISOString()}`);
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
        // Optionally clear flagged events
        if (req.query.clearFlagged === '1') {
            console.log('Clearing flagged_events table as requested...');
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            await conn.query('TRUNCATE TABLE flagged_events');
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
        // First clear existing events
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.query('TRUNCATE TABLE parking_events');
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        // Generate new events
        const events = await generateParkingEvents(conn, req.query.carParkId);
        console.log(`Generated ${events.length} events`);
        res.json({ 
            success: true, 
            message: `Generated ${events.length} parking events${req.query.clearFlagged === '1' ? ' (flagged events cleared)' : ''}` 
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

// Server is already started at line 526

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
            SELECT 
                pe.id,
                pe.siteId,
                pe.VRM,
                pe.entryTime as eventEntryTime,
                pe.exitTime as eventExitTime,
                pe.durationMinutes,
                pe.throughTraffic,
                pe.entryDetectionId,
                pe.exitDetectionId,
                pe.entryCameraId,
                pe.exitCameraId,
                cp.name as carparkName,
                entry_d.VRM as entryVRM,
                entry_d.timestamp as entryTime,
                entry_d.cameraID as entryCamera,
                entry_d.image1 as entryImage,
                entry_d.direction as entryDirection,
                exit_d.VRM as exitVRM,
                exit_d.timestamp as exitTime,
                exit_d.cameraID as exitCamera,
                exit_d.image1 as exitImage,
                exit_d.direction as exitDirection,
                entry_cam.name as entryCameraName,
                exit_cam.name as exitCameraName
            FROM parking_events pe
            LEFT JOIN carparks cp ON pe.siteId = cp.siteId
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            LEFT JOIN anpr_detections exit_d ON pe.exitDetectionId = exit_d.id
            LEFT JOIN cameras entry_cam ON pe.entryCameraId = entry_cam.name
            LEFT JOIN cameras exit_cam ON pe.exitCameraId = exit_cam.name
            WHERE pe.id = ?
        `, [eventId]);
        if (!event) {
            return res.status(404).render('error', { message: 'Event not found' });
        }
        // Fetch detection flags for entry and exit detections
        let entryFlags = [];
        let exitFlags = [];
        if (event.entryDetectionId) {
            entryFlags = await conn.query('SELECT * FROM detection_flags WHERE detectionId = ?', [event.entryDetectionId]);
        }
        if (event.exitDetectionId) {
            exitFlags = await conn.query('SELECT * FROM detection_flags WHERE detectionId = ?', [event.exitDetectionId]);
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
        res.render('event_details', { event, pcns: [], entryFlags, exitFlags, relatedEvents, relatedDetections });
    } catch (err) {
        console.error('Error loading event details:', err);
        res.status(500).render('error', { message: 'Error loading event details' });
    } finally {
        if (conn) conn.release();
    }
});

// Delete and reprocess event endpoint
app.post('/events/:id/delete-reprocess', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const eventId = req.params.id;
        // Get the event
        const [event] = await conn.query('SELECT * FROM parking_events WHERE id = ?', [eventId]);
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }
        // Delete the event
        await conn.query('DELETE FROM parking_events WHERE id = ?', [eventId]);
        // Reset processed flags for entry and exit detections
        const detectionIds = [];
        if (event.entryDetectionId) detectionIds.push(event.entryDetectionId);
        if (event.exitDetectionId) detectionIds.push(event.exitDetectionId);
        if (detectionIds.length > 0) {
            await conn.query('UPDATE anpr_detections SET processed = FALSE, processed_at = NULL WHERE id IN (?)', [detectionIds]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting/reprocessing event:', err);
        res.status(500).json({ error: 'Error deleting/reprocessing event' });
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
        const eventId = parseInt(req.params.id, 10);
        
        // Debug logging
        console.log(`[EVENT API] Request received for event ID: ${eventId} (type: ${typeof eventId})`);
        
        if (isNaN(eventId)) {
            console.log(`[EVENT API] Invalid event ID: ${req.params.id}`);
            return res.status(400).json({ error: 'Invalid event ID' });
        }
        
        // Get the event with all related information
        const [event] = await conn.query(`
            SELECT 
                pe.id,
                pe.siteId,
                pe.VRM,
                pe.entryTime as eventEntryTime,
                pe.exitTime as eventExitTime,
                pe.durationMinutes,
                pe.throughTraffic,
                pe.entryDetectionId,
                pe.exitDetectionId,
                pe.entryCameraId,
                pe.exitCameraId,
                cp.name as carparkName,
                entry_d.VRM as entryVRM,
                entry_d.timestamp as entryTime,
                entry_d.cameraID as entryCamera,
                entry_d.image1 as entryImage,
                exit_d.VRM as exitVRM,
                exit_d.timestamp as exitTime,
                exit_d.cameraID as exitCamera,
                exit_d.image1 as exitImage,
                entry_cam.name as entryCameraName,
                exit_cam.name as exitCameraName
            FROM parking_events pe
            LEFT JOIN carparks cp ON pe.siteId = cp.siteId
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            LEFT JOIN anpr_detections exit_d ON pe.exitDetectionId = exit_d.id
            LEFT JOIN cameras entry_cam ON pe.entryCameraId = entry_cam.name
            LEFT JOIN cameras exit_cam ON pe.exitCameraId = exit_cam.name
            WHERE pe.id = ?
        `, [eventId]);

        // Debug logging
        console.log(`[EVENT API] Query result:`, event ? 'Event found' : 'Event not found');
        if (event) {
            console.log(`[EVENT API] Event details:`, {
                id: event.id,
                VRM: event.VRM,
                siteId: event.siteId,
                entryTime: event.eventEntryTime,
                exitTime: event.eventExitTime
            });
        }

        if (!event) {
            console.log(`[EVENT API] No event found with ID: ${eventId}`);
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json(event);
    } catch (err) {
        console.error('[EVENT API] Error fetching event details:', err);
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
        logger.info('[PCN Housekeeping] Starting scheduled cleanup of orphaned PCNs');
        
        // Get count of orphaned PCNs before deletion
        const [countResult] = await conn.query(`
            SELECT COUNT(*) as count 
            FROM pcns 
            WHERE eventId IS NOT NULL 
              AND eventId NOT IN (SELECT id FROM parking_events)
        `);
        const orphanedCount = countResult.count;
        
        // Delete orphaned PCNs
        const result = await conn.query(`
            DELETE FROM pcns 
            WHERE eventId IS NOT NULL 
              AND eventId NOT IN (SELECT id FROM parking_events)
        `);
        
        logger.info(`[PCN Housekeeping] Cleaned up ${result.affectedRows} orphaned PCNs out of ${orphanedCount} total orphaned PCNs`);
        
        // Log details of deleted PCNs
        if (result.affectedRows > 0) {
            logger.info(`[PCN Housekeeping] Deletion details: ${JSON.stringify({
                deletedCount: result.affectedRows,
                totalOrphaned: orphanedCount,
                timestamp: new Date().toISOString()
            })}`);
        }
    } catch (err) {
        logger.error(`[PCN Housekeeping] Error in scheduled cleanup: ${err.message}`, { error: err });
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

// Admin: Flagged Events Dashboard
app.get('/admin/flagged-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Filters
        const filters = {
            vrm: req.query.vrm || '',
            siteId: req.query.siteId || '',
            status: req.query.status || ''
        };
        let query = 'SELECT * FROM flagged_events WHERE 1=1';
        const params = [];
        if (filters.vrm) {
            query += ' AND VRM = ?';
            params.push(filters.vrm);
        }
        if (filters.siteId) {
            query += ' AND siteId = ?';
            params.push(filters.siteId);
        }
        if (filters.status) {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        query += ' ORDER BY created_at DESC LIMIT 200';
        const flaggedEvents = await conn.query(query, params);
        res.render('admin/flagged_events', { flaggedEvents, filters });
    } catch (err) {
        console.error('Error loading flagged events:', err);
        res.status(500).render('error', { message: 'Error loading flagged events' });
    } finally {
        if (conn) conn.release();
    }
});

app.patch('/admin/flagged-events/:id/update', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const { id } = req.params;
        const { status } = req.body;
        await conn.query('UPDATE flagged_events SET status = ? WHERE id = ?', [status, id]);
        res.redirect('/admin/flagged-events');
    } catch (err) {
        console.error('Error updating flagged event:', err);
        res.status(500).render('error', { message: 'Error updating flagged event' });
    } finally {
        if (conn) conn.release();
    }
});

// API endpoint to get last processed time
app.get('/api/last-processed-time', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const [row] = await conn.query(`
            SELECT MAX(processed_at) as lastProcessedTime
            FROM anpr_detections
            WHERE processed = TRUE
        `);
        res.json({ lastProcessedTime: row ? row.lastProcessedTime : null });
    } catch (error) {
        console.error('Error in last-processed-time endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (conn) conn.release();
    }
});

async function getCarParks() {
    let conn;
    try {
        conn = await pool.getConnection();
        const carParks = await conn.query('SELECT siteId as id, name FROM carparks');
        return carParks;
    } catch (err) {
        console.error('Error fetching car parks:', err);
        return [];
    } finally {
        if (conn) conn.release();
    }
}

// API endpoint to reset processed flags
app.post('/api/reset-processed-flags', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const query = `
            UPDATE anpr_detections 
            SET processed = FALSE, 
                processed_at = NULL
        `;
        await conn.query(query);
        res.json({ message: 'Processed flags reset successfully' });
    } catch (err) {
        console.error('Error resetting processed flags:', err);
        res.status(500).json({ error: err.message || 'Failed to reset processed flags' });
    } finally {
        if (conn) conn.release();
    }
});

// API endpoint to start event generation process
app.post('/api/start-event-generation', async (req, res) => {
    try {
        const { startDate, endDate, clearFlaggedEvents } = req.body;
        const jobId = Date.now().toString(); // Simple job ID generation
        
        // Store job in memory (in production, use a proper job queue)
        eventGenerationJobs[jobId] = {
            id: jobId,
            state: 'running',
            progress: 0,
            startDate,
            endDate,
            clearFlaggedEvents
        };
        
        // Start the generation process asynchronously
        process.nextTick(async () => {
            try {
                let conn;
                try {
                    conn = await pool.getConnection();
                    
                    // Optionally clear flagged events
                    if (clearFlaggedEvents) {
                        io.emit('event-generation-progress', { jobId, progress: 5, message: 'Clearing flagged events...' });
                        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
                        await conn.query('TRUNCATE TABLE flagged_events');
                        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
                    }
                    
                    io.emit('event-generation-progress', { jobId, progress: 10, message: 'Starting event generation...' });
                    
                    // Generate events with progress updates
                    const events = await generateParkingEvents(startDate, endDate, clearFlaggedEvents, (progress) => {
                        // Calculate overall progress (10-90%)
                        const overallProgress = Math.floor(10 + (progress * 80));
                        eventGenerationJobs[jobId].progress = overallProgress;
                        io.emit('event-generation-progress', { jobId, progress: overallProgress });
                    });
                    
                    io.emit('event-generation-progress', { jobId, progress: 100, message: 'Completed' });
                    eventGenerationJobs[jobId].state = 'completed';
                    eventGenerationJobs[jobId].progress = 100;
                    
                    // Clean up job after some time
                    setTimeout(() => {
                        delete eventGenerationJobs[jobId];
                    }, 3600000); // Remove after 1 hour
                    
                } catch (error) {
                    console.error('Event generation failed:', error);
                    eventGenerationJobs[jobId].state = 'failed';
                    eventGenerationJobs[jobId].failedReason = error.message;
                    io.emit('event-generation-failed', { jobId, failedReason: error.message });
                } finally {
                    if (conn) conn.release();
                }
            } catch (error) {
                console.error('Unhandled error in event generation:', error);
            }
        });
        
        res.json({ success: true, jobId });
    } catch (error) {
        console.error('Error starting event generation:', error);
        res.status(500).json({ error: 'Failed to start event generation' });
    }
});

// API endpoint to check event generation status
app.get('/api/event-generation-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = eventGenerationJobs[jobId];
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json({
        id: job.id,
        state: job.state,
        progress: job.progress,
        failedReason: job.failedReason
    });
});

// API endpoint to regenerate events (for admin dashboard)
app.post('/api/regenerate-events', async (req, res) => {
    let conn;
    try {
        const { clearFlaggedEvents } = req.body;
        conn = await pool.getConnection();
        // Optionally clear flagged events
        if (clearFlaggedEvents) {
            await conn.query('SET FOREIGN_KEY_CHECKS = 0');
            await conn.query('TRUNCATE TABLE flagged_events');
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
        // First clear existing events
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.query('TRUNCATE TABLE parking_events');
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        // Generate new events
        const events = await generateParkingEvents();
        res.json({ 
            success: true, 
            message: `Generated ${events.length} parking events${clearFlaggedEvents ? ' (flagged events cleared)' : ''}` 
        });
    } catch (err) {
        console.error('Error regenerating events:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Split Event API endpoint
app.post('/api/events/:id/split', async (req, res) => {
    let conn;
    try {
        const eventId = req.params.id;
        const { splitDetectionId } = req.body;
        if (!splitDetectionId) {
            return res.status(400).json({ success: false, error: 'No splitDetectionId provided' });
        }
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // Lock the original event
        const [event] = await conn.query('SELECT * FROM parking_events WHERE id = ? FOR UPDATE', [eventId]);
        if (!event) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Event not found' });
        }

        // Get all detections for this event (same VRM, car park, ordered by timestamp)
        const detections = await conn.query(`
            SELECT d.* FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.name
            WHERE c.carParkId = ? AND d.VRM = ?
            ORDER BY d.timestamp ASC, d.id ASC
        `, [event.siteId, event.VRM]);
        if (!detections.length) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'No detections found for this event' });
        }

        // Find split index
        const splitIdx = detections.findIndex(d => d.id == splitDetectionId);
        if (splitIdx === -1 || splitIdx === detections.length - 1) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Invalid split point' });
        }

        // Split detections into two groups
        const group1 = detections.slice(0, splitIdx + 1);
        const group2 = detections.slice(splitIdx + 1);

        // Helper to generate event data from detection group
        function getEventDataFromGroup(group, splitSuffix) {
            if (!group.length) return null;
            const entry = group[0];
            const exit = group.length > 1 ? group[group.length - 1] : null;
            const entryTime = entry.timestamp;
            const exitTime = exit ? exit.timestamp : null;
            const durationMinutes = exitTime ? (new Date(exitTime) - new Date(entryTime)) / 60000 : null;
            const entryDetectionId = entry.id;
            const exitDetectionId = exit ? exit.id : null;
            const entryCameraId = entry.cameraID;
            const exitCameraId = exit ? exit.cameraID : null;
            let throughTraffic = false;
            if (exitTime && durationMinutes !== null && durationMinutes < 5 && entryCameraId === exitCameraId) {
                throughTraffic = true;
            }
            return {
                siteId: event.siteId,
                VRM: event.VRM,
                entryTime,
                exitTime,
                durationMinutes,
                throughTraffic,
                entryDetectionId,
                exitDetectionId,
                entryCameraId,
                exitCameraId,
                splitSuffix
            };
        }

        // Generate unique splitSuffix for each split event
        const splitSuffix1 = uuidv4();
        const splitSuffix2 = uuidv4();
        const eventData1 = getEventDataFromGroup(group1, splitSuffix1);
        const eventData2 = getEventDataFromGroup(group2, splitSuffix2);

        // Check for duplicates (excluding the original event)
        for (const newEvent of [eventData1, eventData2]) {
            if (!newEvent) continue;
            const [dup] = await conn.query(
                'SELECT id FROM parking_events WHERE siteId = ? AND VRM = ? AND entryTime = ? AND splitSuffix = ? AND id != ?',
                [newEvent.siteId, newEvent.VRM, newEvent.entryTime, newEvent.splitSuffix, eventId]
            );
            if (dup) {
                await conn.rollback();
                return res.status(409).json({ success: false, error: `Duplicate event exists for entryTime ${newEvent.entryTime} and splitSuffix ${newEvent.splitSuffix}` });
            }
        }

        // Flag and delete the original event
        await conn.query('UPDATE parking_events SET flagged = 1, flagReason = ? WHERE id = ?', ['Manually split', eventId]);
        await conn.query('DELETE FROM parking_events WHERE id = ?', [eventId]);

        // Insert new events with unique splitSuffix
        const result1 = await conn.query(`
            INSERT INTO parking_events
            (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic, entryDetectionId, exitDetectionId, entryCameraId, exitCameraId, splitSuffix)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            eventData1.siteId,
            eventData1.VRM,
            eventData1.entryTime,
            eventData1.exitTime,
            eventData1.durationMinutes,
            eventData1.throughTraffic,
            eventData1.entryDetectionId,
            eventData1.exitDetectionId,
            eventData1.entryCameraId,
            eventData1.exitCameraId,
            eventData1.splitSuffix
        ]);
        const newEventId1 = result1.insertId;

        const result2 = await conn.query(`
            INSERT INTO parking_events
            (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic, entryDetectionId, exitDetectionId, entryCameraId, exitCameraId, splitSuffix)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            eventData2.siteId,
            eventData2.VRM,
            eventData2.entryTime,
            eventData2.exitTime,
            eventData2.durationMinutes,
            eventData2.throughTraffic,
            eventData2.entryDetectionId,
            eventData2.exitDetectionId,
            eventData2.entryCameraId,
            eventData2.exitCameraId,
            eventData2.splitSuffix
        ]);
        const newEventId2 = result2.insertId;

        // Optionally, add to flagged_events log
        await conn.query('INSERT INTO flagged_events (VRM, siteId, detectionId, timestamp, reason, status, details) VALUES (?, ?, ?, NOW(), ?, ?, ?)', [
            event.VRM, event.siteId, splitDetectionId, 'Manual split', 'open', `Split at detection ID ${splitDetectionId}`
        ]);

        // Add to split event audit log
        await conn.query(`
            INSERT INTO split_event_audit_log (originalEventId, newEventId1, newEventId2, splitDetectionId, user, timestamp)
            VALUES (?, ?, ?, ?, ?, NOW())
        `, [
            eventId,
            newEventId1,
            newEventId2,
            splitDetectionId,
            req.user ? req.user.username : null
        ]);

        await conn.commit();
        res.json({ success: true, newEventId1, newEventId2 });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('Error splitting event:', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Scheduled sync every hour
fetchWhitelistsFromMonday();
setInterval(fetchWhitelistsFromMonday, 60 * 60 * 1000);

// Admin UI to view current whitelists
app.get('/admin/whitelists', (req, res) => {
  const whitelists = getCachedWhitelists();
  res.render('admin/whitelists', { whitelists });
});

// Placeholder: Payment lookup function (to be implemented)
async function isPaymentValid(siteId, vrm, entryTime, exitTime) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    // Convert times to Date objects if they're strings
    const entry = new Date(entryTime);
    const exit = new Date(exitTime);
    
    // Find any payment that covers this parking period
    const [payments] = await conn.query(`
      SELECT * FROM payments 
      WHERE siteId = ? 
      AND vrm = ? 
      AND paymentStart <= ? 
      AND paymentEnd >= ?
      ORDER BY paymentStart DESC
      LIMIT 1
    `, [siteId, vrm.toUpperCase(), entry, exit]);
    
    if (payments && payments.length > 0) {
      const payment = payments[0];
      console.log(`[PAYMENT] Found valid payment for VRM=${vrm} at siteId=${siteId}:`, {
        paymentStart: payment.paymentStart,
        paymentEnd: payment.paymentEnd,
        entryTime: entry,
        exitTime: exit
      });
      return true;
    }
    
    // If no payment found, check for overstay
    const [overstayPayments] = await conn.query(`
      SELECT * FROM payments 
      WHERE siteId = ? 
      AND vrm = ? 
      AND paymentStart <= ? 
      AND paymentEnd >= ?
      ORDER BY paymentStart DESC
      LIMIT 1
    `, [siteId, vrm.toUpperCase(), entry, entry]);
    
    if (overstayPayments && overstayPayments.length > 0) {
      const payment = overstayPayments[0];
      console.log(`[PAYMENT] Found overstay for VRM=${vrm} at siteId=${siteId}:`, {
        paymentStart: payment.paymentStart,
        paymentEnd: payment.paymentEnd,
        entryTime: entry,
        exitTime: exit
      });
      return 'overstay';
    }
    
    console.log(`[PAYMENT] No valid payment found for VRM=${vrm} at siteId=${siteId}`);
    return false;
  } catch (err) {
    console.error('[PAYMENT] Error checking payment:', err);
    return false;
  } finally {
    if (conn) conn.release();
  }
}

// Combined whitelist and payment check
async function checkWhitelistAndPayment(conn, siteId, vrm, entryTime, exitTime) {
    // Whitelist check (no startDate/endDate)
    const [whitelistMatch] = await conn.query(
        `SELECT * FROM whitelist WHERE vrm = ? AND carParkId = ? AND active = 1`,
        [vrm, siteId]
    );
    if (whitelistMatch) {
        return { status: 'whitelisted', whitelist: whitelistMatch, payment: null };
    }
    // Payment check (covers full period)
    const [payments] = await conn.query(
        `SELECT * FROM payments WHERE siteId = ? AND vrm = ? AND paymentStart <= ? AND paymentEnd >= ? ORDER BY paymentStart DESC LIMIT 1`,
        [siteId, vrm.toUpperCase(), entryTime, exitTime]
    );
    if (payments && payments.length > 0) {
        return { status: 'paid', whitelist: null, payment: payments[0] };
    }
    // Overstay check (covers entry only)
    const [overstayPayments] = await conn.query(
        `SELECT * FROM payments WHERE siteId = ? AND vrm = ? AND paymentStart <= ? AND paymentEnd >= ? ORDER BY paymentStart DESC LIMIT 1`,
        [siteId, vrm.toUpperCase(), entryTime, entryTime]
    );
    if (overstayPayments && overstayPayments.length > 0) {
        return { status: 'overstay', whitelist: null, payment: overstayPayments[0] };
    }
    // Unpaid
    return { status: 'unpaid', whitelist: null, payment: null };
}

// Update finalizeEvent to use the combined check and log/report all details
async function finalizeEvent(event, conn) {
    const { id, siteId, VRM, entryTime, exitTime } = event;
    const result = await checkWhitelistAndPayment(conn, siteId, VRM, entryTime, exitTime);
    let updateFields = { status: result.status };
    if (result.whitelist) updateFields.whitelistMatch = JSON.stringify(result.whitelist);
    if (result.payment) updateFields.paymentMatch = JSON.stringify(result.payment);
    // Build update query
    const setClause = Object.keys(updateFields).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updateFields);
    values.push(id);
    await conn.query(`UPDATE parking_events SET ${setClause} WHERE id = ?`, values);
    // Log/report
    console.log(`[FINALIZE] Event ${id} (${VRM}) result:`, result);
    return result.status;
}

// Admin endpoint to recheck/finalize all events
app.post('/admin/events/recheck-all', async (req, res) => {
  let conn;
  let summary = { total: 0, whitelisted: 0, paid: 0, overstay: 0, unpaid: 0 };
  try {
    conn = await pool.getConnection();
    // Get all events (or filter as needed)
    const events = await conn.query('SELECT * FROM parking_events');
    for (const event of events) {
      const status = await finalizeEvent(event, conn);
      summary.total++;
      if (status === 'whitelisted') summary.whitelisted++;
      else if (status === 'paid') summary.paid++;
      else if (status === 'overstay') summary.overstay++;
      else summary.unpaid++;
    }
    console.log(`[FINALIZE-ALL] Rechecked ${summary.total} events: ${summary.whitelisted} whitelisted, ${summary.paid} paid, ${summary.overstay} overstay, ${summary.unpaid} unpaid.`);
    res.json({ success: true, summary });
  } catch (err) {
    console.error('[FINALIZE-ALL] Error rechecking all events:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// Function to finalize pending events
async function finalizePendingEvents() {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get events that haven't been finalized (no status or status is 'pending')
        const events = await conn.query(`
            SELECT * FROM parking_events 
            WHERE status IS NULL OR status = 'pending'
            ORDER BY entryTime ASC
        `);
        
        console.log(`[FINALIZE-PENDING] Processing ${events.length} pending events`);
        
        for (const event of events) {
            try {
                const status = await finalizeEvent(event, conn);
                console.log(`[FINALIZE-PENDING] Event ${event.id} (${event.VRM}) finalized as ${status}`);
            } catch (err) {
                console.error(`[FINALIZE-PENDING] Error finalizing event ${event.id}:`, err);
                // Continue with next event even if one fails
                continue;
            }
        }
    } catch (err) {
        console.error('[FINALIZE-PENDING] Error in finalizePendingEvents:', err);
    } finally {
        if (conn) conn.release();
    }
}

// Run every 5 minutes
setInterval(finalizePendingEvents, 5 * 60 * 1000);

// Admin endpoint to manually finalize a single event
app.post('/admin/events/:id/finalize', async (req, res) => {
  let conn;
  const eventId = req.params.id;
  console.log(`[FINALIZE] /admin/events/${eventId}/finalize called`);
  try {
    conn = await pool.getConnection();
    const [event] = await conn.query('SELECT * FROM parking_events WHERE id = ?', [eventId]);
    if (!event) {
      console.warn(`[FINALIZE] Event not found for id=${eventId}`);
      return res.status(404).json({ error: 'Event not found' });
    }
    console.log(`[FINALIZE] Finalizing event id=${eventId}, VRM=${event.VRM}, siteId=${event.siteId}`);
    await finalizeEvent(event, conn);
    console.log(`[FINALIZE] Successfully finalized event id=${eventId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[FINALIZE] Error finalizing event id=${eventId}:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// --- REAL-TIME CONSOLE LOG STREAMING FOR ADMIN ---
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

function addLogLine(line, type = 'log') {
    const entry = {
        timestamp: new Date().toISOString(),
        type,
        line: typeof line === 'string' ? line : JSON.stringify(line)
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    io.emit('admin-log', entry);
}

// Patch console.log and console.error
const origLog = console.log;
const origErr = console.error;
console.log = function(...args) {
    origLog.apply(console, args);
    addLogLine(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '), 'log');
};
console.error = function(...args) {
    origErr.apply(console, args);
    addLogLine(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '), 'error');
};

// Admin route to view logs
app.get('/admin/logs', (req, res) => {
    res.render('admin/logs', { logs: logBuffer });
});

app.get('/admin/carparks/:siteId', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carPark = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [req.params.siteId]);
        if (!carPark || carPark.length === 0) {
            return res.status(404).send('Car park not found');
        }

        // Get today's date range
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Get whitelist statistics
        const whitelistStatsRaw = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active
            FROM whitelist
            WHERE carParkId = ?
        `, [req.params.siteId]);
        const whitelistStats = (whitelistStatsRaw && whitelistStatsRaw[0]) ? {
            total: Number(whitelistStatsRaw[0].total) || 0,
            active: Number(whitelistStatsRaw[0].active) || 0
        } : { total: 0, active: 0 };

        // Get today's statistics
        const startOfDay = new Date(today);
        const endOfDay = new Date(tomorrow);
        const todayStatsRaw = await conn.query(`
            SELECT 
                COUNT(*) as totalEvents,
                SUM(CASE WHEN entryTime >= ? AND entryTime < ? THEN 1 ELSE 0 END) as newEvents,
                SUM(CASE WHEN exitTime IS NULL THEN 1 ELSE 0 END) as currentlyParked,
                SUM(CASE WHEN throughTraffic = 1 THEN 1 ELSE 0 END) as throughTraffic,
                AVG(CASE WHEN exitTime IS NOT NULL THEN durationMinutes ELSE NULL END) as avgDuration,
                MAX(CASE WHEN exitTime IS NOT NULL THEN durationMinutes ELSE NULL END) as longestStay,
                MIN(CASE WHEN exitTime IS NOT NULL AND durationMinutes > 0 THEN durationMinutes ELSE NULL END) as shortestStay,
                SUM(CASE WHEN status = 'whitelisted' THEN 1 ELSE 0 END) as whitelisted,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
                SUM(CASE WHEN status = 'overstay' THEN 1 ELSE 0 END) as overstay,
                SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) as unpaid,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN exitTime IS NOT NULL THEN 1 ELSE 0 END) as completedEvents
            FROM parking_events
            WHERE siteId = ?
            AND entryTime >= ?
            AND entryTime < ?
        `, [startOfDay, endOfDay, req.params.siteId, startOfDay, endOfDay]);
        const todayStats0 = todayStatsRaw[0] || {};
        const safeTodayStats = {
            totalEvents: Number(todayStats0.totalEvents) || 0,
            newEvents: Number(todayStats0.newEvents) || 0,
            currentlyParked: Number(todayStats0.currentlyParked) || 0,
            throughTraffic: Number(todayStats0.throughTraffic) || 0,
            throughTrafficRate: todayStats0.totalEvents ? ((Number(todayStats0.throughTraffic) / Number(todayStats0.totalEvents)) * 100).toFixed(1) : 0,
            avgDuration: Number(todayStats0.avgDuration) || 0,
            longestStay: Number(todayStats0.longestStay) || 0,
            shortestStay: Number(todayStats0.shortestStay) || 0,
            whitelisted: Number(todayStats0.whitelisted) || 0,
            paid: Number(todayStats0.paid) || 0,
            overstay: Number(todayStats0.overstay) || 0,
            overstayRate: todayStats0.totalEvents ? ((Number(todayStats0.overstay) / Number(todayStats0.totalEvents)) * 100).toFixed(1) : 0,
            unpaid: Number(todayStats0.unpaid) || 0,
            pending: Number(todayStats0.pending) || 0,
            completedEvents: Number(todayStats0.completedEvents) || 0
        };
        // Calculate occupancy rate
        const capacity = carPark[0].capacity || 100;
        safeTodayStats.occupancyRate = Math.round((safeTodayStats.currentlyParked / capacity) * 100);
        safeTodayStats.throughTrafficRate = safeTodayStats.totalEvents > 0 
            ? Math.round((safeTodayStats.throughTraffic / safeTodayStats.totalEvents) * 100)
            : 0;

        // Get recent events
        const recentEvents = await conn.query(`
            SELECT *
            FROM parking_events
            WHERE siteId = ?
            ORDER BY entryTime DESC
            LIMIT 10
        `, [req.params.siteId]);

        // Convert hourly data to 24-hour array
        const hourlyArray = Array(24).fill(0);
        hourlyData.forEach(row => {
            hourlyArray[row.hour] = row.count;
        });

        // Convert duration data to array
        const durationArray = [0, 0, 0, 0, 0]; // [<30min, 30-60min, 1-2h, 2-4h, >4h]
        durationData.forEach(row => {
            switch(row.range) {
                case '0-30': durationArray[0] = row.count; break;
                case '30-60': durationArray[1] = row.count; break;
                case '60-120': durationArray[2] = row.count; break;
                case '120-240': durationArray[3] = row.count; break;
                case '240+': durationArray[4] = row.count; break;
            }
        });

        res.render('admin/carpark_dashboard', {
            carPark: carPark[0],
            whitelistStats,
            todayStats: safeTodayStats,
            recentEvents,
            hourlyData: hourlyArray,
            durationData: durationArray
        });
    } catch (err) {
        console.error('Error in car park dashboard:', err);
        res.status(500).send('Server error');
    } finally {
        if (conn) conn.release();
    }
});

// Mark event as exited (clear 'currently parked' flag)
app.post('/api/events/:id/exit', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const eventId = req.params.id;
        // Get the event
        const [event] = await conn.query('SELECT * FROM parking_events WHERE id = ?', [eventId]);
        if (!event) {
            console.warn(`[EXIT] Event not found for id=${eventId}`);
            return res.status(404).json({ error: 'Event not found' });
        }
        if (event.exitTime) {
            console.warn(`[EXIT] Event id=${eventId} already has exitTime (${event.exitTime})`);
            return res.status(400).json({ error: 'Event already exited' });
        }
        const now = new Date();
        await conn.query('UPDATE parking_events SET exitTime = ?, durationMinutes = TIMESTAMPDIFF(MINUTE, entryTime, ?) WHERE id = ?', [now, now, eventId]);
        console.log(`[EXIT] Event marked as exited: id=${eventId}, VRM=${event.VRM}, siteId=${event.siteId}, exitTime=${now.toISOString()}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[EXIT] Error marking event as exited:', err);
        res.status(500).json({ error: 'Error marking event as exited' });
    } finally {
        if (conn) conn.release();
    }
});

// Add vehicle to rule whitelist
app.post('/admin/rules/:ruleId/whitelist/add', async (req, res) => {
    let conn;
    try {
        const ruleId = req.params.ruleId;
        const { vrm, maxDurationMinutes, startDate, endDate } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'INSERT INTO rule_whitelist (ruleId, VRM, maxDurationMinutes, startDate, endDate) VALUES (?, ?, ?, ?, ?)',
            [ruleId, vrm, maxDurationMinutes || null, startDate || null, endDate || null]
        );
        console.log(`[WHITELIST] Added: ruleId=${ruleId}, VRM=${vrm}, maxDurationMinutes=${maxDurationMinutes}, startDate=${startDate}, endDate=${endDate}, at ${new Date().toISOString()}`);
        res.redirect('back');
    } catch (err) {
        console.error('Error adding to whitelist:', err);
        res.status(500).render('error', { message: 'Error adding to whitelist' });
    } finally {
        if (conn) conn.release();
    }
});

// Remove vehicle from rule whitelist
app.post('/admin/rules/:ruleId/whitelist/delete', async (req, res) => {
    let conn;
    try {
        const ruleId = req.params.ruleId;
        const { whitelistId } = req.body;
        conn = await pool.getConnection();
        // Get VRM for logging
        const [entry] = await conn.query('SELECT VRM FROM rule_whitelist WHERE id = ?', [whitelistId]);
        await conn.query('DELETE FROM rule_whitelist WHERE id = ?', [whitelistId]);
        console.log(`[WHITELIST] Removed: ruleId=${ruleId}, VRM=${entry ? entry.VRM : 'unknown'}, whitelistId=${whitelistId}, at ${new Date().toISOString()}`);
        res.redirect('back');
    } catch (err) {
        console.error('Error removing from whitelist:', err);
        res.status(500).render('error', { message: 'Error removing from whitelist' });
    } finally {
        if (conn) conn.release();
    }
});

// WebSocket server for real-time updates
const WebSocket = require('ws');
const wss = new WebSocket.Server({ noServer: true });

// Store connected clients
const clients = new Set();

// Handle WebSocket connections
wss.on('connection', (ws) => {
    clients.add(ws);
    
    ws.on('close', () => {
        clients.delete(ws);
    });
});

// Broadcast new detection to all connected clients
function broadcastDetection(detection) {
    const message = JSON.stringify(detection);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Modify your existing detection endpoint to broadcast new detections
app.post('/api/detections', (req, res) => {
    // ... existing detection processing code ...
    
    // After saving the detection, broadcast it
    broadcastDetection(detection);
    
    res.json({ success: true });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws/detections') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
});

// API: Event summary stats for dashboard
app.get('/api/events/summary', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.query.siteId || '';
        const timePeriod = req.query.timePeriod || '24h';
        let start, end;
        const now = new Date();
        if (timePeriod === 'today') {
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        } else if (timePeriod === '7d') {
            start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            end = now;
        } else if (timePeriod === '30d') {
            start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            end = now;
        } else if (timePeriod === 'custom') {
            start = req.query.startDate ? new Date(req.query.startDate) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = req.query.endDate ? new Date(req.query.endDate) : now;
            end.setHours(23,59,59,999);
        } else { // default 24h
            start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            end = now;
        }
        const startStr = start.toISOString().slice(0, 19).replace('T', ' ');
        const endStr = end.toISOString().slice(0, 19).replace('T', ' ');
        let where = 'entryTime >= ? AND entryTime < ?';
        const params = [startStr, endStr];
        if (siteId) {
            where += ' AND siteId = ?';
            params.push(siteId);
        }
        const [row] = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN exitTime IS NOT NULL THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN exitTime IS NULL THEN 1 ELSE 0 END) as parked,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
                SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) as unpaid,
                SUM(CASE WHEN status = 'whitelisted' THEN 1 ELSE 0 END) as whitelisted,
                SUM(CASE WHEN throughTraffic = 1 THEN 1 ELSE 0 END) as throughTraffic
            FROM parking_events
            WHERE ${where}
        `, params);
        res.json({
            total: Number(row.total) || 0,
            completed: Number(row.completed) || 0,
            parked: Number(row.parked) || 0,
            paid: Number(row.paid) || 0,
            unpaid: Number(row.unpaid) || 0,
            whitelisted: Number(row.whitelisted) || 0,
            throughTraffic: Number(row.throughTraffic) || 0
        });
    } catch (err) {
        console.error('Error loading event summary:', err);
        res.status(500).json({ error: 'Error loading event summary' });
    } finally {
        if (conn) conn.release();
    }
});

// API: Filtered events for dashboard table
app.get('/api/events/list', async (req, res) => {
    let conn;
    try {
        console.log('[EVENTS LIST API] Request received');
        conn = await pool.getConnection();
        // --- Filtering logic ---
        const siteId = req.query.siteId || '';
        const timePeriod = req.query.timePeriod || '24h';
        let start, end;
        const now = new Date();
        if (timePeriod === 'today') {
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        } else if (timePeriod === '7d') {
            start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            end = now;
        } else if (timePeriod === '30d') {
            start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            end = now;
        } else if (timePeriod === 'custom') {
            start = req.query.startDate ? new Date(req.query.startDate) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
            end = req.query.endDate ? new Date(req.query.endDate) : now;
            end.setHours(23,59,59,999);
        } else { // default 24h
            start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            end = now;
        }
        const startStr = start.toISOString().slice(0, 19).replace('T', ' ');
        const endStr = end.toISOString().slice(0, 19).replace('T', ' ');
        let where = 'pe.entryTime >= ? AND pe.entryTime < ?';
        const params = [startStr, endStr];
        if (siteId) {
            where += ' AND pe.siteId = ?';
            params.push(siteId);
        }
        const query = `
            SELECT 
                pe.id,
                pe.siteId,
                pe.VRM,
                pe.entryTime,
                pe.exitTime,
                pe.durationMinutes,
                pe.throughTraffic,
                pe.entryDetectionId,
                pe.exitDetectionId,
                pe.entryCameraId,
                pe.exitCameraId,
                pe.status,
                cp.name as carParkName,
                entry_d.VRM as entryVRM,
                entry_d.timestamp as entryTimestamp,
                (LENGTH(entry_d.image1) > 0) as hasEntryImage1,
                (LENGTH(entry_d.image2) > 0) as hasEntryImage2,
                exit_d.VRM as exitVRM,
                exit_d.timestamp as exitTimestamp,
                (LENGTH(exit_d.image1) > 0) as hasExitImage1,
                (LENGTH(exit_d.image2) > 0) as hasExitImage2,
                entry_cam.name as entryCameraName,
                exit_cam.name as exitCameraName
            FROM parking_events pe
            JOIN carparks cp ON pe.siteId = cp.siteId
            LEFT JOIN anpr_detections entry_d ON pe.entryDetectionId = entry_d.id
            LEFT JOIN anpr_detections exit_d ON pe.exitDetectionId = exit_d.id
            LEFT JOIN cameras entry_cam ON pe.entryCameraId = entry_cam.name
            LEFT JOIN cameras exit_cam ON pe.exitCameraId = exit_cam.name
            WHERE ${where}
            ORDER BY pe.entryTime DESC LIMIT 500`;
        console.log('[EVENTS LIST API] Executing query with params:', params);
        const events = await conn.query(query, params);
        console.log(`[EVENTS LIST API] Found ${events.length} events`);
        res.json(events);
    } catch (err) {
        console.error('[EVENTS LIST API] Error loading filtered events:', err);
        res.status(500).json({ error: 'Error loading filtered events' });
    } finally {
        if (conn) conn.release();
    }
});

app.get('/events-test', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const events = await conn.query(`
            SELECT 
                pe.id,
                pe.siteId,
                pe.VRM,
                pe.entryTime,
                pe.exitTime,
                pe.status
            FROM parking_events pe
            ORDER BY pe.entryTime DESC LIMIT 100
        `);
        res.render('events_test', { events });
    } catch (err) {
        console.error('Error loading events-test:', err);
        res.status(500).send('Error loading events-test');
    } finally {
        if (conn) conn.release();
    }
});

// Regenerate events for a specific VRM at a car park and date range
app.post('/admin/regenerate-events-for-vrm', async (req, res) => {
    let conn;
    try {
        const { siteId, vrm, startDate, endDate } = req.body;
        if (!siteId || !vrm || !startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        conn = await pool.getConnection();
        // Delete existing events for this VRM, car park, and date range
        await conn.query(
            'DELETE FROM parking_events WHERE siteId = ? AND VRM = ? AND entryTime >= ? AND entryTime <= ?',
            [siteId, vrm, startDate, endDate]
        );
        // Generate new events for this VRM and car park in the date range
        // (Assume generateParkingEvents supports filtering by siteId, VRM, and date range)
        const events = await generateParkingEvents(startDate, endDate, false, null, siteId, vrm);
        res.json({ success: true, regenerated: events.length });
    } catch (err) {
        console.error('Error regenerating events for VRM:', err);
        res.status(500).json({ error: 'Error regenerating events for VRM' });
    } finally {
        if (conn) conn.release();
    }
});
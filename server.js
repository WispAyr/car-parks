const express = require('express');
const mariadb = require('mariadb');
require('dotenv').config();
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.use(express.static('public'));

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

// Route to display ANPR detections (real-time view) - now at /realtime
app.get('/realtime', async (req, res) => {
    let conn;
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    try {
        conn = await pool.getConnection();
        // Only fetch non-image fields for the main list
        const rows = await conn.query(`SELECT id, VRM, createdAt, type, timestamp, direction, confidence, tag, tagConfidence, country, cameraId FROM anpr_detections ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, offset]);
        // Convert Date objects to UTC string (YYYY-MM-DD HH:MM:SS)
        const detections = rows.map(row => ({
            ...row,
            createdAt: row.createdAt instanceof Date
                ? row.createdAt.toISOString().replace('T', ' ').substring(0, 19)
                : row.createdAt,
            timestamp: row.timestamp instanceof Date
                ? row.timestamp.toISOString().replace('T', ' ').substring(0, 19)
                : row.timestamp
        }));
        // Get total count for pagination
        const countResult = await conn.query('SELECT COUNT(*) as count FROM anpr_detections');
        const total = Number(countResult[0].count);
        const totalPages = Math.ceil(total / limit);
        res.render('index', { detections, page, totalPages });
    } catch (err) {
        console.error('Error fetching data:', err);
        res.status(500).render('error', { message: 'Error fetching data' });
    } finally {
        if (conn) conn.release();
    }
});

// Main dashboard: Parking Events
app.get('/', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks');
        res.render('events', { carparks });
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
        console.log(`Database connection established for image request ID: ${req.params.id}`);
        
        const imageType = req.params.type === '2' ? 'image2' : 'image1';
        const imageQuery = `SELECT ${imageType} as image FROM anpr_detections WHERE id = ?`;
        console.log(`Executing query: ${imageQuery} with ID: ${req.params.id}`);
        
        const rows = await conn.query(imageQuery, [req.params.id]);
        console.log(`Query result rows length:`, rows.length);
        
        if (rows.length > 0) {
            console.log(`Raw image data type:`, typeof rows[0].image);
            console.log(`Raw image data:`, rows[0].image ? 'Present' : 'Null');
            
            if (rows[0].image) {
                let imageData = rows[0].image;
                let imageBuffer;
                // Convert Buffer to string for base64 check
                let asString = (typeof imageData === 'string') ? imageData : imageData.toString();
                if (asString.startsWith('/9j/')) {
                    // Base64-encoded JPEG
                    imageBuffer = Buffer.from(asString, 'base64');
                    console.log('Decoded base64 image data to buffer.');
                } else {
                    // Raw binary
                    imageBuffer = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData);
                    console.log('Used raw binary image data.');
                }
                console.log(`Image buffer created for ID: ${req.params.id}, length: ${imageBuffer.length}, isBuffer: ${Buffer.isBuffer(imageBuffer)}`);

                // Set headers for JPEG image
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=31536000');
                res.send(imageBuffer);
                console.log(`Image sent successfully for ID: ${req.params.id}`);
            } else {
                console.log(`No image data found for ${imageType}, ID: ${req.params.id}`);
                res.status(404).send('Image not found');
            }
        } else {
            console.log(`No rows found for ID: ${req.params.id}`);
            res.status(404).send('Image not found');
        }
    } catch (err) {
        console.error(`Error fetching JPEG image for ID ${req.params.id}:`, err);
        console.error('Error details:', err.message);
        res.status(500).send('Error loading image');
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
        // Query detections with camera and carpark info
        const rows = await conn.query(`
            SELECT d.VRM, d.timestamp, d.direction, d.cameraID, c.siteId, 
                   c.isEntryTrigger, c.isExitTrigger, c.direction as cameraDirection,
                   cp.throughTrafficMinutes
            FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.cameraId
            JOIN carparks cp ON c.siteId = cp.siteId
            ${siteId ? 'WHERE c.siteId = ?' : ''}
            ORDER BY c.siteId, d.VRM, d.timestamp
        `, siteId ? [siteId] : []);

        // Group by site and VRM
        const events = [];
        let currentSite = null, currentVRM = null, buffer = [], throughLimit = 10;
        
        function processBuffer(site, vrm, buffer, throughLimit) {
            let i = 0;
            while (i < buffer.length) {
                // Find entry
                if (buffer[i].isEntry) {
                    let entry = buffer[i];
                    // Find next exit
                    let j = i + 1;
                    while (j < buffer.length && !buffer[j].isExit) j++;
                    if (j < buffer.length) {
                        let exit = buffer[j];
                        let duration = (new Date(exit.timestamp) - new Date(entry.timestamp)) / 60000; // minutes
                        events.push({
                            siteId: site,
                            VRM: vrm,
                            entryTime: entry.timestamp,
                            exitTime: exit.timestamp,
                            durationMinutes: duration,
                            throughTraffic: duration <= throughLimit
                        });
                        i = j + 1;
                    } else {
                        // No exit found, still parked
                        events.push({
                            siteId: site,
                            VRM: vrm,
                            entryTime: entry.timestamp,
                            exitTime: null,
                            durationMinutes: null,
                            throughTraffic: false
                        });
                        break;
                    }
                } else {
                    i++;
                }
            }
        }

        for (const row of rows) {
            // Determine if this detection is entry or exit based on camera configuration
            const isEntry = row.isEntryTrigger && row.direction === row.cameraDirection;
            const isExit = row.isExitTrigger && row.direction === row.cameraDirection;

            if (row.siteId !== currentSite || row.VRM !== currentVRM) {
                if (buffer.length && currentSite && currentVRM) {
                    processBuffer(currentSite, currentVRM, buffer, throughLimit);
                }
                currentSite = row.siteId;
                currentVRM = row.VRM;
                throughLimit = row.throughTrafficMinutes || 10;
                buffer = [];
            }

            if (isEntry || isExit) {
                buffer.push({
                    timestamp: row.timestamp,
                    isEntry,
                    isExit
                });
            }
        }

        if (buffer.length && currentSite && currentVRM) {
            processBuffer(currentSite, currentVRM, buffer, throughLimit);
        }

        res.json(events);
    } catch (err) {
        console.error('Error inferring parking events:', err);
        res.status(500).json({ error: 'Error inferring parking events' });
    } finally {
        if (conn) conn.release();
    }
});

// Admin navigation
app.get('/admin', (req, res) => {
    res.render('admin_nav');
});

// Car parks management
app.get('/admin/carparks', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query('SELECT * FROM carparks');
        res.render('admin_carparks', { carparks });
    } finally { if (conn) conn.release(); }
});
app.post('/admin/carparks/add', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('INSERT INTO carparks (siteId, name, throughTrafficMinutes) VALUES (?, ?, ?)', [req.body.siteId, req.body.name, req.body.throughTrafficMinutes]);
    } finally { if (conn) conn.release(); }
    res.redirect('/admin/carparks');
});
app.post('/admin/carparks/edit', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('UPDATE carparks SET name=?, throughTrafficMinutes=? WHERE siteId=?', [req.body.name, req.body.throughTrafficMinutes, req.body.siteId]);
    } finally { if (conn) conn.release(); }
    res.redirect('/admin/carparks');
});
app.post('/admin/carparks/delete', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Check for cameras referencing this car park
        const cameras = await conn.query('SELECT id FROM cameras WHERE carParkId=?', [req.body.id]);
        if (cameras.length > 0) {
            // Prevent deletion and show a message
            res.status(400).send('Cannot delete car park: cameras are still assigned to it.');
            return;
        }
        await conn.query('DELETE FROM carparks WHERE id=?', [req.body.id]);
    } catch (err) {
        console.error('Error deleting car park:', err);
        res.status(500).send('Error deleting car park: ' + err.message);
        return;
    } finally { if (conn) conn.release(); }
    res.redirect('/admin/carparks');
});

// Cameras management
app.get('/admin/cameras', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const cameras = await conn.query('SELECT c.*, p.name as carparkName FROM cameras c LEFT JOIN carparks p ON c.carParkId = p.id');
        const carparks = await conn.query('SELECT * FROM carparks');
        res.render('admin/cameras', { cameras, carparks });
    } finally { if (conn) conn.release(); }
});
app.post('/admin/cameras/add', async (req, res) => {
    let conn;
    try {
        console.log('Received camera add request:', req.body);
        conn = await pool.getConnection();
        
        // Convert checkbox values to boolean
        const isEntryTrigger = req.body.isEntryTrigger === 'on' || req.body.isEntryTrigger === true;
        const isExitTrigger = req.body.isExitTrigger === 'on' || req.body.isExitTrigger === true;
        
        await conn.query(
            'INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction) VALUES (?, ?, ?, ?, ?)',
            [
                req.body.name || '',
                req.body.carParkId || null,
                isEntryTrigger,
                isExitTrigger,
                req.body.direction || 'in'
            ]
        );
    } catch (err) {
        console.error('Error adding camera:', err);
        res.status(500).send('Error adding camera: ' + err.message);
        return;
    } finally { 
        if (conn) conn.release(); 
    }
    res.redirect('/admin/cameras');
});
app.post('/admin/cameras/edit', async (req, res) => {
    let conn;
    try {
        console.log('Received camera edit request:', req.body);
        conn = await pool.getConnection();
        
        // Convert checkbox values to boolean
        const isEntryTrigger = req.body.isEntryTrigger === 'on' || req.body.isEntryTrigger === true;
        const isExitTrigger = req.body.isExitTrigger === 'on' || req.body.isExitTrigger === true;
        
        await conn.query(
            'UPDATE cameras SET name=?, carParkId=?, isEntryTrigger=?, isExitTrigger=?, direction=? WHERE id=?',
            [
                req.body.name || '',
                req.body.carParkId || null,
                isEntryTrigger,
                isExitTrigger,
                req.body.direction || 'in',
                req.body.id
            ]
        );
    } catch (err) {
        console.error('Error updating camera:', err);
        res.status(500).send('Error updating camera: ' + err.message);
        return;
    } finally { 
        if (conn) conn.release(); 
    }
    res.redirect('/admin/cameras');
});
app.post('/admin/cameras/delete', async (req, res) => {
    let conn;
    try {
        console.log('Received camera delete request:', req.body);
        conn = await pool.getConnection();
        await conn.query('DELETE FROM cameras WHERE id=?', [req.body.id]);
    } catch (err) {
        console.error('Error deleting camera:', err);
        res.status(500).send('Error deleting camera: ' + err.message);
        return;
    } finally { 
        if (conn) conn.release(); 
    }
    res.redirect('/admin/cameras');
});

// Camera Status & Metrics Dashboard
app.get('/camera-status', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all cameras
        const cameras = await conn.query('SELECT cameraId, name FROM cameras');
        // Get all detections in the last 31 days for metrics
        const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        const detections = await conn.query(
            'SELECT cameraId, timestamp FROM anpr_detections WHERE timestamp >= ? ORDER BY cameraId, timestamp',
            [since.toISOString().slice(0, 19).replace('T', ' ')]
        );
        // Get all detections in the last 24 hours for sparklines
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const detections24h = await conn.query(
            'SELECT cameraId, timestamp FROM anpr_detections WHERE timestamp >= ? ORDER BY cameraId, timestamp',
            [since24h.toISOString().slice(0, 19).replace('T', ' ')]
        );
        // Group detections by camera
        const now = new Date();
        const cameraStats = cameras.map(cam => {
            const camDetections = detections.filter(d => d.cameraId == cam.cameraId);
            const lastDetection = camDetections.length > 0 ? camDetections[camDetections.length - 1].timestamp : null;
            // Detections in last hour, day, month
            const lastHour = camDetections.filter(d => (now - new Date(d.timestamp)) <= 60 * 60 * 1000).length;
            const lastDay = camDetections.filter(d => (now - new Date(d.timestamp)) <= 24 * 60 * 60 * 1000).length;
            const lastMonth = camDetections.length;
            // Daytime/nighttime split (07:00-19:00 is day)
            const isDay = dt => {
                const h = new Date(dt).getHours();
                return h >= 7 && h < 19;
            };
            // Last 24h
            const camDetections24h = detections24h.filter(d => d.cameraId == cam.cameraId);
            const day24h = camDetections24h.filter(d => isDay(d.timestamp)).length;
            const night24h = camDetections24h.length - day24h;
            // Last 30d
            const day30d = camDetections.filter(d => isDay(d.timestamp)).length;
            const night30d = camDetections.length - day30d;
            // Average interval (in minutes) between detections (last 30 days)
            let avgInterval = null;
            if (camDetections.length > 1) {
                let total = 0;
                for (let i = 1; i < camDetections.length; i++) {
                    total += (new Date(camDetections[i].timestamp) - new Date(camDetections[i - 1].timestamp));
                }
                avgInterval = total / (camDetections.length - 1) / 60000; // in minutes
            }
            // Adaptive thresholds
            let greenLimit, yellowLimit;
            if (avgInterval && avgInterval < 60) {
                greenLimit = 2 * avgInterval * 60 * 1000;
                yellowLimit = 5 * avgInterval * 60 * 1000;
            } else if (avgInterval) {
                greenLimit = 2 * avgInterval * 60 * 1000;
                yellowLimit = 5 * avgInterval * 60 * 1000;
            } else {
                // fallback for very quiet cameras
                greenLimit = 24 * 60 * 60 * 1000; // 24h
                yellowLimit = 3 * 24 * 60 * 60 * 1000; // 3d
            }
            let status = 'red';
            if (lastDetection) {
                const msSince = now - new Date(lastDetection);
                if (msSince <= greenLimit) status = 'green';
                else if (msSince <= yellowLimit) status = 'yellow';
            }
            // Sparkline: detections per hour for last 24 hours
            const sparkline = Array(24).fill(0);
            camDetections24h.forEach(d => {
                const hourAgo = Math.floor((now - new Date(d.timestamp)) / (60 * 60 * 1000));
                if (hourAgo >= 0 && hourAgo < 24) {
                    sparkline[23 - hourAgo] += 1; // 0 = oldest, 23 = most recent
                }
            });
            return {
                cameraId: cam.cameraId,
                name: cam.name,
                lastDetection,
                lastHour,
                lastDay,
                lastMonth,
                avgInterval,
                status,
                greenLimit: greenLimit / 60000, // in minutes
                yellowLimit: yellowLimit / 60000, // in minutes
                sparkline,
                day24h,
                night24h,
                day30d,
                night30d
            };
        });
        res.render('camera_status', { cameraStats });
    } catch (err) {
        console.error('Error loading camera status:', err);
        res.status(500).render('error', { message: 'Error loading camera status' });
    } finally {
        if (conn) conn.release();
    }
});

// Update cameras table schema
app.get('/admin/setup', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Add new columns
        await conn.query(`
            ALTER TABLE cameras 
            ADD COLUMN isEntryTrigger BOOLEAN DEFAULT false,
            ADD COLUMN isExitTrigger BOOLEAN DEFAULT false,
            ADD COLUMN direction VARCHAR(10) DEFAULT 'in'
        `);
        // Migrate existing data
        await conn.query(`
            UPDATE cameras 
            SET isEntryTrigger = CASE 
                    WHEN entryDirections LIKE '%both%' OR entryDirections LIKE '%in%' THEN true 
                    ELSE false 
                END,
                isExitTrigger = CASE 
                    WHEN exitDirections LIKE '%both%' OR exitDirections LIKE '%out%' THEN true 
                    ELSE false 
                END,
                direction = CASE 
                    WHEN entryDirections LIKE '%in%' OR exitDirections LIKE '%in%' THEN 'in'
                    WHEN entryDirections LIKE '%out%' OR exitDirections LIKE '%out%' THEN 'out'
                    ELSE 'in'
                END
        `);
        res.send('Database updated successfully');
    } catch (err) {
        console.error('Error updating database:', err);
        res.status(500).send('Error updating database');
    } finally {
        if (conn) conn.release();
    }
});

// TEMPORARY: Camera table migration route
app.get('/admin/migrate-cameras', async (req, res) => {
    let conn;
    let actions = [];
    try {
        conn = await pool.getConnection();
        // Add carParkId if not exists
        try {
            await conn.query('ALTER TABLE cameras ADD COLUMN carParkId INT');
            actions.push('Added carParkId column');
        } catch (e) {
            if (e.code === 'ER_DUP_FIELDNAME') actions.push('carParkId column already exists');
            else throw e;
        }
        // Map cameras.siteId (string) to carparks.id (int) and set cameras.carParkId
        try {
            // Get all carparks: {siteId, id}
            const carparks = await conn.query('SELECT siteId, id FROM carparks');
            // Get all cameras: {id, siteId}
            const cameras = await conn.query('SELECT id, siteId FROM cameras');
            let updated = 0;
            for (const cam of cameras) {
                const cp = carparks.find(cp => cp.siteId === cam.siteId);
                if (cp) {
                    await conn.query('UPDATE cameras SET carParkId = ? WHERE id = ?', [cp.id, cam.id]);
                    updated++;
                }
            }
            actions.push(`Mapped and updated carParkId for ${updated} cameras`);
        } catch (e) {
            if (e.code === 'ER_BAD_FIELD_ERROR') actions.push('siteId column does not exist');
            else throw e;
        }
        // Drop siteId
        try {
            await conn.query('ALTER TABLE cameras DROP COLUMN siteId');
            actions.push('Dropped siteId column');
        } catch (e) {
            if (e.code === 'ER_BAD_FIELD_ERROR') actions.push('siteId column already dropped');
            else throw e;
        }
        // Drop entryDirections
        try {
            await conn.query('ALTER TABLE cameras DROP COLUMN entryDirections');
            actions.push('Dropped entryDirections column');
        } catch (e) {
            if (e.code === 'ER_BAD_FIELD_ERROR') actions.push('entryDirections column already dropped');
            else throw e;
        }
        // Drop exitDirections
        try {
            await conn.query('ALTER TABLE cameras DROP COLUMN exitDirections');
            actions.push('Dropped exitDirections column');
        } catch (e) {
            if (e.code === 'ER_BAD_FIELD_ERROR') actions.push('exitDirections column already dropped');
            else throw e;
        }
        // Drop cameraId
        try {
            await conn.query('ALTER TABLE cameras DROP COLUMN cameraId');
            actions.push('Dropped cameraId column');
        } catch (e) {
            if (e.code === 'ER_BAD_FIELD_ERROR') actions.push('cameraId column already dropped');
            else throw e;
        }
        res.send('Migration complete. Actions: ' + actions.join(', '));
    } catch (err) {
        console.error('Migration error:', err);
        res.status(500).send('Migration error: ' + err.message);
    } finally {
        if (conn) conn.release();
    }
});

app.use(bodyParser.urlencoded({ extended: true }));

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
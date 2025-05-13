const express = require('express');
const mariadb = require('mariadb');
require('dotenv').config();
const bodyParser = require('body-parser');
const expressLayouts = require('express-ejs-layouts');

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

// Route to display ANPR detections (real-time view) - now at /realtime
app.get('/realtime', async (req, res) => {
    let conn;
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const selectedCarPark = req.query.siteId || '';
        
        // Build query with optional car park filter
        let query = `
            SELECT d.id, d.VRM, d.createdAt, d.type, d.timestamp, d.direction, 
                   d.confidence, d.tag, d.tagConfidence, d.country, d.cameraID,
                   c.carParkId
            FROM anpr_detections d
            LEFT JOIN cameras c ON d.cameraID = c.name
        `;
        
        const queryParams = [];
        if (selectedCarPark) {
            query += ' WHERE c.carParkId = ?';
            queryParams.push(selectedCarPark);
        }
        
        query += ' ORDER BY d.id DESC LIMIT ? OFFSET ?';
        queryParams.push(limit, offset);
        
        const rows = await conn.query(query, queryParams);
        
        // Convert Date objects to UTC string
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
        let countQuery = `
            SELECT COUNT(*) as count 
            FROM anpr_detections d
            LEFT JOIN cameras c ON d.cameraID = c.name
        `;
        if (selectedCarPark) {
            countQuery += ' WHERE c.carParkId = ?';
        }
        const countResult = await conn.query(countQuery, selectedCarPark ? [selectedCarPark] : []);
        const total = Number(countResult[0].count);
        const totalPages = Math.ceil(total / limit);
        
        res.render('index', { 
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

// Main dashboard: Parking Events
app.get('/', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks for filter dropdown
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const selectedCarPark = req.query.siteId || '';
        
        // Get events with optional car park filter
        let events = [];
        if (selectedCarPark) {
            events = await generateParkingEvents(conn, selectedCarPark);
        } else {
            events = await generateParkingEvents(conn);
        }
        
        res.render('events', { 
            carparks,
            selectedCarPark,
            events
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

// Function to generate parking events
async function generateParkingEvents(conn, siteId = null) {
    try {
        // Query detections with camera and carpark info
        const rows = await conn.query(`
            SELECT d.VRM, d.timestamp, d.direction, d.cameraID, 
                   c.carParkId, c.isEntryTrigger, c.isExitTrigger, 
                   c.direction as cameraDirection,
                   cp.throughTrafficMinutes
            FROM anpr_detections d
            JOIN cameras c ON d.cameraID = c.name
            JOIN carparks cp ON c.carParkId = cp.siteId
            ${siteId ? 'WHERE cp.siteId = ?' : ''}
            ORDER BY cp.siteId, d.VRM, d.timestamp
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

        return events;
    } catch (err) {
        console.error('Error generating parking events:', err);
        throw err;
    }
}

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
app.post('/admin/generate-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const events = await generateParkingEvents(conn);
        
        // Store events in the database
        for (const event of events) {
            await conn.query(`
                INSERT INTO parking_events 
                (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                exitTime = VALUES(exitTime),
                durationMinutes = VALUES(durationMinutes),
                throughTraffic = VALUES(throughTraffic)
            `, [
                event.siteId,
                event.VRM,
                event.entryTime,
                event.exitTime,
                event.durationMinutes,
                event.throughTraffic
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

// Set up automatic event generation every 5 minutes
setInterval(async () => {
    let conn;
    try {
        conn = await pool.getConnection();
        const events = await generateParkingEvents(conn);
        
        // Store events in the database
        for (const event of events) {
            await conn.query(`
                INSERT INTO parking_events 
                (siteId, VRM, entryTime, exitTime, durationMinutes, throughTraffic)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                exitTime = VALUES(exitTime),
                durationMinutes = VALUES(durationMinutes),
                throughTraffic = VALUES(throughTraffic)
            `, [
                event.siteId,
                event.VRM,
                event.entryTime,
                event.exitTime,
                event.durationMinutes,
                event.throughTraffic
            ]);
        }
        
        console.log(`Automatically generated ${events.length} parking events`);
    } catch (err) {
        console.error('Error in automatic event generation:', err);
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
    try {
        const carparks = await pool.query(`
            SELECT c.*, COUNT(cm.name) as cameraCount 
            FROM carparks c 
            LEFT JOIN cameras cm ON c.siteId = cm.carParkId 
            GROUP BY c.siteId
        `);
        res.render('admin_carparks', { 
            carparks,
            selectedCarPark: req.query.siteId || ''
        });
    } catch (err) {
        console.error('Error fetching car parks:', err);
        res.status(500).send('Error fetching car parks');
    }
});

app.post('/admin/carparks/add', async (req, res) => {
    const { siteId, name, throughTrafficMinutes } = req.body;
    try {
        await pool.query(
            'INSERT INTO carparks (siteId, name, throughTrafficMinutes) VALUES (?, ?, ?)',
            [siteId, name, throughTrafficMinutes]
        );
        res.redirect('/admin/carparks');
    } catch (err) {
        console.error('Error adding car park:', err);
        res.status(500).send('Error adding car park');
    }
});

app.post('/admin/carparks/edit', async (req, res) => {
    const { originalSiteId, siteId, name, throughTrafficMinutes } = req.body;
    try {
        await pool.query(
            'UPDATE carparks SET siteId = ?, name = ?, throughTrafficMinutes = ? WHERE siteId = ?',
            [siteId, name, throughTrafficMinutes, originalSiteId]
        );
        res.redirect('/admin/carparks');
    } catch (err) {
        console.error('Error updating car park:', err);
        res.status(500).send('Error updating car park');
    }
});

app.post('/admin/carparks/delete', async (req, res) => {
    const { siteId } = req.body;
    try {
        // Check if car park has cameras
        const cameras = await pool.query('SELECT COUNT(*) as count FROM cameras WHERE carParkId = ?', [siteId]);
        if (cameras[0].count > 0) {
            return res.status(400).send('Cannot delete car park: has cameras assigned');
        }
        
        await pool.query('DELETE FROM carparks WHERE siteId = ?', [siteId]);
        res.redirect('/admin/carparks');
    } catch (err) {
        console.error('Error deleting car park:', err);
        res.status(500).send('Error deleting car park');
    }
});

// Cameras management
app.get('/admin/cameras', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const cameras = await conn.query(`
            SELECT DISTINCT c.*, cp.name as carparkName
            FROM cameras c
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId
            ORDER BY c.name
        `);
        const carparks = await conn.query('SELECT * FROM carparks ORDER BY name');
        res.render('admin/cameras', { 
            cameras,
            carparks,
            selectedCarPark: ''
        });
    } catch (err) {
        console.error('Error fetching cameras:', err);
        res.status(500).render('error', { message: 'Failed to fetch cameras: ' + err.message });
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
        
        // Insert new camera
        await conn.query(`
            INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction)
            VALUES (?, ?, ?, ?, ?)
        `, [name, carParkId || null, isEntryTrigger === 'true', isExitTrigger === 'true', direction]);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error adding camera:', err);
        res.status(500).json({ error: err.message });
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
        // Update camera with proper type handling
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
            carParkId || null,  // Handle empty carParkId
            isEntry,            // Converted boolean
            isExit,             // Converted boolean
            direction, 
            originalName        // Use originalName as the identifier
        ]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating camera:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/admin/cameras/delete', async (req, res) => {
    let conn;
    try {
        const { id } = req.body;
        
        conn = await pool.getConnection();
        
        // Check if camera has any detections
        const detections = await conn.query('SELECT id FROM anpr_detections WHERE cameraID = (SELECT name FROM cameras WHERE id = ?)', [id]);
        if (detections.length > 0) {
            res.status(400).json({ error: 'Cannot delete camera: it has existing detections' });
            return;
        }
        
        await conn.query('DELETE FROM cameras WHERE id = ?', [id]);
        
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
        
        // Get hourly data for sparklines
        const hourlyData = await Promise.all(camerasWithStats.map(async camera => {
            const hourlyStats = await conn.query(`
                SELECT 
                    HOUR(timestamp) as hour,
                    COUNT(*) as count
                FROM anpr_detections
                WHERE cameraID = ?
                AND timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                GROUP BY HOUR(timestamp)
                ORDER BY hour
            `, [camera.name]);
            
            // Create array of 24 hours, filling in missing hours with 0
            const sparkline = Array(24).fill(0);
            hourlyStats.forEach(stat => {
                sparkline[stat.hour] = Number(stat.count);
            });
            
            return {
                name: camera.name,
                sparkline
            };
        }));
        
        // Process the data for the template
        const processedCameras = camerasWithStats.map(camera => {
            const hourlyData = hourlyData.find(h => h.name === camera.name);
            return {
                name: camera.name,
                isEntryTrigger: Boolean(camera.isEntryTrigger),
                isExitTrigger: Boolean(camera.isExitTrigger),
                direction: camera.direction,
                carParkId: camera.carParkId ? Number(camera.carParkId) : null,
                lastDetection: camera.lastDetection,
                detectionCount: Number(camera.detectionCount),
                lastHour: Number(camera.lastHour || 0),
                lastDay: Number(camera.lastDay || 0),
                lastMonth: Number(camera.lastMonth || 0),
                day24h: Number(camera.day24h || 0),
                night24h: Number(camera.night24h || 0),
                day30d: Number(camera.day30d || 0),
                night30d: Number(camera.night30d || 0),
                sparkline: hourlyData ? hourlyData.sparkline : Array(24).fill(0)
            };
        });
        
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
        
        // First, get the current table structure
        const tableInfo = await conn.query('DESCRIBE cameras');
        const existingColumns = tableInfo.map(col => col.Field);
        console.log('Existing columns:', existingColumns);
        
        // Add carParkId if not exists
        if (!existingColumns.includes('carParkId')) {
            await conn.query('ALTER TABLE cameras ADD COLUMN carParkId INT');
            actions.push('Added carParkId column');
        } else {
            actions.push('carParkId column already exists');
        }
        
        // Get unique camera IDs from detections
        const cameras = await conn.query(`
            SELECT DISTINCT cameraID as name
            FROM anpr_detections 
            WHERE cameraID IS NOT NULL
        `);
        
        console.log('Found cameras in detections:', cameras);
        
        // Insert each camera
        for (const camera of cameras) {
            await conn.query(`
                INSERT INTO cameras (name, entryDirection, isEntryTrigger, isExitTrigger, direction)
                VALUES (?, 'towards', true, true, 'in')
                ON DUPLICATE KEY UPDATE name = name
            `, [camera.name]);
        }
        actions.push(`Created ${cameras.length} cameras from detection data`);
        
        // Get all car parks
        const carparks = await conn.query('SELECT id, name FROM carparks');
        console.log('Car parks:', carparks);
        
        // Update car park IDs
        let updated = 0;
        for (const camera of cameras) {
            // Try to find a matching car park
            const carpark = carparks.find(cp => 
                camera.name.toLowerCase().includes(cp.name.toLowerCase()) ||
                cp.name.toLowerCase().includes(camera.name.toLowerCase())
            );
            
            if (carpark) {
                await conn.query('UPDATE cameras SET carParkId = ? WHERE name = ?', 
                    [carpark.id, camera.name]);
                updated++;
            }
        }
        actions.push(`Updated ${updated} cameras with car park IDs`);
        
        // Drop columns if they exist
        const columnsToDrop = ['siteId', 'entryDirections', 'exitDirections', 'cameraId'];
        for (const column of columnsToDrop) {
            if (existingColumns.includes(column)) {
                await conn.query(`ALTER TABLE cameras DROP COLUMN ${column}`);
                actions.push(`Dropped ${column} column`);
            } else {
                actions.push(`${column} column already dropped`);
            }
        }
        
        res.send('Migration complete. Actions: ' + actions.join(', '));
    } catch (err) {
        console.error('Migration error:', err);
        res.status(500).send('Migration error: ' + err.message);
    } finally {
        if (conn) conn.release();
    }
});

// Migration endpoint to create cameras from detection data
app.get('/admin/migrate-cameras-from-detections', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Get unique camera IDs from detections
        const cameras = await conn.query(`
            SELECT DISTINCT cameraID as name
            FROM anpr_detections 
            WHERE cameraID IS NOT NULL
        `);
        
        console.log('Found cameras in detections:', cameras);
        
        // Insert each camera
        for (const camera of cameras) {
            await conn.query(`
                INSERT INTO cameras (name, entryDirection, isEntryTrigger, isExitTrigger, direction)
                VALUES (?, 'towards', true, true, 'in')
                ON DUPLICATE KEY UPDATE name = name
            `, [camera.name]);
        }
        
        res.send(`Created ${cameras.length} cameras from detection data`);
    } catch (err) {
        console.error('Error migrating cameras:', err);
        res.status(500).send('Error migrating cameras: ' + err.message);
    } finally {
        if (conn) conn.release();
    }
});

// Endpoint to update camera car park IDs
app.get('/admin/update-camera-carparks', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        
        // Get all car parks
        const carparks = await conn.query('SELECT id, name FROM carparks');
        console.log('Car parks:', carparks);
        
        // Get all cameras
        const cameras = await conn.query('SELECT name FROM cameras');
        console.log('Cameras:', cameras);
        
        let updated = 0;
        // Try to match cameras to car parks based on name
        for (const camera of cameras) {
            // Try to find a matching car park
            const carpark = carparks.find(cp => 
                camera.name.toLowerCase().includes(cp.name.toLowerCase()) ||
                cp.name.toLowerCase().includes(camera.name.toLowerCase())
            );
            
            if (carpark) {
                await conn.query('UPDATE cameras SET carParkId = ? WHERE name = ?', 
                    [carpark.id, camera.name]);
                updated++;
            }
        }
        
        res.send(`Updated ${updated} cameras with car park IDs`);
    } catch (err) {
        console.error('Error updating camera car parks:', err);
        res.status(500).send('Error updating camera car parks: ' + err.message);
    } finally {
        if (conn) conn.release();
    }
});

// Car park dashboard
app.get('/admin/carparks/:siteId/dashboard', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const { siteId } = req.params;

        // Get car park details
        const carparks = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [siteId]);
        if (carparks.length === 0) {
            return res.status(404).render('error', { message: 'Car park not found' });
        }
        const carpark = carparks[0];

        // Get cameras for this car park
        const cameras = await conn.query(`
            SELECT * FROM cameras 
            WHERE carParkId = ?
            ORDER BY name
        `, [siteId]);

        // Get current occupancy (vehicles that have entered but not exited)
        const currentOccupancy = await conn.query(`
            SELECT COUNT(*) as count
            FROM parking_events
            WHERE siteId = ? 
            AND exitTime IS NULL
        `, [siteId]);

        // Get today's statistics
        const todayStats = await conn.query(`
            SELECT 
                COUNT(*) as totalVehicles,
                SUM(CASE WHEN throughTraffic = 1 THEN 1 ELSE 0 END) as throughTraffic,
                AVG(durationMinutes) as avgDuration,
                MAX(durationMinutes) as maxDuration
            FROM parking_events
            WHERE siteId = ?
            AND DATE(entryTime) = CURDATE()
        `, [siteId]);

        // Get hourly distribution for today
        const hourlyDistribution = await conn.query(`
            SELECT 
                HOUR(entryTime) as hour,
                COUNT(*) as count
            FROM parking_events
            WHERE siteId = ?
            AND DATE(entryTime) = CURDATE()
            GROUP BY HOUR(entryTime)
            ORDER BY hour
        `, [siteId]);

        // Get recent events (last 10)
        const recentEvents = await conn.query(`
            SELECT 
                pe.*,
                d1.image1 as entryImage,
                d2.image2 as exitImage
            FROM parking_events pe
            LEFT JOIN anpr_detections d1 ON pe.VRM = d1.VRM 
                AND pe.entryTime = d1.timestamp
            LEFT JOIN anpr_detections d2 ON pe.VRM = d2.VRM 
                AND pe.exitTime = d2.timestamp
            WHERE pe.siteId = ?
            ORDER BY pe.entryTime DESC
            LIMIT 10
        `, [siteId]);

        // Get monthly statistics
        const monthlyStats = await conn.query(`
            SELECT 
                DATE_FORMAT(entryTime, '%Y-%m') as month,
                COUNT(*) as totalVehicles,
                SUM(CASE WHEN throughTraffic = 1 THEN 1 ELSE 0 END) as throughTraffic,
                AVG(durationMinutes) as avgDuration
            FROM parking_events
            WHERE siteId = ?
            AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
            GROUP BY DATE_FORMAT(entryTime, '%Y-%m')
            ORDER BY month DESC
        `, [siteId]);

        // Get peak hours (last 30 days)
        const peakHours = await conn.query(`
            SELECT 
                HOUR(entryTime) as hour,
                COUNT(*) as count
            FROM parking_events
            WHERE siteId = ?
            AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY HOUR(entryTime)
            ORDER BY count DESC
            LIMIT 5
        `, [siteId]);

        // Get average stay duration by day of week
        const dailyStats = await conn.query(`
            SELECT 
                DAYNAME(entryTime) as day,
                AVG(durationMinutes) as avgDuration,
                COUNT(*) as totalVehicles
            FROM parking_events
            WHERE siteId = ?
            AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DAYNAME(entryTime)
            ORDER BY FIELD(DAYNAME(entryTime), 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
        `, [siteId]);

        // Get current vehicles (those that haven't exited)
        const currentVehicles = await conn.query(`
            SELECT 
                pe.*,
                d.image1 as entryImage
            FROM parking_events pe
            LEFT JOIN anpr_detections d ON pe.VRM = d.VRM 
                AND pe.entryTime = d.timestamp
            WHERE pe.siteId = ?
            AND pe.exitTime IS NULL
            ORDER BY pe.entryTime DESC
        `, [siteId]);

        res.render('admin/carpark_dashboard', {
            carpark,
            cameras,
            currentOccupancy: currentOccupancy[0].count,
            todayStats: todayStats[0],
            hourlyDistribution,
            recentEvents,
            monthlyStats,
            peakHours,
            dailyStats,
            currentVehicles
        });
    } catch (err) {
        console.error('Error loading car park dashboard:', err);
        res.status(500).render('error', { message: 'Error loading dashboard: ' + err.message });
    } finally {
        if (conn) conn.release();
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
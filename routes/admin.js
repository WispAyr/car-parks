const express = require('express');
const { getCachedWhitelists } = require('../mondayWhitelistService');
const logger = require('../utils/logger');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const csvParse = require('csv-parse/sync');

// Configure multer to preserve file extensions
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../tmp'))
    },
    filename: function (req, file, cb) {
        // Get the file extension
        const ext = path.extname(file.originalname);
        // Generate a unique filename with the original extension
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext)
    }
});
const upload = multer({ storage: storage });

module.exports = function(pool) {
const router = express.Router();

// Get all cameras with their car park names
router.get('/cameras', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const cameras = await conn.query(`
            SELECT c.*, cp.name as carParkName 
            FROM cameras c 
            LEFT JOIN carparks cp ON c.carParkId = cp.siteId 
            ORDER BY c.name
        `);
        const carParks = await conn.query('SELECT * FROM carparks ORDER BY name');
        res.render('admin/cameras', { 
            cameras, 
            carparks: carParks,
            title: 'Manage Cameras'
        });
    } catch (error) {
        logger.error('Error fetching cameras:', error);
        res.status(500).send('Error fetching cameras');
    } finally {
        if (conn) conn.release();
    }
});

// Create new camera
router.post('/api/cameras', async (req, res) => {
    let conn;
    try {
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction } = req.body;
        conn = await pool.getConnection();
        const result = await conn.query(
            'INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction) VALUES (?, ?, ?, ?, ?)',
            [name, carParkId, isEntryTrigger, isExitTrigger, direction]
        );
        res.json({ id: result.insertId });
    } catch (error) {
        logger.error('Error creating camera:', error);
        res.status(500).json({ error: 'Error creating camera' });
    } finally {
        if (conn) conn.release();
    }
});

// Update camera
router.put('/api/cameras/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE cameras SET name = ?, carParkId = ?, isEntryTrigger = ?, isExitTrigger = ?, direction = ? WHERE id = ?',
            [name, carParkId, isEntryTrigger, isExitTrigger, direction, id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('Error updating camera:', error);
        res.status(500).json({ error: 'Error updating camera' });
    } finally {
        if (conn) conn.release();
    }
});

// Delete camera
router.delete('/api/cameras/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        conn = await pool.getConnection();
        await conn.query('DELETE FROM cameras WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        logger.error('Error deleting camera:', error);
        res.status(500).json({ error: 'Error deleting camera' });
    } finally {
        if (conn) conn.release();
    }
});

// Car park dashboard with stats
router.get('/carparks/:id', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.params.id;
        
        // Get car park info
        const carparks = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [siteId]);
        const carPark = carparks && carparks[0] ? carparks[0] : null;
        if (!carPark) return res.status(404).render('error', { message: 'Car park not found' });
        
        // Current occupancy: vehicles still parked
        const [currentOccupancyRow] = await conn.query('SELECT COUNT(*) as count FROM parking_events WHERE siteId = ? AND exitTime IS NULL', [siteId]);
        const currentOccupancy = currentOccupancyRow ? currentOccupancyRow.count : 0;
        
        // Currently parked vehicles
        const currentVehicles = await conn.query(`
            SELECT VRM, entryTime, entryDetectionId as entryImage
            FROM parking_events
            WHERE siteId = ? AND exitTime IS NULL
            ORDER BY entryTime DESC
        `, [siteId]);
        
        // Today's stats
        const [todayStats] = await conn.query(`
            SELECT 
                COUNT(*) as totalVehicles,
                SUM(throughTraffic) as throughTraffic,
                AVG(durationMinutes) as avgDuration
            FROM parking_events
            WHERE siteId = ? AND DATE(entryTime) = CURDATE() AND exitTime IS NOT NULL
        `, [siteId]);
        todayStats.throughTraffic = todayStats.throughTraffic || 0;
        todayStats.avgDuration = todayStats.avgDuration || 0;
        
        // Hourly distribution for today
        const hourlyRows = await conn.query(`
            SELECT HOUR(entryTime) as hour, COUNT(*) as count
            FROM parking_events
            WHERE siteId = ? AND DATE(entryTime) = CURDATE() AND exitTime IS NOT NULL
            GROUP BY hour
            ORDER BY hour
        `, [siteId]);
        const hourlyDistribution = Array.from({length: 24}, (_, h) => ({ hour: h, count: 0 }));
        hourlyRows.forEach(row => {
            hourlyDistribution[row.hour] = row;
        });
        
        // Daily stats (average duration by day of week)
        const dailyStats = await conn.query(`
            SELECT 
                DAYNAME(entryTime) as day,
                AVG(durationMinutes) as avgDuration
            FROM parking_events
            WHERE siteId = ? 
            AND exitTime IS NOT NULL
            AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY DAYNAME(entryTime)
            ORDER BY FIELD(DAYNAME(entryTime), 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')
        `, [siteId]);
        
        // Recent events (last 20)
        const recentEvents = await conn.query(`
            SELECT 
                id,
                VRM,
                entryTime,
                exitTime,
                durationMinutes,
                throughTraffic,
                status,
                whitelistMatch,
                paymentMatch
            FROM parking_events
            WHERE siteId = ?
            ORDER BY entryTime DESC
            LIMIT 20
        `, [siteId]);
        
        // Monthly stats
        const monthlyRows = await conn.query(`
            SELECT 
                DATE_FORMAT(entryTime, '%Y-%m') as month,
                COUNT(*) as totalVehicles,
                SUM(throughTraffic) as throughTraffic,
                AVG(durationMinutes) as avgDuration
            FROM parking_events
            WHERE siteId = ?
            AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
            GROUP BY DATE_FORMAT(entryTime, '%Y-%m')
            ORDER BY month
        `, [siteId]);
        
        const monthlyStats = monthlyRows.map(row => ({
            month: row.month,
            totalVehicles: row.totalVehicles,
            throughTraffic: row.throughTraffic || 0,
            avgDuration: row.avgDuration || 0
        }));
        
        // Get whitelist statistics
        const [whitelistStats] = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active
            FROM whitelist
            WHERE carParkId = ?
        `, [siteId]);
        
        res.render('admin/carpark_dashboard', {
            carPark,
            whitelistStats: (whitelistStats && typeof whitelistStats.total !== 'undefined') ? whitelistStats : { total: 0, active: 0 },
            currentOccupancy,
            todayStats,
            hourlyData: hourlyDistribution || Array(24).fill(0),
            durationData: dailyStats ? dailyStats.map(d => d.avgDuration || 0) : [0,0,0,0,0],
            currentVehicles,
            recentEvents,
            monthlyStats
        });
    } catch (err) {
        logger.error('Error loading car park dashboard:', err);
        res.status(500).render('error', { message: 'Error loading car park dashboard' });
    } finally {
        if (conn) conn.release();
    }
});

// Event details API endpoint
router.get('/api/events/:id', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const [event] = await conn.query(`
            SELECT 
                e.*,
                ec.name as entryCamera,
                xc.name as exitCamera,
                ed.image1 as entryImage,
                ed.direction as entryDirection,
                ed.confidence as entryConfidence,
                ed.tag as entryTag,
                ed.tagConfidence as entryTagConfidence,
                ed.country as entryCountry,
                xd.image1 as exitImage,
                xd.direction as exitDirection,
                xd.confidence as exitConfidence,
                xd.tag as exitTag,
                xd.tagConfidence as exitTagConfidence,
                xd.country as exitCountry
            FROM parking_events e
            LEFT JOIN cameras ec ON e.entryCameraId = ec.name
            LEFT JOIN cameras xc ON e.exitCameraId = xc.name
            LEFT JOIN anpr_detections ed ON e.entryDetectionId = ed.id
            LEFT JOIN anpr_detections xd ON e.exitDetectionId = xd.id
            WHERE e.id = ?
        `, [req.params.id]);
        
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }
        
        res.json(event);
    } catch (err) {
        logger.error('Error fetching event details:', err);
        res.status(500).json({ error: 'Error fetching event details' });
    } finally {
        if (conn) conn.release();
    }
});

// Car park rules page
router.get('/rules/:id', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.params.id;
        // Get car park info
        const [carpark] = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [siteId]);
        if (!carpark) return res.status(404).render('error', { message: 'Car park not found' });
        // Get rules for this car park
        const rules = await conn.query('SELECT * FROM rules WHERE siteId = ?', [siteId]);
        res.render('admin/rules', { carpark, rules });
    } catch (err) {
        logger.error('Error loading rules page:', err);
        res.status(500).render('error', { message: 'Error loading rules page' });
    } finally {
        if (conn) conn.release();
    }
});

// Car park PCN management page
router.get('/carparks/:id/pcns', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.params.id;
        // Get car park info
        const [carpark] = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [siteId]);
        if (!carpark) return res.status(404).render('error', { message: 'Car park not found' });
        // Get PCNs for this car park
        const pcns = await conn.query('SELECT * FROM pcns WHERE siteId = ?', [siteId]);
        // Get recent parking events for this car park (last 20), with PCN count
        const recentEvents = await conn.query(`
            SELECT e.id, e.VRM as vrm, e.entryTime, e.exitTime, e.durationMinutes,
                   (SELECT COUNT(*) FROM pcns p WHERE CAST(p.eventId AS CHAR) = CAST(e.id AS CHAR)) as pcnCount
            FROM parking_events e
            WHERE e.siteId = ?
            ORDER BY e.entryTime DESC
            LIMIT 20
        `, [siteId]);
        res.render('admin/pcns', { carpark, pcns, recentEvents });
    } catch (err) {
        logger.error('Error loading PCNs page:', err);
        res.status(500).render('error', { message: 'Error loading PCNs page' });
    } finally {
        if (conn) conn.release();
    }
});

// PCN Automation Settings Admin Page
router.get('/pcn-automation', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks and their automation settings
        const carparks = await conn.query(`
            SELECT cp.siteId, cp.name, pas.isEnabled, pas.notifyEmails, pas.gracePeriodMinutes, pas.lastChecked
            FROM carparks cp
            LEFT JOIN pcn_automation_settings pas ON cp.siteId = pas.siteId
            ORDER BY cp.name
        `);
        res.render('admin/pcn_automation', { carparks });
    } catch (err) {
        logger.error('Error loading PCN automation settings:', err);
        res.status(500).render('error', { message: 'Error loading PCN automation settings' });
    } finally {
        if (conn) conn.release();
    }
});

// Update PCN automation settings for a car park
router.post('/pcn-automation/update', async (req, res) => {
    let conn;
    try {
        const { siteId, isEnabled, notifyEmails, gracePeriodMinutes } = req.body;
        conn = await pool.getConnection();
        await conn.query(`
            INSERT INTO pcn_automation_settings (siteId, isEnabled, notifyEmails, gracePeriodMinutes)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                isEnabled = VALUES(isEnabled),
                notifyEmails = VALUES(notifyEmails),
                gracePeriodMinutes = VALUES(gracePeriodMinutes)
        `, [siteId, isEnabled === 'true' || isEnabled === true, notifyEmails, gracePeriodMinutes]);
        
        // Log the automation settings update
        logger.info(`[PCN Automation] Settings updated for siteId=${siteId}: isEnabled=${isEnabled}, gracePeriodMinutes=${gracePeriodMinutes}, notifyEmails=${notifyEmails}`);
        
        res.json({ success: true });
    } catch (err) {
        logger.error('[PCN Automation] Error updating settings:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Manual housekeeping endpoint for orphaned PCNs
router.post('/housekeeping/pcns', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const result = await conn.query(`
            DELETE FROM pcns 
            WHERE eventId IS NOT NULL 
              AND eventId NOT IN (SELECT id FROM parking_events)
        `);
        
        // Log housekeeping results
        logger.info(`[PCN Housekeeping] Cleaned up ${result.affectedRows} orphaned PCNs`);
        
        res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
        logger.error('[PCN Housekeeping] Error cleaning up orphaned PCNs:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Debug endpoint to list all PCNs for a car park
router.get('/debug/pcns/:siteId', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.params.siteId;
        const pcns = await conn.query('SELECT * FROM pcns WHERE siteId = ?', [siteId]);
        res.json(pcns);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Car parks management
router.get('/carparks', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query('SELECT siteId, name, minEventDurationMinutes FROM carparks ORDER BY name');
        res.render('admin/carparks', { 
            carparks,
            selectedCarPark: null
        });
    } catch (err) {
        logger.error('Error loading car parks:', err);
        res.status(500).render('error', { message: 'Error loading car parks' });
    } finally {
        if (conn) conn.release();
    }
});

router.post('/admin/carparks/edit', async (req, res) => {
    let conn;
    try {
        const { originalSiteId, siteId, name, throughTrafficMinutes, minEventDurationMinutes } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE carparks SET siteId = ?, name = ?, throughTrafficMinutes = ?, minEventDurationMinutes = ? WHERE siteId = ?',
            [siteId, name, throughTrafficMinutes, minEventDurationMinutes, originalSiteId]
        );
        res.redirect('/admin/carparks');
    } catch (err) {
        logger.error('Error updating car park:', err);
        res.status(500).render('error', { message: 'Error updating car park' });
    } finally {
        if (conn) conn.release();
    }
});

// Admin UI to view current whitelists
router.get('/whitelists', (req, res) => {
  const whitelists = getCachedWhitelists();
  res.render('admin/whitelists', { whitelists });
});

// --- Manual PCN Issue ---
router.post('/carparks/:siteId/pcns/issue', async (req, res) => {
    let conn;
    try {
        const { siteId } = req.params;
        const { eventId, vrm, amount, dueDate, reason } = req.body;
        conn = await pool.getConnection();
        const now = new Date();
        
        // Log the PCN issue attempt
        logger.info(`[PCN Manual Issue] Attempting to issue PCN for siteId=${siteId}, eventId=${eventId}, VRM=${vrm}`, {
            amount,
            dueDate,
            reason,
            timestamp: now.toISOString()
        });
        
        // Insert PCN
        const [result] = await conn.query(
            `INSERT INTO pcns (siteId, VRM, eventId, issueTime, dueDate, amount, reason, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'issued')`,
            [siteId, vrm, eventId, now, dueDate, amount, reason]
        );
        const pcnId = result.insertId;
        
        // Log to audit table
        await conn.query(
            `INSERT INTO pcn_audit_log (pcnId, eventId, siteId, action, message) VALUES (?, ?, ?, 'issued', ?)` ,
            [pcnId, eventId, siteId, `Manual issue: VRM=${vrm}, amount=${amount}, dueDate=${dueDate}, reason=${reason}`]
        );
        
        // Log successful PCN issue
        logger.info(`[PCN Manual Issue] Successfully issued PCN #${pcnId}`, {
            siteId,
            eventId,
            vrm,
            amount,
            dueDate,
            reason,
            timestamp: now.toISOString()
        });
        
        res.redirect(`/admin/carparks/${siteId}/pcns`);
    } catch (err) {
        logger.error(`[PCN Manual Issue] Error issuing PCN: ${err.message}`, {
            error: err,
            siteId: req.params.siteId,
            eventId: req.body.eventId,
            vrm: req.body.vrm
        });
        res.status(500).render('error', { message: 'Error issuing PCN' });
    } finally {
        if (conn) conn.release();
    }
});

// --- Manual PCN Status Update ---
router.post('/carparks/:siteId/pcns/:pcnId/update-status', async (req, res) => {
    let conn;
    try {
        const { siteId, pcnId } = req.params;
        const { status } = req.body;
        conn = await pool.getConnection();
        
        // Log the status update attempt
        logger.info(`[PCN Status Update] Attempting to update PCN #${pcnId} status to ${status}`, {
            siteId,
            pcnId,
            newStatus: status,
            timestamp: new Date().toISOString()
        });
        
        // Get current PCN status before update
        const [currentPCN] = await conn.query('SELECT status FROM pcns WHERE id = ?', [pcnId]);
        const oldStatus = currentPCN ? currentPCN.status : 'unknown';
        
        // Update status
        await conn.query('UPDATE pcns SET status = ?, updatedAt = NOW() WHERE id = ?', [status, pcnId]);
        
        // Log to audit table
        await conn.query(
            `INSERT INTO pcn_audit_log (pcnId, siteId, action, message) VALUES (?, ?, ?, ?)` ,
            [pcnId, siteId, status, `Manual status update: ${oldStatus} -> ${status}`]
        );
        
        // Log successful status update
        logger.info(`[PCN Status Update] Successfully updated PCN #${pcnId} status`, {
            siteId,
            pcnId,
            oldStatus,
            newStatus: status,
            timestamp: new Date().toISOString()
        });
        
        res.redirect(`/admin/carparks/${siteId}/pcns`);
    } catch (err) {
        logger.error(`[PCN Status Update] Error updating PCN status: ${err.message}`, {
            error: err,
            siteId: req.params.siteId,
            pcnId: req.params.pcnId,
            newStatus: req.body.status
        });
        res.status(500).render('error', { message: 'Error updating PCN status' });
    } finally {
        if (conn) conn.release();
    }
});

// Update camera add endpoint to accept entryDirection and exitDirection
router.post('/admin/cameras/add', async (req, res) => {
    let conn;
    try {
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection } = req.body;
        conn = await pool.getConnection();
        // Insert new camera with direction mapping
        await conn.query(
            'INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, carParkId || null, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection]
        );
        res.redirect('/admin/cameras');
    } catch (err) {
        logger.error('Error adding camera:', err);
        res.status(500).send('Error adding camera');
    } finally {
        if (conn) conn.release();
    }
});

// Update camera edit endpoint to support entryDirection and exitDirection
router.post('/admin/cameras/edit', async (req, res) => {
    let conn;
    try {
        const { originalName, name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE cameras SET name = ?, carParkId = ?, isEntryTrigger = ?, isExitTrigger = ?, direction = ?, entryDirection = ?, exitDirection = ? WHERE name = ?',
            [name, carParkId || null, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection, originalName]
        );
        res.redirect('/admin/cameras');
    } catch (err) {
        logger.error('Error updating camera:', err);
        res.status(500).send('Error updating camera');
    } finally {
        if (conn) conn.release();
    }
});

router.post('/rules/:id/add', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.params.id;
        const { name, ruleType, maxDurationMinutes, maxDailyDurationMinutes, maxWeeklyDurationMinutes, maxMonthlyDurationMinutes } = req.body;
        await conn.query(
            'INSERT INTO rules (siteId, name, ruleType, maxDurationMinutes, maxDailyDurationMinutes, maxWeeklyDurationMinutes, maxMonthlyDurationMinutes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [siteId, name, ruleType, maxDurationMinutes || null, maxDailyDurationMinutes || null, maxWeeklyDurationMinutes || null, maxMonthlyDurationMinutes || null]
        );
        res.redirect(`/admin/rules/${siteId}`);
    } catch (err) {
        logger.error('Error adding rule:', err);
        res.status(500).render('error', { message: 'Error adding rule' });
    } finally {
        if (conn) conn.release();
    }
});

// Import Payments - GET (form)
router.get('/import-payments', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        res.render('admin/import_payments', {
            carparks,
            preview: [],
            siteId: '',
            source: 'matrix',
            fileToken: '',
            message: ''
        });
    } catch (err) {
        logger.error('Error loading car parks for import:', err);
        res.status(500).render('admin/import_payments', {
            carparks: [],
            preview: [],
            siteId: '',
            source: 'matrix',
            fileToken: '',
            message: 'Error loading car parks'
        });
    } finally {
        if (conn) conn.release();
    }
});

// Import Payments - POST (upload & preview)
router.post('/import-payments', upload.single('file'), async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const { siteId, source } = req.body;
        const file = req.file;
        
        console.log('File upload request:', {
            siteId, 
            source, 
            originalname: file?.originalname,
            filename: file?.filename,
            path: file?.path
        });

        if (!file) {
            console.log('No file uploaded');
            return res.render('admin/import_payments', { 
                carparks, 
                preview: [],
                siteId: '',
                source: '',
                fileToken: '',
                message: 'No file uploaded' 
            });
        }

        let rows = [];
        const fileExt = path.extname(file.originalname).toLowerCase();
        console.log('Processing file with extension:', fileExt);

        if (fileExt === '.xlsx') {
            console.log('Processing Excel file');
            const wb = xlsx.readFile(file.path);
            const ws = wb.Sheets[wb.SheetNames[0]];
            // Get headers from row 10 (0-based index 9)
            const headerRow = xlsx.utils.sheet_to_json(ws, { header: 1, range: 9 })[0];
            // Read data starting from row 11 (0-based index 10)
            const range = xlsx.utils.decode_range(ws['!ref']);
            range.s.r = 10; // Start from row 11
            ws['!ref'] = xlsx.utils.encode_range(range);
            rows = xlsx.utils.sheet_to_json(ws, { header: headerRow, defval: '' });
        } else if (fileExt === '.csv') {
            console.log('Processing CSV file');
            const content = fs.readFileSync(file.path, 'utf8');
            const lines = content.split('\n');
            // Get headers from line 10 (0-based index 9)
            const headerLine = lines[9];
            // Get data starting from line 11 (0-based index 10)
            const dataLines = lines.slice(10);
            rows = csvParse.parse(dataLines.join('\n'), { 
                columns: headerLine.split(',').map(h => h.trim()),
                skip_empty_lines: true 
            });
        } else {
            console.log('Unsupported file type:', { originalname: file.originalname, fileExt });
            return res.render('admin/import_payments', { 
                carparks, 
                preview: [],
                siteId: '',
                source: '',
                fileToken: '',
                message: 'Unsupported file type' 
            });
        }

        // Function to parse date string to MySQL datetime format
        const parseDateTime = (dateStr) => {
            if (!dateStr) return null;
            try {
                // Try parsing as Excel date (number of days since 1900-01-01)
                if (!isNaN(dateStr)) {
                    const date = new Date((dateStr - 25569) * 86400 * 1000);
                    return date.toISOString().slice(0, 19).replace('T', ' ');
                }
                // Try parsing as standard date string
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    return date.toISOString().slice(0, 19).replace('T', ' ');
                }
                return null;
            } catch (err) {
                return null;
            }
        };

        // Map columns by header and parse dates
        const preview = rows.slice(0, 10).map(row => {
            const paymentStart = parseDateTime(row['Start Date Time'] || row['Start'] || '');
            const paymentEnd = parseDateTime(row['End Date Time'] || row['End'] || '');
            return {
                VRM: row['Registration Number'] || row['VRM'] || row['registration'] || '',
                paymentStart: paymentStart || '',
                paymentEnd: paymentEnd || '',
                transactionSerial: row['Transaction Serial Number'] || row['Serial'] || ''
            };
        });

        // Save temp file for confirm step
        const fileToken = file.filename;
        console.log('File processed successfully:', {
            fileToken,
            previewRows: preview.length,
            totalRows: rows.length,
            filePath: file.path
        });

        res.render('admin/import_payments', {
            carparks,
            preview,
            siteId,
            source,
            fileToken,
            message: ''
        });
    } catch (err) {
        console.error('Error parsing payment file:', err);
        res.status(500).render('admin/import_payments', { 
            carparks: [], 
            preview: [],
            siteId: '',
            source: '',
            fileToken: '',
            message: 'Error parsing file' 
        });
    }
});

// Import Payments - POST (confirm import)
router.post('/import-payments/confirm', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carparks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const { siteId, source, fileToken } = req.body;
        
        console.log('Confirm import request:', {
            siteId, 
            source, 
            fileToken,
            body: req.body 
        });
        
        if (!fileToken) {
            console.log('No file token provided');
            return res.render('admin/import_payments', { 
                carparks, 
                preview: [],
                siteId: '',
                source: '',
                fileToken: '',
                message: 'No file token provided. Please re-upload.' 
            });
        }

        const tempPath = path.join(__dirname, '../tmp', fileToken);
        console.log('Temp file path:', {
            tempPath, 
            exists: fs.existsSync(tempPath),
            dirContents: fs.readdirSync(path.join(__dirname, '../tmp'))
        });
        
        if (!fs.existsSync(tempPath)) {
            console.log('Temp file not found:', { tempPath });
            return res.render('admin/import_payments', { 
                carparks, 
                preview: [],
                siteId: '',
                source: '',
                fileToken: '',
                message: 'Temp file not found. Please re-upload.' 
            });
        }

        let rows = [];
        const fileExt = path.extname(fileToken).toLowerCase();
        console.log('File extension:', { fileExt, fileToken });
        
        if (fileExt === '.xlsx') {
            console.log('Processing Excel file');
            const wb = xlsx.readFile(tempPath);
            const ws = wb.Sheets[wb.SheetNames[0]];
            // Get headers from row 10 (0-based index 9)
            const headerRow = xlsx.utils.sheet_to_json(ws, { header: 1, range: 9 })[0];
            // Read data starting from row 11 (0-based index 10)
            const range = xlsx.utils.decode_range(ws['!ref']);
            range.s.r = 10; // Start from row 11
            ws['!ref'] = xlsx.utils.encode_range(range);
            rows = xlsx.utils.sheet_to_json(ws, { header: headerRow, defval: '' });
        } else if (fileExt === '.csv') {
            console.log('Processing CSV file');
            const content = fs.readFileSync(tempPath, 'utf8');
            const lines = content.split('\n');
            // Get headers from line 10 (0-based index 9)
            const headerLine = lines[9];
            // Get data starting from line 11 (0-based index 10)
            const dataLines = lines.slice(10);
            rows = csvParse.parse(dataLines.join('\n'), { 
                columns: headerLine.split(',').map(h => h.trim()),
                skip_empty_lines: true 
            });
        } else {
            console.log('Unsupported file type:', { fileExt, fileToken });
            return res.render('admin/import_payments', { 
                carparks, 
                preview: [],
                siteId: '',
                source: '',
                fileToken: '',
                message: `Unsupported file type: ${fileExt}` 
            });
        }

        // Function to parse date string to MySQL datetime format
        const parseDateTime = (dateStr) => {
            if (!dateStr) return null;
            try {
                // Try parsing as Excel date (number of days since 1900-01-01)
                if (!isNaN(dateStr)) {
                    const date = new Date((dateStr - 25569) * 86400 * 1000);
                    return date.toISOString().slice(0, 19).replace('T', ' ');
                }
                // Try parsing as standard date string
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    return date.toISOString().slice(0, 19).replace('T', ' ');
                }
                return null;
            } catch (err) {
                return null;
            }
        };

        let imported = 0;
        for (const row of rows) {
            const vrm = row['Registration Number'] || row['VRM'] || row['registration'] || '';
            const paymentStart = parseDateTime(row['Start Date Time'] || row['Start'] || '');
            const paymentEnd = parseDateTime(row['End Date Time'] || row['End'] || '');
            const transactionSerial = row['Transaction Serial Number'] || row['Serial'] || '';
            
            if (!vrm || !paymentStart || !paymentEnd) {
                console.log(`Skipping row due to missing required data: VRM=${vrm}, Start=${paymentStart}, End=${paymentEnd}`);
                continue;
            }

            await conn.query(
                'INSERT INTO payments (siteId, vrm, paymentStart, paymentEnd, source, transactionSerial) VALUES (?, ?, ?, ?, ?, ?)',
                [siteId, vrm, paymentStart, paymentEnd, source || 'matrix', transactionSerial]
            );
            imported++;
        }
        fs.unlinkSync(tempPath);
        console.log('Import completed successfully:', { imported });
        res.render('admin/import_payments', { 
            carparks, 
            preview: [],
            siteId: '',
            source: '',
            fileToken: '',
            message: `Imported ${imported} payments successfully.` 
        });
    } catch (err) {
        console.error('Error importing payments:', err);
        res.status(500).render('admin/import_payments', { 
            carparks: [], 
            preview: [],
            siteId: '',
            source: '',
            fileToken: '',
            message: 'Error importing payments' 
        });
    }
});

// Unknown events breakdown page
router.get('/unknown-events', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all car parks
        const carParks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        // Get all cameras
        const cameras = await conn.query('SELECT name, carParkId FROM cameras ORDER BY carParkId, name');
        // Get unknown detections count per site, per camera, per day (last 30 days)
        const unknownEvents = await conn.query(`
            SELECT 
                c.carParkId as siteId,
                c.name as cameraName,
                d.cameraId,
                DATE(d.timestamp) as day,
                COUNT(*) as count
            FROM anpr_detections d
            LEFT JOIN cameras c ON d.cameraId = c.name
            WHERE (
                d.direction IS NULL OR d.direction = '' OR d.direction = 'unknown'
                OR d.vrm IS NULL OR d.vrm = '' OR d.vrm = 'unknown'
            )
            AND d.timestamp >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY c.carParkId, d.cameraId, day
            ORDER BY day DESC, c.carParkId, c.name
        `);
        // Preprocess for linter-friendly EJS
        const siteMap = Object.fromEntries(carParks.map(cp => [String(cp.siteId), cp.name]));
        const cameraMap = Object.fromEntries(cameras.map(cam => [String(cam.name), cam.name]));
        const unknownEventsDisplay = unknownEvents.map(ev => ({
            day: ev.day,
            siteName: siteMap[String(ev.siteId)] || ev.siteId,
            cameraName: ev.cameraName || cameraMap[String(ev.cameraId)] || ev.cameraId || '-',
            count: ev.count
        }));
        // Group unknown events by camera for bar chart
        const unknownEventsByCamera = await conn.query(`
            SELECT 
                c.name as cameraName,
                c.carParkId as siteId,
                COUNT(*) as total
            FROM anpr_detections d
            LEFT JOIN cameras c ON d.cameraId = c.name
            WHERE (
                d.direction IS NULL OR d.direction = '' OR d.direction = 'unknown'
                OR d.vrm IS NULL OR d.vrm = '' OR d.vrm = 'unknown'
            )
            AND d.timestamp >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            GROUP BY c.name, c.carParkId
            ORDER BY total DESC, c.carParkId, c.name
        `);
        // Group unknown events by camera for last 24 hours for bar chart
        const unknownEventsByCamera24h = await conn.query(`
            SELECT 
                c.name as cameraName,
                c.carParkId as siteId,
                COUNT(*) as total
            FROM anpr_detections d
            LEFT JOIN cameras c ON d.cameraId = c.name
            WHERE (
                d.direction IS NULL OR d.direction = '' OR d.direction = 'unknown'
                OR d.vrm IS NULL OR d.vrm = '' OR d.vrm = 'unknown'
            )
            AND d.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY c.name, c.carParkId
            ORDER BY total DESC, c.carParkId, c.name
        `);
        res.render('admin/unknown_events', {
            carParks,
            cameras,
            unknownEvents,
            unknownEventsDisplay,
            unknownEventsByCamera,
            unknownEventsByCamera24h
        });
    } catch (err) {
        logger.error('Error loading unknown events breakdown:', err);
        res.status(500).render('error', { message: 'Error loading unknown events breakdown' });
    } finally {
        if (conn) conn.release();
    }
});

// Manage Payments page
router.get('/manage-payments', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const carParks = await conn.query('SELECT siteId, name FROM carparks ORDER BY name');
        const payments = await conn.query('SELECT * FROM payments ORDER BY paymentStart DESC LIMIT 500');
        res.render('admin/manage_payments', {
            carParks,
            payments
        });
    } catch (err) {
        logger.error('Error loading manage payments page:', err);
        res.status(500).render('error', { message: 'Error loading manage payments page' });
    } finally {
        if (conn) conn.release();
    }
});

// Update payment
router.put('/api/payments/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { siteId, vrm, paymentStart, paymentEnd, source, transactionSerial } = req.body;
        conn = await pool.getConnection();
        
        await conn.query(
            'UPDATE payments SET siteId = ?, vrm = ?, paymentStart = ?, paymentEnd = ?, source = ?, transactionSerial = ? WHERE id = ?',
            [siteId, vrm, paymentStart, paymentEnd, source, transactionSerial, id]
        );
        
        res.json({ success: true });
    } catch (err) {
        logger.error('Error updating payment:', err);
        res.status(500).json({ error: 'Error updating payment' });
    } finally {
        if (conn) conn.release();
    }
});

// Delete payments
router.delete('/api/payments', async (req, res) => {
    let conn;
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No payment IDs provided' });
        }
        
        conn = await pool.getConnection();
        await conn.query('DELETE FROM payments WHERE id IN (?)', [ids]);
        
        res.json({ success: true, deleted: ids.length });
    } catch (err) {
        logger.error('Error deleting payments:', err);
        res.status(500).json({ error: 'Error deleting payments' });
    } finally {
        if (conn) conn.release();
    }
});

// Bulk reassign payments
router.put('/api/payments/reassign', async (req, res) => {
    let conn;
    try {
        const { ids, newSiteId } = req.body;
        if (!Array.isArray(ids) || ids.length === 0 || !newSiteId) {
            return res.status(400).json({ error: 'Invalid request parameters' });
        }
        
        conn = await pool.getConnection();
        await conn.query('UPDATE payments SET siteId = ? WHERE id IN (?)', [newSiteId, ids]);
        
        res.json({ success: true, reassigned: ids.length });
    } catch (err) {
        logger.error('Error reassigning payments:', err);
        res.status(500).json({ error: 'Error reassigning payments' });
    } finally {
        if (conn) conn.release();
    }
});

// PCN Management Page
router.get('/pcns', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all PCNs with car park and event info
        const pcns = await conn.query(`
            SELECT p.*, cp.name as carparkName, e.entryTime, e.exitTime
            FROM pcns p
            LEFT JOIN carparks cp ON p.siteId = cp.siteId
            LEFT JOIN parking_events e ON p.eventId = e.id
            ORDER BY p.issueTime DESC
        `);
        res.render('admin/pcns_manage', { pcns });
    } catch (err) {
        logger.error('Error loading PCN management page:', err);
        res.status(500).render('error', { message: 'Error loading PCN management page' });
    } finally {
        if (conn) conn.release();
    }
});

// --- PCN Status API Endpoints ---
router.post('/api/pcns/:id/confirm', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const { id } = req.params;
        await conn.query('UPDATE pcns SET status = ?, updatedAt = NOW() WHERE id = ?', ['active', id]);
        res.json({ success: true, status: 'active' });
    } catch (err) {
        logger.error('Error confirming PCN:', err);
        res.status(500).json({ error: 'Error confirming PCN' });
    } finally {
        if (conn) conn.release();
    }
});
router.post('/api/pcns/:id/cancel', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const { id } = req.params;
        await conn.query('UPDATE pcns SET status = ?, updatedAt = NOW() WHERE id = ?', ['cancelled', id]);
        res.json({ success: true, status: 'cancelled' });
    } catch (err) {
        logger.error('Error cancelling PCN:', err);
        res.status(500).json({ error: 'Error cancelling PCN' });
    } finally {
        if (conn) conn.release();
    }
});
router.post('/api/pcns/:id/paid', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const { id } = req.params;
        await conn.query('UPDATE pcns SET status = ?, updatedAt = NOW() WHERE id = ?', ['paid', id]);
        res.json({ success: true, status: 'paid' });
    } catch (err) {
        logger.error('Error marking PCN as paid:', err);
        res.status(500).json({ error: 'Error marking PCN as paid' });
    } finally {
        if (conn) conn.release();
    }
});

return router;
} 
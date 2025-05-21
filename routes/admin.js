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
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction, admin_url } = req.body;
        conn = await pool.getConnection();
        const result = await conn.query(
            'INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction, admin_url) VALUES (?, ?, ?, ?, ?, ?)',
            [name, carParkId, isEntryTrigger, isExitTrigger, direction, admin_url]
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
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction, admin_url } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE cameras SET name = ?, carParkId = ?, isEntryTrigger = ?, isExitTrigger = ?, direction = ?, admin_url = ? WHERE id = ?',
            [name, carParkId, isEntryTrigger, isExitTrigger, direction, admin_url, id]
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
        await conn.query('DELETE FROM cameras WHERE name = ?', [id]);
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
        
        // Today's stats (detailed breakdown)
        const [todayStats] = await conn.query(`
            SELECT 
                COUNT(*) as totalEvents,
                SUM(CASE WHEN exitTime IS NULL AND throughTraffic = 0 THEN 1 ELSE 0 END) as currentlyParked,
                SUM(CASE WHEN throughTraffic = 1 THEN 1 ELSE 0 END) as throughTraffic,
                SUM(CASE WHEN exitTime IS NOT NULL AND throughTraffic = 0 THEN 1 ELSE 0 END) as completedEvents,
                SUM(CASE WHEN status = 'whitelisted' THEN 1 ELSE 0 END) as whitelisted,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
                SUM(CASE WHEN status = 'overstay' THEN 1 ELSE 0 END) as overstay,
                SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) as unpaid,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
            FROM parking_events
            WHERE siteId = ?
              AND entryTime >= CURDATE()
              AND entryTime < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        `, [siteId]);
        
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
                status
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
        const { originalSiteId, siteId, name, throughTrafficMinutes, minEventDurationMinutes, carParkType } = req.body;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE carparks SET siteId = ?, name = ?, throughTrafficMinutes = ?, minEventDurationMinutes = ?, carParkType = ? WHERE siteId = ?',
            [siteId, name, throughTrafficMinutes, minEventDurationMinutes, carParkType, originalSiteId]
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

        // Validate VRM
        if (!isValidVRM(vrm)) {
            logger.error(`[PCN Manual Issue] Invalid VRM format: ${vrm}`);
            return res.status(400).json({ error: 'Invalid VRM format' });
        }

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
        const defaultReason = reason || (vrm ? 'Without a valid permit or authority' : 'Without valid pay & display ticket');
        const [result] = await conn.query(
            `INSERT INTO pcns (siteId, eventId, ruleId, VRM, issueTime, issueDate, dueDate, amount, reason, status, notes) 
             VALUES (?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL 14 DAY), 150.00, ?, 'possible', ?)`,
            [siteId, eventId, null, vrm, defaultReason, reason]
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
        logger.error('Error issuing PCN:', err);
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

// Update camera add endpoint to accept entryDirection, exitDirection, admin_url, admin_username, admin_password
router.post('/admin/cameras/add', async (req, res) => {
    let conn;
    try {
        // Accept both JSON and form data
        const body = req.body || {};
        const name = body.name;
        const carParkId = body.carParkId;
        const isEntryTrigger = body.isEntryTrigger;
        const isExitTrigger = body.isExitTrigger;
        const direction = body.direction;
        const entryDirection = body.entryDirection;
        const exitDirection = body.exitDirection;
        const admin_url = body.admin_url;
        const admin_username = body.admin_username;
        const admin_password = body.admin_password;
        conn = await pool.getConnection();
        await conn.query(
            'INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection, admin_url, admin_username, admin_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, carParkId || null, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection, admin_url, admin_username, admin_password]
        );
        res.redirect('/admin/cameras');
    } catch (err) {
        logger.error('Error adding camera:', err);
        res.status(500).send('Error adding camera');
    } finally {
        if (conn) conn.release();
    }
});

// Update camera edit endpoint to support entryDirection, exitDirection, admin_url, admin_username, admin_password
router.post('/admin/cameras/edit', async (req, res) => {
    let conn;
    try {
        // Accept both JSON and form data
        const body = req.body || {};
        const originalName = body.originalName;
        const name = body.name;
        const carParkId = body.carParkId;
        const isEntryTrigger = body.isEntryTrigger;
        const isExitTrigger = body.isExitTrigger;
        const direction = body.direction;
        const entryDirection = body.entryDirection;
        const exitDirection = body.exitDirection;
        const admin_url = body.admin_url;
        const admin_username = body.admin_username;
        const admin_password = body.admin_password;
        conn = await pool.getConnection();
        await conn.query(
            'UPDATE cameras SET name = ?, carParkId = ?, isEntryTrigger = ?, isExitTrigger = ?, direction = ?, entryDirection = ?, exitDirection = ?, admin_url = ?, admin_username = ?, admin_password = ? WHERE name = ?',
            [name, carParkId || null, isEntryTrigger, isExitTrigger, direction, entryDirection, exitDirection, admin_url, admin_username, admin_password, originalName]
        );
        res.redirect('/admin/cameras');
    } catch (err) {
        logger.error('Error updating camera:', err);
        res.status(500).send('Error updating camera');
    } finally {
        if (conn) conn.release();
    }
});

// Update car park type
router.post('/rules/:id/update-type', async (req, res) => {
    let conn;
    try {
        const { siteId, carParkType } = req.body;
        conn = await pool.getConnection();
        await conn.query('UPDATE carparks SET carParkType = ? WHERE siteId = ?', [carParkType, siteId]);
        res.redirect(`/admin/rules/${siteId}`);
    } catch (err) {
        logger.error('Error updating car park type:', err);
        res.status(500).render('error', { message: 'Error updating car park type' });
    } finally {
        if (conn) conn.release();
    }
});

// Add rule with new fields
router.post('/rules/:id/add', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const siteId = req.params.id;
        const {
            name,
            ruleType,
            description,
            maxDurationMinutes,
            maxDailyDurationMinutes,
            maxWeeklyDurationMinutes,
            maxMonthlyDurationMinutes,
            freePeriodMinutes,
            requiresRegistration,
            requiresPayment,
            gracePeriodMinutes,
            priority,
            activeDays,
            activeStartTime,
            activeEndTime,
            notes
        } = req.body;

        await conn.query(
            `INSERT INTO rules (
                siteId, name, ruleType, description,
                maxDurationMinutes, maxDailyDurationMinutes, maxWeeklyDurationMinutes, maxMonthlyDurationMinutes,
                freePeriodMinutes, requiresRegistration, requiresPayment, gracePeriodMinutes,
                priority, activeDays, activeStartTime, activeEndTime, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                siteId, name, ruleType, description,
                maxDurationMinutes || null,
                maxDailyDurationMinutes || null,
                maxWeeklyDurationMinutes || null,
                maxMonthlyDurationMinutes || null,
                freePeriodMinutes || null,
                requiresRegistration === 'on' || requiresRegistration === true,
                requiresPayment === 'on' || requiresPayment === true,
                gracePeriodMinutes || 0,
                priority || 0,
                activeDays || 'All',
                activeStartTime || null,
                activeEndTime || null,
                notes || null
            ]
        );
        res.redirect(`/admin/rules/${siteId}`);
    } catch (err) {
        logger.error('Error adding rule:', err);
        res.status(500).render('error', { message: 'Error adding rule' });
    } finally {
        if (conn) conn.release();
    }
});

// Edit rule endpoint
router.post('/rules/edit', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const {
            ruleId,
            name,
            ruleType,
            description,
            maxDurationMinutes,
            maxDailyDurationMinutes,
            maxWeeklyDurationMinutes,
            maxMonthlyDurationMinutes,
            freePeriodMinutes,
            requiresRegistration,
            requiresPayment,
            gracePeriodMinutes,
            priority,
            activeDays,
            activeStartTime,
            activeEndTime,
            notes,
            contraventionDetails
        } = req.body;

        // Get siteId for redirect
        const [rule] = await conn.query('SELECT siteId FROM rules WHERE id = ?', [ruleId]);
        const siteId = rule ? rule.siteId : '';

        await conn.query(
            `UPDATE rules SET
                name = ?,
                ruleType = ?,
                description = ?,
                maxDurationMinutes = ?,
                maxDailyDurationMinutes = ?,
                maxWeeklyDurationMinutes = ?,
                maxMonthlyDurationMinutes = ?,
                freePeriodMinutes = ?,
                requiresRegistration = ?,
                requiresPayment = ?,
                gracePeriodMinutes = ?,
                priority = ?,
                activeDays = ?,
                activeStartTime = ?,
                activeEndTime = ?,
                notes = ?,
                contraventionDetails = ?
            WHERE id = ?`,
            [
                name,
                ruleType,
                description,
                maxDurationMinutes || null,
                maxDailyDurationMinutes || null,
                maxWeeklyDurationMinutes || null,
                maxMonthlyDurationMinutes || null,
                freePeriodMinutes || null,
                requiresRegistration === 'on' || requiresRegistration === true,
                requiresPayment === 'on' || requiresPayment === true,
                gracePeriodMinutes || 0,
                priority || 0,
                activeDays || 'All',
                activeStartTime || null,
                activeEndTime || null,
                notes || null,
                contraventionDetails || null,
                ruleId
            ]
        );
        res.redirect(`/admin/rules/${siteId}`);
    } catch (err) {
        logger.error('Error editing rule:', err);
        res.status(500).render('error', { message: 'Error editing rule' });
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

// PCN Review Page
router.get('/pcns/review', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get all PCNs in 'possible' status with their evidence
        const pcns = await conn.query(`
            SELECT p.*, cp.name as carparkName, e.entryTime, e.exitTime
            FROM pcns p
            LEFT JOIN carparks cp ON p.siteId = cp.siteId
            LEFT JOIN parking_events e ON p.eventId = e.id
            WHERE p.status = 'possible'
            ORDER BY p.issueTime DESC
        `);

        // For each PCN, get related events and PCN history
        for (const pcn of pcns) {
            // Get other events for this VRM at this car park
            const [relatedEvents] = await conn.query(`
                SELECT e.*, cp.name as carparkName
                FROM parking_events e
                LEFT JOIN carparks cp ON e.siteId = cp.siteId
                WHERE e.VRM = ? AND e.siteId = ? AND e.id != ?
                ORDER BY e.entryTime DESC
                LIMIT 5
            `, [pcn.VRM, pcn.siteId, pcn.eventId]);

            // Get PCN history for this VRM
            const [pcnHistory] = await conn.query(`
                SELECT p.*, cp.name as carparkName
                FROM pcns p
                LEFT JOIN carparks cp ON p.siteId = cp.siteId
                WHERE p.VRM = ? AND p.id != ?
                ORDER BY p.issueTime DESC
                LIMIT 5
            `, [pcn.VRM, pcn.id]);

            // Add the related data to the PCN object
            pcn.relatedEvents = relatedEvents || [];
            pcn.pcnHistory = pcnHistory || [];
        }

        res.render('admin/pcn_review', { pcns });
    } catch (err) {
        logger.error('Error loading PCN review page:', err);
        res.status(500).render('error', { message: 'Error loading PCN review page' });
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
        // Generate a unique 6-8 digit reference number (not sequential, not DB id)
        let reference;
        let isUnique = false;
        while (!isUnique) {
            reference = Math.floor(100000 + Math.random() * 90000000).toString(); // 6-8 digits
            const [existing] = await conn.query('SELECT id FROM pcns WHERE reference = ?', [reference]);
            if (!existing) isUnique = true;
        }
        await conn.query('UPDATE pcns SET status = ?, updatedAt = NOW(), reference = ? WHERE id = ?', ['active', reference, id]);
        res.json({ success: true, status: 'active', reference });
    } catch (err) {
        logger.error('Error confirming PCN:', err);
        res.status(500).json({ error: 'Error confirming PCN' });
    } finally {
        if (conn) conn.release();
    }
});

// Add endpoint for adding notes to a PCN
router.post('/api/pcns/:id/notes', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const { id } = req.params;
        const { notes } = req.body;
        await conn.query('UPDATE pcns SET notes = ?, updatedAt = NOW() WHERE id = ?', [notes, id]);
        res.json({ success: true });
    } catch (err) {
        logger.error('Error updating PCN notes:', err);
        res.status(500).json({ error: 'Error updating PCN notes' });
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

// Generate possible PCNs for a car park
router.post('/rules/:id/generate-pcns', async (req, res) => {
    let conn;
    try {
        const siteId = req.params.id;
        conn = await pool.getConnection();
        
        // Get car park type and rules
        const [carpark] = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [siteId]);
        const rules = await conn.query('SELECT * FROM rules WHERE siteId = ? AND isActive = true', [siteId]);
        
        if (!rules.length) {
            return res.json({ success: false, error: 'No active rules found for this car park' });
        }
        
        // Get all completed events not already linked to a PCN
        const events = await conn.query(
            `SELECT e.* FROM parking_events e
            LEFT JOIN pcns p ON e.id = p.eventId
            WHERE e.siteId = ? AND e.exitTime IS NOT NULL AND p.id IS NULL`,
            [siteId]
        );
        
        let pcnsGenerated = 0;
        
        // Process each event
        for (const event of events) {
            if (carpark.carParkType === 'private') {
                // For private car parks, whitelist is primary
                const whitelistRule = rules.find(r => r.ruleType === 'whitelist');
                if (whitelistRule) {
                    const [whitelisted] = await conn.query(
                        'SELECT * FROM whitelist WHERE carParkId = ? AND VRM = ? AND active = true',
                        [siteId, event.VRM]
                    );
                    if (!whitelisted) {
                        // Not whitelisted - issue PCN after grace period
                        const graceEnd = new Date(event.entryTime.getTime() + (whitelistRule.gracePeriodMinutes || 0) * 60000);
                        if (event.exitTime > graceEnd) {
                            await createPCN(conn, {
                                siteId,
                                eventId: event.id,
                                ruleId: whitelistRule.id,
                                VRM: event.VRM,
                                reason: `Vehicle not on whitelist for ${carpark.name}`
                            });
                            pcnsGenerated++;
                            continue;
                        }
                    }
                }
            } else {
                // For public car parks, check all applicable rules
                for (const rule of rules) {
                    let shouldIssuePCN = false;
                    let reason = '';
                    
                    switch (rule.ruleType) {
                        case 'time_limit':
                            if (rule.maxDurationMinutes && event.durationMinutes > rule.maxDurationMinutes) {
                                shouldIssuePCN = true;
                                reason = `Exceeded maximum stay of ${rule.maxDurationMinutes} minutes`;
                            }
                            break;
                            
                        case 'payment':
                            if (rule.requiresPayment) {
                                const [payment] = await conn.query(
                                    'SELECT * FROM payments WHERE eventId = ?',
                                    [event.id]
                                );
                                if (!payment) {
                                    shouldIssuePCN = true;
                                    reason = 'Payment required but not made';
                                }
                            }
                            break;
                            
                        case 'registration':
                            if (rule.requiresRegistration) {
                                const [registration] = await conn.query(
                                    'SELECT * FROM registrations WHERE eventId = ?',
                                    [event.id]
                                );
                                if (!registration) {
                                    shouldIssuePCN = true;
                                    reason = 'Registration required but not completed';
                                }
                            }
                            break;
                            
                        case 'free_period':
                            if (rule.freePeriodMinutes && event.durationMinutes > rule.freePeriodMinutes) {
                                if (rule.requiresPayment) {
                                    const [payment] = await conn.query(
                                        'SELECT * FROM payments WHERE eventId = ?',
                                        [event.id]
                                    );
                                    if (!payment) {
                                        shouldIssuePCN = true;
                                        reason = `Exceeded free period of ${rule.freePeriodMinutes} minutes without payment`;
                                    }
                                }
                            }
                            break;
                    }
                    
                    if (shouldIssuePCN) {
                        const graceEnd = new Date(event.entryTime.getTime() + (rule.gracePeriodMinutes || 0) * 60000);
                        if (event.exitTime > graceEnd) {
                            await createPCN(conn, {
                                siteId,
                                eventId: event.id,
                                ruleId: rule.id,
                                VRM: event.VRM,
                                reason
                            });
                            pcnsGenerated++;
                        }
                    }
                }
            }
        }
        
        res.json({
            success: true,
            eventsChecked: events.length,
            pcnsGenerated
        });
    } catch (err) {
        logger.error('Error generating PCNs:', err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

// Helper function to validate VRM
function isValidVRM(vrm) {
    if (!vrm || vrm === 'UNKNOWN' || vrm.toUpperCase() === 'UNKNOWN') return false;
    return /^[A-Z0-9]{2,7}$/.test(vrm);
}

// Helper function to create a PCN
async function createPCN(conn, { siteId, eventId, ruleId, VRM, reason }) {
    try {
        // Validate VRM
        if (!isValidVRM(VRM)) {
            logger.info(`[PCN Generation] Skipping PCN generation for invalid VRM: ${VRM}`);
            return;
        }

        // Get the rule details
        const ruleResult = await conn.query('SELECT * FROM rules WHERE id = ?', [ruleId]);
        logger.info('[PCN Generation] Rule query result:', { ruleResult });
        
        // Handle the rule result
        const rule = Array.isArray(ruleResult) ? ruleResult[0] : null;
        logger.info('[PCN Generation] Extracted rule:', { rule });
        
        // Get all event details including images
        const [eventDetails] = await conn.query(`
            SELECT 
                e.*,
                ed.image1 as entryImage,
                ed.image2 as entryImage2,
                ed.direction as entryDirection,
                ed.confidence as entryConfidence,
                ed.tag as entryTag,
                ed.tagConfidence as entryTagConfidence,
                ed.country as entryCountry,
                xd.image1 as exitImage,
                xd.image2 as exitImage2,
                xd.direction as exitDirection,
                xd.confidence as exitConfidence,
                xd.tag as exitTag,
                xd.tagConfidence as exitTagConfidence,
                xd.country as exitCountry,
                ec.name as entryCamera,
                xc.name as exitCamera
            FROM parking_events e
            LEFT JOIN anpr_detections ed ON e.entryDetectionId = ed.id
            LEFT JOIN anpr_detections xd ON e.exitDetectionId = xd.id
            LEFT JOIN cameras ec ON e.entryCameraId = ec.name
            LEFT JOIN cameras xc ON e.exitCameraId = xc.name
            WHERE e.id = ?
        `, [eventId]);
        
        if (!eventDetails) {
            throw new Error('Event not found');
        }
        
        // Set default values
        const defaultAmount = rule?.pcnAmount || 150.00;
        const defaultReason = rule?.contraventionDetails || 
            (rule?.ruleType === 'whitelist' ? 'Without a valid permit or authority' : 'Without valid pay & display ticket');
        
        // Create evidence JSON (streamlined version with essential data only)
        const evidence = {
            times: {
                entry: eventDetails.entryTime,
                exit: eventDetails.exitTime,
                duration: eventDetails.durationMinutes
            },
            detections: {
                entry: {
                    id: eventDetails.entryDetectionId,
                    direction: eventDetails.entryDirection,
                    confidence: eventDetails.entryConfidence,
                    camera: eventDetails.entryCamera,
                    images: [
                        `/image/${eventDetails.entryDetectionId}/1`,
                        `/image/${eventDetails.entryDetectionId}/2`
                    ].filter(Boolean)
                },
                exit: eventDetails.exitDetectionId ? {
                    id: eventDetails.exitDetectionId,
                    direction: eventDetails.exitDirection,
                    confidence: eventDetails.exitConfidence,
                    camera: eventDetails.exitCamera,
                    images: [
                        `/image/${eventDetails.exitDetectionId}/1`,
                        `/image/${eventDetails.exitDetectionId}/2`
                    ].filter(Boolean)
                } : null
            },
            rule: {
                type: rule?.ruleType,
                name: rule?.name,
                maxDuration: rule?.maxDurationMinutes,
                gracePeriod: rule?.gracePeriodMinutes
            }
        };
        
        // Convert dates to ISO strings for consistent storage
        if (evidence.times.entry instanceof Date) {
            evidence.times.entry = evidence.times.entry.toISOString();
        }
        if (evidence.times.exit instanceof Date) {
            evidence.times.exit = evidence.times.exit.toISOString();
        }
        
        // Ensure status is a valid value and properly formatted
        const status = 'issued'; // Use valid ENUM value
        // Validate status value
        if (!['issued', 'paid', 'cancelled', 'appealed'].includes(status)) {
            throw new Error(`Invalid status value: ${status}`);
        }
        // Debug log the values being inserted
        logger.info('[PCN Generation] Attempting to insert PCN with values:', {
            siteId,
            eventId,
            ruleId,
            VRM,
            defaultAmount,
            defaultReason,
            status,
            reason,
            evidenceSize: JSON.stringify(evidence).length
        });
        try {
            // First, let's verify the table structure
            const [tableInfo] = await conn.query('DESCRIBE pcns');
            logger.info('[PCN Generation] Table structure:', tableInfo);
            // Create the PCN with explicit column names and values
            const insertResult = await conn.query(
                `INSERT INTO pcns (
                    siteId, 
                    eventId, 
                    ruleId, 
                    VRM, 
                    issueTime, 
                    issueDate, 
                    dueDate, 
                    amount, 
                    reason, 
                    status, 
                    notes, 
                    evidence
                ) VALUES (
                    ?, 
                    ?, 
                    ?, 
                    ?, 
                    NOW(), 
                    CURDATE(), 
                    DATE_ADD(CURDATE(), INTERVAL 14 DAY), 
                    ?, 
                    ?, 
                    'issued', 
                    ?, 
                    ?
                )`,
                [
                    siteId, 
                    eventId, 
                    ruleId, 
                    VRM, 
                    defaultAmount, 
                    defaultReason, 
                    reason,
                    JSON.stringify(evidence)
                ]
            );
            logger.info('[PCN Generation] Insert result:', { insertResult });
            const pcnId = insertResult.insertId;
            // Log the PCN creation
            await conn.query(
                'INSERT INTO pcn_audit_log (pcnId, eventId, ruleId, siteId, action, message) VALUES (?, ?, ?, ?, ?, ?)',
                [pcnId, eventId, ruleId, siteId, 'created', reason]
            );
            logger.info(`[PCN Generation] Created PCN ${pcnId} for ${VRM} at ${siteId}: ${reason}`);
        } catch (err) {
            logger.error('[PCN Generation] Error details:', {
                error: err,
                sqlState: err.sqlState,
                errno: err.errno,
                sqlMessage: err.sqlMessage,
                sql: err.sql,
                stack: err.stack
            });
            // Try to get more information about the error
            if (err.sqlState === '01000') {
                logger.error('[PCN Generation] Data truncation error. Attempting to get column information...');
                try {
                    const [columns] = await conn.query('SHOW COLUMNS FROM pcns WHERE Field = ?', ['status']);
                    logger.error('[PCN Generation] Status column definition:', columns);
                } catch (colErr) {
                    logger.error('[PCN Generation] Error getting column information:', colErr);
                }
            }
            throw err;
        }
    } catch (err) {
        logger.error('[PCN Generation] Error creating PCN:', err);
        throw err;
    }
}

// Delete all PCNs (no admin check, delete audit log first)
router.post('/pcns/delete-all', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('DELETE FROM pcn_audit_log');
        const result = await conn.query('DELETE FROM pcns');
        // Log to audit (if you want to keep a record, you could log elsewhere)
        logger.warn(`[ADMIN] All PCNs and audit logs deleted`);
        res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
        logger.error('Error deleting all PCNs:', err);
        res.status(500).json({ error: 'Error deleting all PCNs' });
    } finally {
        if (conn) conn.release();
    }
});

// Re-check and clean PCNs endpoint
router.post('/pcns/recheck', async (req, res) => {
    try {
        let conn;
        let deleted = 0;
        let checked = 0;
        let logDetails = [];
        try {
            conn = await pool.getConnection();
            // Get all PCNs with status 'possible' or 'issued'
            const pcns = await conn.query("SELECT * FROM pcns WHERE status IN ('possible', 'issued')");
            logger.info(`[PCN Recheck] Checking ${pcns.length} PCNs...`);
            for (const pcn of pcns) {
                checked++;
                // Check whitelist
                const [whitelist] = await conn.query(
                    'SELECT * FROM whitelist WHERE carParkId = ? AND VRM = ? AND active = 1',
                    [pcn.siteId, pcn.VRM]
                );
                // Check payment
                const [payment] = await conn.query(
                    'SELECT * FROM payments WHERE siteId = ? AND vrm = ? AND paymentStart <= ? AND paymentEnd >= ? LIMIT 1',
                    [pcn.siteId, pcn.VRM, pcn.issueTime, pcn.dueDate]
                );
                logger.info(`[PCN Recheck] PCN #${pcn.id} VRM=${pcn.VRM} siteId=${pcn.siteId} | Whitelist: ${!!whitelist} | Payment: ${!!payment}`);
                logDetails.push({id: pcn.id, VRM: pcn.VRM, siteId: pcn.siteId, whitelist: !!whitelist, payment: !!payment});
                if (whitelist || payment) {
                    logger.info(`[PCN Recheck] Deleting PCN #${pcn.id} (whitelisted or paid)`);
                    // Log deletion
                    await conn.query(
                        'INSERT INTO pcn_audit_log (pcnId, eventId, ruleId, siteId, action, message) VALUES (?, ?, ?, ?, ?, ?)',
                        [pcn.id, pcn.eventId, pcn.ruleId, pcn.siteId, 'deleted', 'PCN auto-deleted after re-check: whitelisted or paid']
                    );
                    // Delete PCN
                    await conn.query('DELETE FROM pcns WHERE id = ?', [pcn.id]);
                    deleted++;
                }
            }
            logger.info(`[PCN Recheck] Finished. Checked: ${checked}, Deleted: ${deleted}`);
            res.json({ success: true, deleted, checked, logDetails });
        } catch (err) {
            logger.error('[PCN Recheck] Error during re-check:', err);
            res.status(500).json({ success: false, error: err.message || 'Unknown error' });
        } finally {
            if (conn) conn.release();
        }
    } catch (outerErr) {
        logger.error('[PCN Recheck] Outer error:', outerErr);
        res.status(500).json({ success: false, error: outerErr.message || 'Unknown outer error' });
    }
});

// Settings page
router.get('/settings', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const [setting] = await conn.query('SELECT value FROM settings WHERE `key` = ?', ['useTwoPassSystem']);
        res.render('admin/settings', { settings: { useTwoPassSystem: setting ? setting.value : 'false' } });
    } catch (err) {
        logger.error('Error fetching settings:', err);
        res.status(500).send('Error fetching settings');
    } finally {
        if (conn) conn.release();
    }
});

// Update settings
router.post('/settings', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        const useTwoPassSystem = req.body.useTwoPassSystem ? 'true' : 'false';
        await conn.query('UPDATE settings SET value = ? WHERE `key` = ?', [useTwoPassSystem, 'useTwoPassSystem']);
        res.redirect('/admin'); // Redirect to admin dashboard after saving
    } catch (err) {
        logger.error('Error updating settings:', err);
        res.status(500).send('Error updating settings');
    } finally {
        if (conn) conn.release();
    }
});

// Admin dashboard
router.get('/', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        // Get the two-pass system setting
        const [setting] = await conn.query('SELECT value FROM settings WHERE `key` = ?', ['useTwoPassSystem']);
        
        // Get other dashboard data
        const carParks = await conn.query('SELECT * FROM carparks');
        const cameras = await conn.query('SELECT * FROM cameras');
        const [totalEvents] = await conn.query('SELECT COUNT(*) as count FROM parking_events');
        const [totalPCNs] = await conn.query('SELECT COUNT(*) as count FROM pcns');
        
        res.render('admin/index', {
            carParks,
            cameras,
            totalEvents: totalEvents.count,
            totalPCNs: totalPCNs.count,
            settings: {
                useTwoPassSystem: setting ? setting.value : 'false'
            }
        });
    } catch (err) {
        logger.error('Error loading admin dashboard:', err);
        res.status(500).render('error', { message: 'Error loading admin dashboard' });
    } finally {
        if (conn) conn.release();
    }
});

return router;
} 
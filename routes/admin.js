const express = require('express');

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
        console.error('Error fetching cameras:', error);
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
        console.error('Error creating camera:', error);
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
        console.error('Error updating camera:', error);
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
        console.error('Error deleting camera:', error);
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
        const [carpark] = await conn.query('SELECT * FROM carparks WHERE siteId = ?', [siteId]);
        if (!carpark) return res.status(404).render('error', { message: 'Car park not found' });
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
        hourlyRows.forEach(row => { hourlyDistribution[row.hour].count = row.count; });
        // Daily stats for last 7 days
        const dailyRows = await conn.query(`
            SELECT DAYNAME(entryTime) as day, AVG(durationMinutes) as avgDuration
            FROM parking_events
            WHERE siteId = ? AND exitTime IS NOT NULL AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY day
        `, [siteId]);
        const daysOfWeek = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const dailyStats = daysOfWeek.map(day => {
            const found = dailyRows.find(r => r.day === day);
            return { day, avgDuration: found ? found.avgDuration : 0 };
        });
        // Get recent parking events for this car park (last 20), with PCN count using LEFT JOIN
        const recentEvents = await conn.query(`
            SELECT 
                e.id, 
                e.VRM as vrm, 
                e.entryTime, 
                e.exitTime, 
                e.durationMinutes,
                COUNT(p.id) as pcnCount
            FROM parking_events e
            LEFT JOIN pcns p ON p.eventId = e.id
            WHERE e.siteId = ?
            GROUP BY e.id, e.VRM, e.entryTime, e.exitTime, e.durationMinutes
            ORDER BY e.entryTime DESC
            LIMIT 20
        `, [siteId]);
        console.log('Recent Events:', recentEvents);
        // Monthly stats for last 6 months
        const monthlyRows = await conn.query(`
            SELECT DATE_FORMAT(entryTime, '%Y-%m') as month, COUNT(*) as totalVehicles, SUM(throughTraffic) as throughTraffic, AVG(durationMinutes) as avgDuration
            FROM parking_events
            WHERE siteId = ? AND exitTime IS NOT NULL AND entryTime >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
            GROUP BY month
            ORDER BY month DESC
        `, [siteId]);
        const monthlyStats = monthlyRows.map(row => ({
            month: row.month,
            totalVehicles: row.totalVehicles,
            throughTraffic: row.throughTraffic || 0,
            avgDuration: row.avgDuration || 0
        }));
        res.render('admin/carpark_dashboard', {
            carpark,
            currentOccupancy,
            todayStats,
            hourlyDistribution,
            dailyStats,
            currentVehicles,
            recentEvents,
            monthlyStats
        });
    } catch (err) {
        console.error('Error loading car park dashboard:', err);
        res.status(500).render('error', { message: 'Error loading car park dashboard' });
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
        console.error('Error loading rules page:', err);
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
        console.error('Error loading PCNs page:', err);
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
        console.error('Error loading PCN automation settings:', err);
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
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating PCN automation settings:', err);
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
        res.json({ success: true, deleted: result.affectedRows });
    } catch (err) {
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
        console.error('Error loading car parks:', err);
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
        console.error('Error updating car park:', err);
        res.status(500).render('error', { message: 'Error updating car park' });
    } finally {
        if (conn) conn.release();
    }
});

return router;
} 
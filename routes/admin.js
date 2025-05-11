const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all cameras with their car park names
router.get('/cameras', async (req, res) => {
    try {
        const [cameras] = await db.query(`
            SELECT c.*, cp.name as carParkName 
            FROM cameras c 
            LEFT JOIN carparks cp ON c.carParkId = cp.id 
            ORDER BY c.name
        `);
        
        const [carParks] = await db.query('SELECT * FROM carparks ORDER BY name');
        
        res.render('admin/cameras', { 
            cameras, 
            carParks,
            title: 'Manage Cameras'
        });
    } catch (error) {
        console.error('Error fetching cameras:', error);
        res.status(500).send('Error fetching cameras');
    }
});

// Create new camera
router.post('/api/cameras', async (req, res) => {
    try {
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction } = req.body;
        
        const [result] = await db.query(
            'INSERT INTO cameras (name, carParkId, isEntryTrigger, isExitTrigger, direction) VALUES (?, ?, ?, ?, ?)',
            [name, carParkId, isEntryTrigger, isExitTrigger, direction]
        );
        
        res.json({ id: result.insertId });
    } catch (error) {
        console.error('Error creating camera:', error);
        res.status(500).json({ error: 'Error creating camera' });
    }
});

// Update camera
router.put('/api/cameras/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, carParkId, isEntryTrigger, isExitTrigger, direction } = req.body;
        
        await db.query(
            'UPDATE cameras SET name = ?, carParkId = ?, isEntryTrigger = ?, isExitTrigger = ?, direction = ? WHERE id = ?',
            [name, carParkId, isEntryTrigger, isExitTrigger, direction, id]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating camera:', error);
        res.status(500).json({ error: 'Error updating camera' });
    }
});

// Delete camera
router.delete('/api/cameras/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await db.query('DELETE FROM cameras WHERE id = ?', [id]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting camera:', error);
        res.status(500).json({ error: 'Error deleting camera' });
    }
});

module.exports = router; 
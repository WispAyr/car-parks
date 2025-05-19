const mariadb = require('mariadb');
require('dotenv').config();

const pool = mariadb.createPool({
    host: '192.168.1.151',
    user: 'root',
    password: 'RBTeeyKM142!',
    database: 'nocobase',
    connectionLimit: 20,
    connectTimeout: 10000,
    acquireTimeout: 10000,
    idleTimeout: 60000,
    trace: false,
    resetAfterUse: true
});

module.exports = pool; 
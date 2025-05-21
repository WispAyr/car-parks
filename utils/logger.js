const { transports, createLogger, format } = require('winston');
const path = require('path');
const Transport = require('winston-transport');

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

// Define log colors
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white',
};

// Add colors to winston
require('winston').addColors(colors);

// Create the logger
const logger = createLogger({
    levels,
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
        format.colorize({ all: true }),
        format.printf(
            (info) => `${info.timestamp} ${info.level}: ${info.message}`,
        ),
    ),
    transports: [
        // Console transport
        new transports.Console(),
        // File transport for all logs
        new transports.File({
            filename: path.join('logs', 'combined.log'),
        }),
        // Separate file for errors
        new transports.File({
            filename: path.join('logs', 'error.log'),
            level: 'error',
        }),
    ],
});

class ConsolePatchTransport extends Transport {
    log(info, callback) {
        setImmediate(() => this.emit('logged', info));
        if (info.level === 'error') {
            console.error(info.message);
        } else {
            console.log(info.message);
        }
        callback();
    }
}

logger.add(new ConsolePatchTransport());

// Create a stream object for Morgan
logger.stream = {
    write: (message) => logger.http(message.trim()),
};

module.exports = logger; 
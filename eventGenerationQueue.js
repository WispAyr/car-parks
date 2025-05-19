const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const redis = new IORedis({
  maxRetriesPerRequest: null
});

const eventGenerationQueue = new Queue('event-generation', { connection: redis });
const eventGenerationEvents = new QueueEvents('event-generation', { connection: redis });

module.exports = { eventGenerationQueue, eventGenerationEvents, Worker, redis };
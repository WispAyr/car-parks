const { Worker, redis } = require('./eventGenerationQueue');
const { generateParkingEvents } = require('./eventGeneration');

// Worker for event generation jobs
const worker = new Worker('event-generation', async job => {
    // Call generateParkingEvents with a progress callback
    return await generateParkingEvents(
        job.data.startDate,
        job.data.endDate,
        job.data.clearFlaggedEvents,
        progress => job.updateProgress(progress)
    );
}, { connection: redis });

worker.on('completed', job => {
    console.log(`Job ${job.id} completed`);
});
worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed:`, err);
}); 
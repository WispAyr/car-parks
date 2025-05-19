let currentJobId = null;
let progressInterval = null;

function startEventGeneration(startDate, endDate, clearFlaggedEvents) {
    fetch('/api/start-event-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, clearFlaggedEvents })
    })
    .then(res => res.json())
    .then(data => {
        currentJobId = data.jobId;
        showProgressBar();
        listenForProgress(currentJobId);
        pollJobStatus(currentJobId);
    });
}

function showProgressBar() {
    // Progress bar is now part of the UI in the admin page
    let statusElement = document.getElementById('event-gen-status');
    if (statusElement) {
        statusElement.classList.remove('d-none');
    }
}

function updateProgressBar(percent) {
    let bar = document.getElementById('event-gen-bar');
    if (bar) {
        bar.style.width = percent + '%';
        bar.textContent = percent + '%';
        bar.setAttribute('aria-valuenow', percent);
        
        // Update message based on progress
        let messageElement = document.getElementById('event-gen-message');
        if (messageElement) {
            if (percent === 0) {
                messageElement.textContent = 'Initializing event generation...';
            } else if (percent < 100) {
                messageElement.textContent = `Processing... ${percent}% complete`;
            } else {
                messageElement.textContent = 'Event generation completed!';
                // Show results section
                document.getElementById('event-gen-results').classList.remove('d-none');
            }
        }
    }
}

function listenForProgress(jobId) {
    if (!window.io) return;
    const socket = window.io();
    socket.on('event-generation-progress', data => {
        if (data.jobId == jobId) {
            updateProgressBar(data.progress);
        }
    });
    socket.on('event-generation-failed', data => {
        if (data.jobId == jobId) {
            updateProgressBar(0);
            alert('Event generation failed: ' + data.failedReason);
        }
    });
}

function pollJobStatus(jobId) {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        fetch(`/api/event-generation-status/${jobId}`)
            .then(res => res.json())
            .then(data => {
                if (data.progress !== undefined) updateProgressBar(data.progress);
                if (data.state === 'completed' || data.state === 'failed') {
                    clearInterval(progressInterval);
                    if (data.state === 'completed') {
                        updateProgressBar(100);
                    } else if (data.state === 'failed') {
                        // Show error message
                        let messageElement = document.getElementById('event-gen-message');
                        if (messageElement) {
                            messageElement.textContent = 'Event generation failed: ' + (data.failedReason || 'Unknown error');
                            messageElement.classList.add('text-danger');
                        }
                    }
                }
            });
    }, 2000);
}

// Reset the UI when starting a new generation
function resetEventGenerationUI() {
    updateProgressBar(0);
    let messageElement = document.getElementById('event-gen-message');
    if (messageElement) {
        messageElement.textContent = 'Initializing event generation...';
        messageElement.classList.remove('text-danger');
    }
    document.getElementById('event-gen-results').classList.add('d-none');
}
// Global timezone state
let useBST = true;

// Toggle between BST and GMT
function toggleTimezone() {
    useBST = !useBST;
    // Trigger a refresh of any displayed times
    if (typeof window.refreshTimes === 'function') {
        window.refreshTimes();
    }
    return useBST;
}

// Get current timezone indicator
function getTimezoneIndicator() {
    return useBST ? 'BST' : 'GMT';
}

// Format date to local time in London (handles BST/GMT automatically, compensates for DB UTC)
function formatDateTime(dateString) {
    // If it's already a localized string (e.g., 'Sun May 11 2025 15:24:56 GMT+0100 (British Summer Time)'), return as is
    if (/[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}/.test(dateString)) {
        return dateString;
    }
    let isoString = dateString.trim();
    // Match 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD HH:MM:SS.sss'
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(isoString)) {
        isoString = isoString.replace(' ', 'T') + 'Z';
    }
    const date = new Date(isoString);
    return date.toLocaleString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Europe/London'
    });
}

// Format duration in minutes to a human-readable string
function formatDuration(minutes) {
    if (minutes === null || minutes === undefined) return '';
    return minutes.toFixed(1);
} 
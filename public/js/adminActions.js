// Generic admin action handler for buttons with spinner and result feedback
window.handleAdminAction = function({btnId, spinnerId, resultId, fetchOptions, confirmMsg, successMsg, reloadOnSuccess = false}) {
    const btn = document.getElementById(btnId);
    const spinner = document.getElementById(spinnerId);
    const resultDiv = document.getElementById(resultId);
    if (!btn) return;
    btn.onclick = async function() {
        if (confirmMsg && !confirm(confirmMsg)) return;
        btn.disabled = true;
        spinner.classList.remove('d-none');
        resultDiv.classList.add('d-none');
        resultDiv.textContent = '';
        try {
            const response = await fetch(fetchOptions.url, fetchOptions);
            let data;
            let errorText = '';
            try {
                data = await response.json();
            } catch (jsonErr) {
                data = {};
                errorText = await response.text();
            }
            if (response.ok && (data.success || response.status === 200)) {
                resultDiv.className = 'alert alert-success mt-2';
                resultDiv.textContent = successMsg || 'Success!';
                resultDiv.classList.remove('d-none');
                if (reloadOnSuccess) setTimeout(() => window.location.reload(), 1500);
            } else {
                resultDiv.className = 'alert alert-danger mt-2';
                let msg = data.error || errorText || 'Unknown error';
                resultDiv.textContent = `Error${response.status ? ' (' + response.status + ')' : ''}: ${msg}`;
                resultDiv.classList.remove('d-none');
            }
        } catch (err) {
            resultDiv.className = 'alert alert-danger mt-2';
            resultDiv.textContent = 'Error: ' + err.message;
            resultDiv.classList.remove('d-none');
        } finally {
            btn.disabled = false;
            spinner.classList.add('d-none');
        }
    };
} 
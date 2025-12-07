
const https = require('https');

const host = '176.100.14.52';

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'User-Agent': 'NodeJS Test', ...headers }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (e) => reject(e));
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkViaCheckHostTCP(host) {
    const nodes = ['de1.node.check-host.net', 'fr1.node.check-host.net', 'nl1.node.check-host.net'];
    const nodeParams = nodes.map(n => `node=${n}`).join('&');
    const requestUrl = `https://check-host.net/check-tcp?host=${host}:80&${nodeParams}`;
    let requestId;

    try {
        console.log(`Requesting check via URL: ${requestUrl}`);
        const data = await httpsGet(requestUrl, { 'Accept': 'application/json' });

        if (data.ok === 1 && data.request_id) {
            requestId = data.request_id;
            console.log(`Got request_id: ${requestId}`);
        } else {
            console.error('Invalid response from CheckHost TCP request');
            return null;
        }
    } catch (error) {
        console.error(`Request failed: ${error.message}`);
        return null;
    }

    const resultUrl = `https://check-host.net/check-result/${requestId}`;
    const maxAttempts = 10;
    const pollInterval = 5000;

    for (let i = 1; i <= maxAttempts; i++) {
        await sleep(pollInterval);
        console.log(`Poll attempt ${i}/${maxAttempts}...`);

        let results;
        try {
            results = await httpsGet(resultUrl, { 'Accept': 'application/json' });
            console.log("FULL RESULTS:", JSON.stringify(results, null, 2));
        } catch (err) {
            console.warn(`Poll error: ${err.message}`);
            continue;
        }

        if (results) {
            for (const node of nodes) {
                const nodeResult = results[node];
                if (nodeResult && nodeResult[0]) {
                    const checkData = nodeResult[0];
                    if (Array.isArray(checkData)) {
                        const hasSuccess = checkData.some((res) => !res.error || res.error === 'Connection refused');
                        if (hasSuccess) {
                            console.log(`[CheckHostTCP] Success (Connected/Refused) from ${node}`);
                            return true;
                        }
                    }
                }
            }
        }

        // Check if finished
        let allReported = true;
        for (const node of nodes) {
            if (!results || !results[node]) allReported = false;
        }
        if (allReported) {
            console.log(`[CheckHostTCP] Finished polling. No successful connection found.`);
            return false;
        }
    }
    return null;
}

checkViaCheckHostTCP(host).then(res => console.log('Final Result:', res));

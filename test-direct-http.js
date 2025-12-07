
const https = require('http'); // HTTP, NOT HTTPS for IP address usually

const host = '176.100.14.52';
const url = `http://${host}`;
console.log(`Testing Direct HTTP connection to ${url}...`);

function checkViaDirectHttp(url) {
    return new Promise((resolve) => {
        const req = https.get(url, {
            timeout: 4000,
            headers: { 'User-Agent': 'NodeTest' }
        }, (res) => {
            console.log(`Response received! Status: ${res.statusCode}`);
            res.resume(); // Consume response to free memory
            resolve(true);
        });

        req.on('error', (e) => {
            console.error(`Request error: ${e.message}`);
            if (e.message.includes('ECONNREFUSED')) {
                // Connection refused means host is UP but port closed (weird for port 80 check, but technically UP)
                resolve(true);
            } else {
                resolve(false);
            }
        });

        req.on('timeout', () => {
            console.error('Request Timed Out');
            req.destroy();
            resolve(null);
        });
    });
}

checkViaDirectHttp(url).then(res => console.log('Final Result:', res));

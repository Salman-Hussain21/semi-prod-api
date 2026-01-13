const GameDig = require('gamedig');
const axios = require('axios');
const http = require('http');

// CONFIG
const SERVERS = [
    { ip: '149.202.87.35', port: 27015, name: 'Public' },
    { ip: '149.202.87.35', port: 27016, name: 'AFK' },
    { ip: '149.202.87.35', port: 27018, name: 'Deathmatch' }
];

const API_URL = process.env.API_URL || 'http://localhost/dsgc/receive_data.php';
const API_KEY = 'dsgamingtrackermshstack';
const INTERVAL = 6 * 1000; // 6 seconds

// Create persistent axios instance for speed
const apiClient = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'DSGC-Tracker-Poller/3.0',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    }
});

console.log(`[${new Date().toISOString()}] Initializing Multi-Server Poller...`);
console.log(`[Target API]: ${API_URL}`);
console.log(`[Targets]: ${SERVERS.length} servers configured.`);

async function pollServer(server) {
    try {
        // 1. Query Game Server
        const state = await GameDig.query({
            type: 'cs16',
            host: server.ip,
            port: server.port,
            maxAttempts: 2,
            socketTimeout: 3000
        });

        // 2. Prepare Data
        const payload = {
            key: API_KEY,
            server_port: server.port, // Critical for backend to distinguish
            name: state.name,
            map: state.map,
            players: state.players.map(p => ({
                name: p.name,
                raw: p.raw
            })),
            num_players: state.players.length,
            max_players: state.maxplayers
        };

        // 3. Send to Backend
        await apiClient.post(API_URL, payload);
        // console.log(`[${server.name}] OK: ${state.players.length} players`);

    } catch (e) {
        console.error(`[${new Date().toLocaleTimeString()}] [${server.name} Error]: ${e.message}`);

        // Report error to API if possible (server down)
        try {
            await apiClient.post(API_URL, {
                key: API_KEY,
                server_port: server.port,
                error: 'down'
            });
        } catch (reportError) { }
    }
}

async function poll() {
    await Promise.all(SERVERS.map(s => pollServer(s)));
}

// Start Polling
setInterval(poll, INTERVAL);
poll();

// Anti-Crash & Health Check
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Health Check Server (Keep Render Alive)
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Poller is Active and Healthy');
}).listen(process.env.PORT || 8080, () => {
    console.log(`[Health Check] Server listening on port ${process.env.PORT || 8080}`);
});

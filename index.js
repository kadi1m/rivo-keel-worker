const os = require('os');
const fetch = require('node-fetch');
const docker = new (require('dockerode'))();
const WebSocket = require('ws');
const fs = require('fs');
const si = require('systeminformation');

// Load environment variables
const CONTROL_PLANE_HOST = process.env.CONTROL_PLANE_HOST;
const NODE_ID = os.hostname();

const ws = new WebSocket(`ws://${CONTROL_PLANE_HOST}/worker/ws`);

console.log(`[Worker] Connecting to ws://${CONTROL_PLANE_HOST}/worker/ws`);

let isProcessing = false;
const containerLogStreams = {};

const LOCK_FILE = '/tmp/worker_processing.lock';
// Clear any stale lock file on startup
if (fs.existsSync(LOCK_FILE)) {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) { }
}

ws.on('message', async (message) => {
    try {
        const data = JSON.parse(message);
        
        if (data.type === 'trigger-build') {
            if (isProcessing) {
                console.log(`[Worker] Ignoring build request: already processing a job.`);
                return;
            }
            isProcessing = true;
            fs.writeFileSync(LOCK_FILE, 'lock');
            
            console.log(`[Worker] Received build job. Starting processing...`);
            
            // TODO: Execute deployment process
            
            isProcessing = false;
            try { fs.unlinkSync(LOCK_FILE); } catch (e) { }
            console.log(`[Worker] Finished processing job.`);
        }
    } catch (err) {
        console.error(`[Worker] Failed to process websocket message`, err.message);
    }
});

async function collectStats() {
    try {
        // Collect System CPU, Mem, Disk
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();
        
        const mainDisk = disk.find(d => d.mount === '/') || disk[0];
        const diskPct = mainDisk ? mainDisk.use : 0;

        // Determine basic Network Rx/Tx
        const net = await si.networkStats();
        const mainNet = net[0];
        const netRx = mainNet ? mainNet.rx_bytes : 0;
        const netTx = mainNet ? mainNet.tx_bytes : 0;

        // Collect Docker Stats
        const containers = await docker.listContainers();
        const dockerStats = [];
        
        for (const container of containers) {
            const c = docker.getContainer(container.Id);
            const stats = await c.stats({ stream: false });
            
            if (stats) {
                const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
                const systemCpuDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
                const numCpus = stats.cpu_stats.online_cpus || 1;
                const cpuUsage = (cpuDelta / systemCpuDelta) * numCpus * 100.0;

                const memUsage = stats.memory_stats?.usage || 0;
                const netRxContainer = Object.values(stats.networks || {}).reduce((acc, curr) => acc + curr.rx_bytes, 0);
                const netTxContainer = Object.values(stats.networks || {}).reduce((acc, curr) => acc + curr.tx_bytes, 0);

                dockerStats.push({
                    containerId: container.Id.substring(0, 12),
                    name: container.Names[0],
                    image: container.Image,
                    state: container.State,
                    cpu: cpuUsage,
                    mem: memUsage,
                    net_rx: netRxContainer,
                    net_tx: netTxContainer
                });
            }
        }

        const payload = {
            node_id: NODE_ID,
            cpu: cpu.currentLoad,
            mem: (mem.active / mem.total) * 100,
            disk_pct: diskPct,
            net_rx: netRx,
            net_tx: netTx,
            docker_stats: dockerStats
        };

        const res = await fetch(`http://${CONTROL_PLANE_HOST}/worker/stats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.error(`[Worker] Failed to send stats. Status: ${res.status}`);
        }
    } catch (err) {
        console.error(`[Worker] Error collecting stats:`, err.message);
    }
}

async function setupLogStreams() {
    try {
        const containers = await docker.listContainers();
        for (const container of containers) {
            if (!containerLogStreams[container.Id]) {
                const c = docker.getContainer(container.Id);
                const stream = await c.logs({
                    follow: true,
                    stdout: true,
                    stderr: true,
                    tail: 10 // only grab last 10 lines to test initially
                });

                containerLogStreams[container.Id] = stream;

                stream.on('data', async (chunk) => {
                    const logLine = chunk.toString('utf8').trim();
                    if (!logLine) return;

                    try {
                        const LOG_INGRESS_URL = process.env.LOG_INGRESS_URL || 'http://localhost:3001/logs';
                        const targetUrl = LOG_INGRESS_URL.endsWith('/logs') ? LOG_INGRESS_URL : `${LOG_INGRESS_URL}/logs`;
                        await fetch(targetUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                nodeId: NODE_ID,
                                containerId: container.Id.substring(0, 12),
                                containerName: container.Names[0],
                                log: logLine
                            })
                        });
                    } catch (err) {
                        console.error(`[Worker] Log forwarding failed:`, err.message);
                    }
                });

                stream.on('end', () => {
                    delete containerLogStreams[container.Id];
                });

                stream.on('error', () => {
                    delete containerLogStreams[container.Id];
                });
            }
        }
    } catch (err) {
        console.error(`[Worker] Error setting up log streams:`, err.message);
    }
}

// Set up periodic tasks
setInterval(collectStats, 5000);
setInterval(setupLogStreams, 5000);

// Initial run
collectStats();
setupLogStreams();

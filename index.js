const os = require('os');
const fetch = require('node-fetch');
const docker = new (require('dockerode'))();
const fs = require('fs');

// Load environment variables
const NODE_ID = os.hostname();

const containerLogStreams = {};

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
                    tail: 10 // grab last 10 lines to test initially
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
setInterval(setupLogStreams, 5000);

// Initial run
setupLogStreams();

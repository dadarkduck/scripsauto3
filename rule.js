const { execSync, spawn } = require("child_process");
const axios = require("axios");
const ping = require("ping");
require("dotenv").config();

// ======================
// Load config từ .env
// ======================
const NODE_IP = process.env.NODE_IP;
const VM_LIST = process.env.VM_LIST.split(",").map(v => v.trim());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

// Map VMID → IP từ .env (VM_IPS=1008:192.168.80.120,1009:192.168.80.121)
const VM_IPS = Object.fromEntries(
    (process.env.VM_IPS || "")
        .split(",")
        .map(x => x.trim().split(":"))
        .filter(x => x.length === 2)
);

// ======================
// Gửi Telegram
// ======================
function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(err => console.error("Telegram send error:", err.message));
}

// ======================
// Gửi metric lên Pushgateway
// ======================
function pushMetric(vmId, status) {
    if (!PUSHGATEWAY_URL) return;
    const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_monitor/instance/${vmId}`;
    const metric = `vm_network{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
    const curl = spawn("curl", ["--data-binary", "@-", pushUrl]);
    curl.stdin.write(metric);
    curl.stdin.end();
    curl.stdout.on("data", (data) => {
        console.log(`[${NODE_IP}] Push metric VM ${vmId} response: ${data.toString().trim()}`);
    });
    curl.stderr.on("data", (data) => {
        console.error(`[${NODE_IP}] Push metric VM ${vmId} error: ${data.toString().trim()}`);
    });
    curl.on("close", (code) => {
        if (code !== 0) {
            console.error(`[${NODE_IP}] Push metric VM ${vmId} curl exited with code ${code}`);
        }
    });
}

// ======================
// Ping VM
// ======================
async function pingCheck(ip) {
    const res = await ping.promise.probe(ip, { timeout: 2, extra: ["-c1"] });
    return res.alive;
}

async function pingVM(vmId) {
    const ip = VM_IPS[vmId];
    if (!ip) {
        console.log(`[${NODE_IP}] VM ${vmId} chưa khai báo IP trong .env`);
        return;
    }

    try {
        const first = await pingCheck(ip);

        if (first) {
            console.log(`[${NODE_IP}] VM ${vmId} (${ip}) online`);
            pushMetric(vmId, 1);
            return;
        }

        // Ping lại lần 2 sau 3 giây
        await new Promise(r => setTimeout(r, 3000));
        const second = await pingCheck(ip);

        if (!second) {
            console.warn(`[${NODE_IP}] VM ${vmId} (${ip}) mất mạng hoàn toàn -> reboot`);
            sendTelegram(`VM ${vmId} (${ip}) mất mạng hoàn toàn, reboot...`);

            try {
                execSync(`qm reboot ${vmId}`);
            } catch {
                execSync(`qm stop ${vmId} && qm start ${vmId}`);
            }

            sendTelegram(`VM ${vmId} đã reboot`);
            pushMetric(vmId, 0);
        } else {
            console.log(`[${NODE_IP}] VM ${vmId} (${ip}) chập chờn nhưng vẫn sống`);
            pushMetric(vmId, 1);
        }
    } catch (e) {
        console.error(`[${NODE_IP}] Lỗi check VM ${vmId}:`, e.message);
        sendTelegram(`Lỗi check VM ${vmId}: ${e.message}`);
        pushMetric(vmId, 0);
    }
}

// ======================
// Vòng lặp monitor
// ======================
async function monitor() {
    for (const vmId of VM_LIST) {
        await pingVM(vmId);
    }
}

setInterval(monitor, 60000); // check mỗi 60 giây
monitor();

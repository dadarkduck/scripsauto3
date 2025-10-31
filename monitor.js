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

// Map VMID → IP từ .env (VM_IPS=1008:192.168.77.130,1009:192.168.77.131)
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
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(() => {});
}

// ======================
// Push metric lên Pushgateway
// ======================
function pushMetric(vmId, status) {
    if (!PUSHGATEWAY_URL) return;
    const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_monitor/instance/${vmId}`;
    const metric = `vm_network{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
    const curl = spawn("curl", ["-s", "--data-binary", "@-", pushUrl]);
    curl.stdin.write(metric);
    curl.stdin.end();
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
        const alive = await pingCheck(ip);
        if (alive) {
            console.log(`[${NODE_IP}] VM ${vmId} (${ip}) online`);
            pushMetric(vmId, 1);
        } else {
            console.warn(`[${NODE_IP}] VM ${vmId} (${ip}) mất mạng -> reboot`);
            sendTelegram(`VM ${vmId} (${ip}) mất mạng, reboot...`);
            try {
                execSync(`qm reboot ${vmId}`);
            } catch {
                execSync(`qm stop ${vmId} && qm start ${vmId}`);
            }
            sendTelegram(`VM ${vmId} đã reboot`);
            pushMetric(vmId, 0);
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

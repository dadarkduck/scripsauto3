const { spawn } = require("child_process");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.VM_BACKUP_DIR || "/var/backups/vm";
const RSYNC_TARGETS = (process.env.RSYNC_TARGETS || "").split(",").map(t => t.trim()).filter(Boolean);
const NODE_IP = process.env.NODE_IP || "local";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

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
// Push metric
// ======================
function pushMetric(vmId, status) {
    if (!PUSHGATEWAY_URL) return;
    const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/vm_backup/instance/${vmId}`;
    const metric = `vm_backup{vm="${vmId}", node="${NODE_IP}"} ${status}\n`;
    const curl = spawn("curl", ["--data-binary", `@-`, pushUrl]);
    curl.stdin.write(metric);
    curl.stdin.end();
}

// ======================
// Chạy command async
// ======================
function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: "inherit", ...opts });
        p.on("close", code => resolve(code));
    });
}

// ======================
// Backup VM/DB
// ======================
async function backupVM(vmId) {
    console.log(`[${NODE_IP}] Backup ${process.env.BACKUP_TYPE} ${vmId}...`);
    sendTelegram(`Backup ${process.env.BACKUP_TYPE} ${vmId} bắt đầu...`);

    await runCmd("mkdir", ["-p", BACKUP_DIR]);

    let code;
    if (process.env.BACKUP_TYPE === "vm") {
        code = await runCmd("vzdump", [
            vmId,
            "--dumpdir", BACKUP_DIR,
            "--mode", "snapshot",
            "--compress", "lzo",
            "--remove", "0"
        ]);
    } else if (process.env.BACKUP_TYPE === "db") {
        const timestamp = new Date().toISOString().replace(/[:]/g, "-");
        const backupFile = `${BACKUP_DIR}/db_virtualizor_${timestamp}.sql.gz`;
        code = await runCmd("bash", ["-c", `mysqldump -u ${process.env.DB_USER} -p${process.env.DB_PASS} ${vmId} | gzip > ${backupFile}`]);
    }

    if (code === 0) {
        sendTelegram(`Backup ${process.env.BACKUP_TYPE} ${vmId} thành công`);
        pushMetric(vmId, 1);
        return vmId;
    } else {
        sendTelegram(`Backup ${process.env.BACKUP_TYPE} ${vmId} thất bại (code ${code})`);
        pushMetric(vmId, 0);
        return null;
    }
}

// ======================
// Cleanup file cũ local
// ======================
async function cleanupLocal(vmId) {
    let cmd;
    if (process.env.BACKUP_TYPE === "vm") {
        cmd = `
            # QEMU backups
            ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.vma.* 2>/dev/null | tail -n +2 | xargs -r rm -f;
            ls -1t ${BACKUP_DIR}/vzdump-qemu-${vmId}-*.log   2>/dev/null | tail -n +2 | xargs -r rm -f;
            rm -f ${BACKUP_DIR}/.vzdump-qemu-${vmId}-*.vma.lzo.* 2>/dev/null;

            # LXC backups
            ls -1t ${BACKUP_DIR}/vzdump-lxc-${vmId}-*.tar.*  2>/dev/null | tail -n +2 | xargs -r rm -f;
            ls -1t ${BACKUP_DIR}/vzdump-lxc-${vmId}-*.log    2>/dev/null | tail -n +2 | xargs -r rm -f;
        `;
    } else if (process.env.BACKUP_TYPE === "db") {
        cmd = `ls -1t ${BACKUP_DIR}/db_virtualizor_*.sql.* | tail -n +2 | xargs -r rm -f`;
    }
    await runCmd("bash", ["-c", cmd]);
    console.log(`[${NODE_IP}] Cleanup local old backups for ${vmId} done`);
}

// ======================
// Rsync + cleanup remote
// ======================
async function syncBackup(vmId) {
    for (const target of RSYNC_TARGETS) {
        if (!target) continue;

        const code = await runCmd("rsync", ["-avz", "--inplace", `${BACKUP_DIR}/`, `root@${target}:${BACKUP_DIR}/`]);
        if (code === 0) {
            sendTelegram(`Rsync VM/DB backups sang ${target} thành công`);

            let remoteCmd;
            if (process.env.BACKUP_TYPE === "vm") {
                remoteCmd = `
                    cd ${BACKUP_DIR} &&
                    for id in $(ls vzdump-*-*.log 2>/dev/null | sed -E 's/vzdump-(qemu|lxc)-([0-9]+)-.*/\\2/' | sort -u); do
                        # QEMU
                        ls -1t vzdump-qemu-$id-*.vma.* 2>/dev/null | tail -n +2 | xargs -r rm -f
                        ls -1t vzdump-qemu-$id-*.log   2>/dev/null | tail -n +2 | xargs -r rm -f
                        rm -f .vzdump-qemu-$id-*.vma.lzo.* 2>/dev/null

                        # LXC
                        ls -1t vzdump-lxc-$id-*.tar.*  2>/dev/null | tail -n +2 | xargs -r rm -f
                        ls -1t vzdump-lxc-$id-*.log    2>/dev/null | tail -n +2 | xargs -r rm -f
                    done
                `;
            } else {
                remoteCmd = `cd ${BACKUP_DIR} && ls -1t db_virtualizor_*.sql.* | tail -n +2 | xargs -r rm -f`;
            }
            await runCmd("ssh", [`root@${target}`, remoteCmd]);
            sendTelegram(`Cleanup old backups trên ${target} done`);
        } else {
            sendTelegram(`Rsync VM/DB backups sang ${target} thất bại`);
        }
    }
}

// ======================
// Main job
// ======================
async function job() {
    const VM_LIST = (process.env.VM_LIST || "").split(",").map(v => v.trim()).filter(Boolean);

    for (const vmId of VM_LIST) {
        const successVm = await backupVM(vmId);
        if (successVm) {
            await syncBackup(successVm);
            await cleanupLocal(successVm);
        }
    }
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);

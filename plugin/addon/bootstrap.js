var ZoteroArchiver;

function log(msg) {
    Zotero.debug("Zotero Archiver: " + msg);
}

function install() {
    log("Installed");
}

async function startup({ id, version, rootURI }) {
    log("Starting " + version);
    try {
        Services.scriptloader.loadSubScript(rootURI + "zotero-archiver.js");
        ZoteroArchiver.init({ id, version, rootURI });
        ZoteroArchiver.addToAllWindows();
        Zotero.ZoteroArchiver = ZoteroArchiver;
    } catch (e) {
        log("startup error: " + e);
    }
    // 注册偏好设置页（「编辑 → 设置」中显示）
    try {
        Zotero.PreferencePanes.register({
            pluginID: id,
            src: rootURI + "preferences.xhtml",
            label: "Zotero Archiver"
        });
    } catch (e) {
        log("PreferencePanes.register failed: " + e);
    }

    // 待处理任务（标记/清理/恢复）：启动 5 秒后执行，之后每 10 秒重试直到成功
    try {
        function runPending() {
            try { ZoteroArchiver._applyPendingMark(); } catch (e) { log("pendingMark error: " + e); }
            try { ZoteroArchiver._applyPendingPrune(); } catch (e) { log("pendingPrune error: " + e); }
            try { ZoteroArchiver._applyPendingRestore(); } catch (e) { log("pendingRestore error: " + e); }
        }
        setTimeout(runPending, 5000);
        setInterval(runPending, 10000);
    } catch (e) {
        log("startup timer error: " + e);
    }
    // 定期备份检查：每 15 分钟
    try {
        setInterval(function () {
            try { ZoteroArchiver.checkAutoBackup(); } catch (e) { log("autoBackup check error: " + e); }
        }, 15 * 60 * 1000);
    } catch (e) {
        log("autoBackup timer error: " + e);
    }
}

function onMainWindowLoad({ window }) {
    ZoteroArchiver.addToWindow(window);
}

function onMainWindowUnload({ window }) {
    ZoteroArchiver.removeFromWindow(window);
}

function shutdown() {
    ZoteroArchiver.removeFromAllWindows();
    ZoteroArchiver = undefined;
}

function uninstall() {
    log("Uninstalled");
}

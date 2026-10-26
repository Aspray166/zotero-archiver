// =============================================================================
//  Zotero Archiver —— 插件核心逻辑（Zotero 7+ / 10）
//
//  功能：
//    1. 归档所选论文 -> 完整快照主库到命名归档库，清理未选中条目，标记「已归档」
//    2. 恢复到主库   -> 从归档库导出所选论文，自动切回主库导入（含附件、归入同名集合）
//    3. 切换文库     -> 设置页列表切换主库/归档库（自动重启）
//    4. 批量删除已归档论文（含文件）
//    5. 定期备份     -> 自动生成「备份 YYYY-MM-DD」归档库
//
//  归档库位置可在设置页修改，默认 D:/Zotero-Archive。
// =============================================================================
var ZoteroArchiver = (function () {
    "use strict";

    var RDF_TRANSLATOR = "14763d24-8ba0-45df-8f52-b8d1108e7ac9"; // Zotero RDF（仅导出）
    var RDF_IMPORT_TRANSLATOR = "5e3ad958-ac79-463d-812b-a86a9235c28f"; // RDF（仅导入）
    var XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    var ARCHIVE_TAG = "已归档";

    var PREF_ROOT = "extensions.zotero-archiver.";
    var PREF_RESTORE_DIR = PREF_ROOT + "restoreDir";
    var PREF_ARCHIVE_ROOT = PREF_ROOT + "archiveRoot";
    var PREF_AB_ENABLED = PREF_ROOT + "autoBackup.enabled";
    var PREF_AB_DAYS = PREF_ROOT + "autoBackup.days";
    var PREF_AB_HOUR = PREF_ROOT + "autoBackup.hour";
    var PREF_AB_LAST = PREF_ROOT + "autoBackup.lastRun";

    // ---- 主库固定路径（一般无需修改） ----
    var ZOTERO_EXE = "C:/Program Files/Zotero/zotero.exe";
    var MAIN_DATA_DIR = "D:/OneDrive/Zotero";
    var MAIN_PROFILE = "C:/Users/Administrator/AppData/Roaming/Zotero/Zotero/Profiles/jdl6eimd.default";

    // 归档库根目录默认值（可在插件「设置归档库位置」中修改）
    var DEFAULT_ARCHIVE_ROOT = "D:/Zotero-Archive";

    function defaults() {
        return {
            archiveRoot: DEFAULT_ARCHIVE_ROOT,
            autoBackupEnabled: false,
            autoBackupDays: "30",
            autoBackupHour: "3",
            autoBackupLastRun: ""
        };
    }

    function norm(p) {
        if (p == null) return "";
        return String(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    }
    function win(p) { // 转成 Windows 反斜杠路径（供 .bat 使用）
        return String(p).replace(/\//g, "\\");
    }
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function timestamp() {
        var d = new Date();
        return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }

    var API = {
        id: null, version: null, rootURI: null,

        // ---------- 生命周期 ----------
        init(data) {
            this.id = data.id;
            this.version = data.version;
            this.rootURI = data.rootURI;
            this._onItemMenuShowingBound = this._onItemMenuShowing.bind(this);
        },
        addToAllWindows() {
            var wins = Zotero.getMainWindows();
            for (var i = 0; i < wins.length; i++) this.addToWindow(wins[i]);
        },
        removeFromAllWindows() {
            var wins = Zotero.getMainWindows();
            for (var i = 0; i < wins.length; i++) this.removeFromWindow(wins[i]);
        },
        addToWindow(win) { this._addMenus(win); },
        removeFromWindow(win) { this._removeMenus(win); },

        // ---------- 右键菜单（选中论文 → 归档） ----------
        _addMenus(win) {
            var doc = win.document;
            var itemMenu = doc.getElementById("zotero-itemmenu");
            if (itemMenu) itemMenu.addEventListener("popupshowing", this._onItemMenuShowingBound, false);
        },

        _removeMenus(win) {
            var doc = win.document;
            var itemMenu = doc.getElementById("zotero-itemmenu");
            if (itemMenu) itemMenu.removeEventListener("popupshowing", this._onItemMenuShowingBound, false);
            var old = doc.querySelectorAll("[id^='za-']");
            for (var i = 0; i < old.length; i++) old[i].remove();
        },

        _clearZaItems(scope) {
            var items = scope.querySelectorAll("[id^='za-']");
            for (var i = 0; i < items.length; i++) items[i].remove();
        },

        _onItemMenuShowing(e) {
            var menu = e.target;
            // 只处理 zotero-itemmenu 本身；popupshowing 会冒泡，其他插件子菜单打开时 e.target 是那个子菜单
            if (!menu || menu.id !== "zotero-itemmenu") return;
            var doc = menu.ownerDocument;
            this._clearZaItems(menu);
            var self = this;
            var sep = doc.createElementNS(XUL_NS, "menuseparator");
            sep.id = "za-itemmenu-sep";
            menu.appendChild(sep);
            var defs = [
                { id: "za-archive-selected", label: "归档", fn: function () { self.archiveSelected(); } },
                { id: "za-restore-to-main", label: "恢复到主库", fn: function () { self.restoreToMain(); } },
            ];
            for (var i = 0; i < defs.length; i++) {
                var mi = doc.createElementNS(XUL_NS, "menuitem");
                mi.id = defs[i].id;
                mi.setAttribute("label", defs[i].label);
                mi.addEventListener("command", defs[i].fn);
                menu.appendChild(mi);
            }
        },

        // ---------- 工具 ----------
        _win() {
            var wins = Zotero.getMainWindows();
            return wins && wins.length ? wins[0] : null;
        },
        _alert(msg) {
            var win = this._win();
            if (win && Services.prompt) Services.prompt.alert(win, "Zotero Archiver", msg);
            else Zotero.debug("Zotero Archiver: " + msg);
        },
        _confirm(msg) {
            var win = this._win();
            if (!win || !Services.prompt) return false;
            return Services.prompt.confirm(win, "Zotero Archiver", msg);
        },

        getPref(name) {
            var map = {
                restoreDir: PREF_RESTORE_DIR,
                archiveRoot: PREF_ARCHIVE_ROOT,
                autoBackupEnabled: PREF_AB_ENABLED,
                autoBackupDays: PREF_AB_DAYS,
                autoBackupHour: PREF_AB_HOUR,
                autoBackupLastRun: PREF_AB_LAST
            };
            var v = Zotero.Prefs.get(map[name], true);
            if (v === undefined || v === null || v === "") {
                if (name === "restoreDir") return this._archiveRoot() + "/_restore";
                return defaults()[name];
            }
            return v;
        },
        setPref(name, value) {
            var map = {
                restoreDir: PREF_RESTORE_DIR,
                archiveRoot: PREF_ARCHIVE_ROOT,
                autoBackupEnabled: PREF_AB_ENABLED,
                autoBackupDays: PREF_AB_DAYS,
                autoBackupHour: PREF_AB_HOUR,
                autoBackupLastRun: PREF_AB_LAST
            };
            Zotero.Prefs.set(map[name], value, true);
        },

        _currentDataDir() {
            try {
                var d = Zotero.DataDirectory.dir;
                if (typeof d === "string") return norm(d);
                if (d && d.path) return norm(d.path);
            } catch (e) { /* ignore */ }
            return "";
        },
        _isArchive() {
            var d = this._currentDataDir();
            var root = norm(this._archiveRoot());
            return d !== "" && d.indexOf(root + "/") === 0;
        },
        _currentArchiveName() {
            if (!this._isArchive()) return "";
            var d = this._currentDataDir();
            var root = norm(this._archiveRoot());
            if (d.indexOf(root + "/") !== 0) return "";
            return d.substring(root.length + 1).split("/")[0];
        },
        _currentLibraryName() {
            var name = this._currentArchiveName();
            return name ? "归档库「" + name + "」" : "主库";
        },
        _tmpDir() {
            return Services.dirsvc.get("TmpD", Components.interfaces.nsIFile).path;
        },
        _archiveRoot() {
            return String(this.getPref("archiveRoot") || DEFAULT_ARCHIVE_ROOT)
                .replace(/\\/g, "/").replace(/\/+$/, "");
        },
        _baseAttachmentDir() {
            var p = Zotero.Prefs.get("extensions.zotero.baseAttachmentPath", true);
            if (p && String(p).trim()) return String(p).trim().replace(/\\/g, "/").replace(/\/+$/, "");
            return "D:/OneDrive/Zotero附件";
        },
        _namedDataDir(name) { return this._archiveRoot() + "/" + name + "/data"; },
        _namedProfileDir(name) { return this._archiveRoot() + "/" + name + "/profile"; },
        _namedAttachDir(name) { return this._archiveRoot() + "/" + name + "/attachments"; },
        _promptArchiveName() {
            var win = this._win();
            if (!win || !Services.prompt) return "";
            var input = { value: "归档 " + timestamp() };
            var ok = Services.prompt.prompt(win, "Zotero Archiver", "归档库名称（会创建到「归档库/<名称>」下）：", input, null, { value: false });
            if (!ok) return "";
            var name = String(input.value || "").trim().replace(/[\\/:*?"'<>|]/g, "_");
            return name;
        },
        async _listArchives() {
            var names = [];
            try {
                var children = await IOUtils.getChildren(win(this._archiveRoot()));
                for (var i = 0; i < children.length; i++) {
                    var child = String(children[i]);
                    var base = child.replace(/\\/g, "/").split("/").pop();
                    if (base && base.indexOf(".") !== 0 && await this._exists(child + "/profile")) {
                        names.push(base);
                    }
                }
            } catch (e) { /* ignore */ }
            names.sort();
            return names;
        },

        async refreshLibraryList(doc) {
            try {
                if (!doc) return;
                var self = this;
                var label = doc.getElementById("za-current-label");
                var curArchive = this._currentArchiveName();
                if (label) label.setAttribute("value", "当前库：" + this._currentLibraryName());

                // 定期备份 UI
                var abEnabled = doc.getElementById("za-ab-enabled");
                if (abEnabled) {
                    abEnabled.checked = !!this.getPref("autoBackupEnabled");
                    if (!abEnabled.__bound) {
                        abEnabled.addEventListener("command", function () {
                            self.setPref("autoBackupEnabled", !!abEnabled.checked);
                        });
                        abEnabled.__bound = true;
                    }
                }
                var abDays = doc.getElementById("za-ab-days");
                if (abDays) {
                    abDays.value = this.getPref("autoBackupDays");
                    if (!abDays.__bound) {
                        abDays.addEventListener("change", function () {
                            var v = parseInt(abDays.value, 10);
                            if (!v || v < 1) v = 30;
                            abDays.value = v;
                            self.setPref("autoBackupDays", String(v));
                        });
                        abDays.__bound = true;
                    }
                }
                var abHour = doc.getElementById("za-ab-hour");
                if (abHour) {
                    abHour.value = this.getPref("autoBackupHour");
                    if (!abHour.__bound) {
                        abHour.addEventListener("change", function () {
                            var v = parseInt(abHour.value, 10);
                            if (isNaN(v) || v < 0 || v > 23) v = 3;
                            abHour.value = v;
                            self.setPref("autoBackupHour", String(v));
                        });
                        abHour.__bound = true;
                    }
                }

                var container = doc.getElementById("za-library-list");
                if (!container) return;
                while (container.firstChild) container.removeChild(container.firstChild);
                function makeBtn(name, isCurrent) {
                    var b = doc.createElementNS(XUL_NS, "button");
                    b.setAttribute("label", (isCurrent ? "▶ " : "　") + name + (isCurrent ? "（当前）" : ""));
                    b.setAttribute("align", "start");
                    if (isCurrent) b.setAttribute("style", "font-weight: bold; color: #0a7d33;");
                    if (!isCurrent) {
                        b.addEventListener("command", function () {
                            if (b.getAttribute("disabled") === "true") return;
                            b.setAttribute("disabled", "true");
                            try { if (doc && doc.defaultView) doc.defaultView.close(); } catch (e) { /* ignore */ }
                            if (name === "主库") self._runHelper("switch-main");
                            else self._syncPlugin(name).then(function () { self._runHelper("switch-archive", name); });
                        });
                    }
                    return b;
                }
                container.appendChild(makeBtn("主库", curArchive === ""));
                var names = await this._listArchives();
                for (var i = 0; i < names.length; i++) {
                    container.appendChild(makeBtn(names[i], curArchive === names[i]));
                    this._fixArchivePrefs(names[i]);
                    this._syncPlugin(names[i]);
                }
            } catch (e) {
                // 忽略
            }
        },

        browseArchiveRoot(button) {
            try {
                var win = null;
                try { win = Services.wm.getMostRecentWindow("navigator:browser"); } catch (e) { /* ignore */ }
                if (!win && button && button.ownerDocument) { try { win = button.ownerDocument.defaultView; } catch (e) { /* ignore */ } }
                var fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
                fp.init(win, "选择归档库根目录", Components.interfaces.nsIFilePicker.modeGetFolder);
                var rv = fp.show();
                if (rv === Components.interfaces.nsIFilePicker.returnOK) {
                    this.setPref("archiveRoot", fp.file.path);
                    if (button.ownerDocument) this.refreshLibraryList(button.ownerDocument);
                }
            } catch (e) {
                this._alert("选择目录出错：\n" + e);
            }
        },

        _archivePrefs(name) {
            var dataDirPref = win(this._namedDataDir(name)).replace(/\\/g, "\\\\");
            var attachPref = win(this._namedAttachDir(name)).replace(/\\/g, "\\\\");
            return 'user_pref("extensions.zotero.dataDir", "' + dataDirPref + '");\n' +
                'user_pref("extensions.zotero.useDataDir", true);\n' +
                'user_pref("extensions.zotero.baseAttachmentPath", "' + attachPref + '");\n' +
                'user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);\n' +
                'user_pref("extensions.zotero.firstRun2", false);\n' +
                'user_pref("extensions.zotero.sync.autoSync", false);\n' +
                'user_pref("extensions.zotero.sync.server.username", "");\n' +
                'user_pref("extensions.autoDisableScopes", 0);\n' +
                'user_pref("extensions.startupScanScopes", 15);\n' +
                'user_pref("app.update.auto", false);\n';
        },
        async _fixArchivePrefs(name) {
            try {
                var prefsPath = this._namedProfileDir(name) + "/prefs.js";
                if (!(await this._exists(prefsPath))) return;
                var dataDirPref = win(this._namedDataDir(name)).replace(/\\/g, "\\\\");
                var content = await this._read(prefsPath);
                if (content.indexOf(dataDirPref) !== -1 && content.indexOf("useDataDir") !== -1) return;
                await this._write(prefsPath, this._archivePrefs(name));
            } catch (e) { /* ignore */ }
        },
        async _syncPlugin(name) {
            try {
                if (name === this._currentArchiveName()) return;  // 跳过当前正在使用的库
                var profileDir = this._namedProfileDir(name);
                var xpiPath = this._ownXpiPath();
                if (!xpiPath) return;
                var extDir = profileDir + "/extensions";
                await this._mkdir(extDir);
                var dest = extDir + "/zotero-archiver@example.com.xpi";
                var bytes = await IOUtils.read(win(xpiPath));
                await IOUtils.write(win(dest), bytes);
                // sideload 的扩展默认被 Firefox 禁用，改成启用
                var ejPath = profileDir + "/extensions.json";
                try {
                    var ejText = await this._read(ejPath);
                    var ej = JSON.parse(ejText);
                    var addons = ej.addons || [];
                    for (var i = 0; i < addons.length; i++) {
                        if (addons[i].id === "zotero-archiver@example.com") {
                            addons[i].userDisabled = false;
                            addons[i].active = true;
                            addons[i].seen = true;
                            addons[i].foreignInstall = false;
                        }
                    }
                    await this._write(ejPath, JSON.stringify(ej));
                } catch (e2) { /* ignore */ }
                // 清除启动缓存，让 Firefox 重新读取扩展状态
                try { await IOUtils.remove(win(profileDir + "/addonStartup.json.lz4")); } catch (e) { /* ignore */ }
            } catch (e) { /* ignore */ }
        },
        _ownXpiPath() {
            try {
                if (this.rootURI) {
                    var m = String(this.rootURI).match(/^jar:file:\/+\/([^!]+\.xpi)!/);
                    if (m) {
                        var p = m[1];
                        try { p = decodeURIComponent(p); } catch (e) { /* ignore */ }
                        return p.replace(/^\/+/, "");
                    }
                }
            } catch (e) { /* ignore */ }
            return "";
        },

        _isRegularTop(it) {
            return it && it.isRegularItem() && !it.isNote() && !it.isAttachment() && !it.isAnnotation() && !it.deleted;
        },
        _selectedTops() {
            var pane = Zotero.getActiveZoteroPane();
            var items = pane ? pane.getSelectedItems() : [];
            var out = [];
            for (var i = 0; i < items.length; i++) {
                if (this._isRegularTop(items[i])) out.push(items[i]);
            }
            return out;
        },
        _file(path) {
            var f = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            f.initWithPath(String(path).replace(/\//g, "\\"));
            return f;
        },
        // 文件操作统一走 IOUtils（转反斜杠：Windows 下 nsIFile/IOUtils 不认 D:/ 正斜杠）
        _mkdir(path) { return IOUtils.makeDirectory(win(path), { createAncestors: true, ignoreExisting: true }); },
        _write(path, data) { return IOUtils.writeUTF8(win(path), data); },
        _read(path) { return IOUtils.readUTF8(win(path)); },
        _remove(path) { return IOUtils.remove(win(path), { recursive: true }); },
        _exists(path) { return IOUtils.exists(win(path)); },

        // ---------- 辅助脚本（PowerShell .ps1，UTF-8 BOM，退出后执行复制/重开） ----------
        _helperPs1(kind, name) {
            var L = [];
            L.push("$ErrorActionPreference = 'SilentlyContinue'");
            L.push("$deadline = (Get-Date).AddSeconds(180)");
            L.push("while ((Get-Process -Name zotero -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {");
            L.push("  Start-Sleep -Milliseconds 500");
            L.push("}");

            if (kind === "archive") {
                var dataDir = win(this._namedDataDir(name));
                var profileDir = win(this._namedProfileDir(name));
                var attachDir = win(this._namedAttachDir(name));
                var storageDir = dataDir + "\\storage";
                var extDir = profileDir + "\\extensions";
                L.push("if (Test-Path '" + dataDir + "') { Remove-Item '" + dataDir + "' -Recurse -Force }");
                L.push("New-Item -ItemType Directory -Force -Path '" + dataDir + "' | Out-Null");
                L.push("robocopy '" + win(MAIN_DATA_DIR) + "' '" + dataDir + "' 'zotero.sqlite' /COPY:DAT /R:2 /W:2 | Out-Null");
                L.push("if (Test-Path '" + win(MAIN_DATA_DIR) + "\\storage') { robocopy '" + win(MAIN_DATA_DIR) + "\\storage' '" + storageDir + "' /E /COPY:DAT /R:2 /W:2 | Out-Null }");
                L.push("if (Test-Path '" + win(this._baseAttachmentDir()) + "') { robocopy '" + win(this._baseAttachmentDir()) + "' '" + attachDir + "' /E /COPY:DAT /R:2 /W:2 | Out-Null }");
                var xpiPath = this._ownXpiPath();
                if (xpiPath) {
                    L.push("New-Item -ItemType Directory -Force -Path '" + extDir + "' | Out-Null");
                    L.push("Copy-Item '" + win(xpiPath) + "' '" + extDir + "\\zotero-archiver@example.com.xpi' -Force");
                }
                L.push("& '" + win(ZOTERO_EXE) + "' -profile '" + win(this._namedProfileDir(name)) + "'");
            } else if (kind === "switch-archive") {
                L.push("& '" + win(ZOTERO_EXE) + "' -profile '" + win(this._namedProfileDir(name)) + "'");
            } else if (kind === "switch-main") {
                L.push("& '" + win(ZOTERO_EXE) + "' -profile '" + win(MAIN_PROFILE) + "'");
            }
            return L.join("\r\n");
        },

        async _writePs1(path, content) {
            var body = new TextEncoder().encode(content);
            var all = new Uint8Array(body.length + 3);
            all[0] = 0xEF; all[1] = 0xBB; all[2] = 0xBF;
            all.set(body, 3);
            await IOUtils.write(win(path), all);
        },

        async _runHelper(kind, name) {
            var ps1Path = this._tmpDir() + "\\zotero-archiver-helper.ps1";
            try {
                await this._writePs1(ps1Path, this._helperPs1(kind, name));
            } catch (e) {
                this._alert("写入辅助脚本失败：\n" + e);
                return;
            }
            try {
                var proc = Components.classes["@mozilla.org/process/util;1"]
                    .createInstance(Components.interfaces.nsIProcess);
                var ps = Components.classes["@mozilla.org/file/local;1"]
                    .createInstance(Components.interfaces.nsIFile);
                ps.initWithPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
                proc.init(ps);
                proc.runAsync(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1Path], 7);
            } catch (e) {
                this._alert("启动辅助进程失败：\n" + e);
                return;
            }
            setTimeout(function () {
                try {
                    Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
                } catch (e) {
                    try { Zotero.quit(); } catch (e2) { /* ignore */ }
                }
            }, 800);
        },

        // ---------- 归档（命名快照）/ 切换 / 删除 ----------
        async _snapshotTo(name, silent) {
            if (this._isArchive()) {
                if (!silent) this._alert("当前在【归档库】。归档请在【主库】执行，请先切换回主库。");
                return false;
            }
            if (!silent) {
                var msg = "将把【主库】完整快照到归档库「" + name + "」：\n" + this._namedDataDir(name) +
                    "\n\nZotero 会自动退出并重新打开以完成复制。\n确定继续吗？";
                if (!this._confirm(msg)) return false;
            }

            // 写归档 profile 的 prefs.js（路径用反斜杠，Windows 才能识别）
            try {
                var profileDir = this._namedProfileDir(name);
                await this._mkdir(profileDir);
                await this._write(profileDir + "/prefs.js", this._archivePrefs(name));
            } catch (e) {
                this._alert("创建归档配置失败：\n" + e);
                return false;
            }
            await this._syncPlugin(name);  // 复制并启用插件（sideload 默认被禁用）
            await this._runHelper("archive", name);
            return true;
        },

        async checkAutoBackup() {
            try {
                if (!this.getPref("autoBackupEnabled")) return;
                if (this._isArchive()) return;  // 只在主库执行定期备份
                var days = parseInt(this.getPref("autoBackupDays"), 10);
                if (!days || days < 1) days = 30;
                var hour = parseInt(this.getPref("autoBackupHour"), 10);
                if (isNaN(hour)) hour = 3;
                var now = new Date();
                if (now.getHours() < hour) return;
                var lastRun = String(this.getPref("autoBackupLastRun") || "");
                if (lastRun) {
                    var last = new Date(lastRun);
                    if (!isNaN(last.getTime())) {
                        var diffDays = (now.getTime() - last.getTime()) / 86400000;
                        if (diffDays < days) return;
                    }
                }
                await this.runAutoBackup();
            } catch (e) { /* ignore */ }
        },

        async runAutoBackup() {
            var d = new Date();
            var name = "备份 " + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
            var archives = await this._listArchives();
            if (archives.indexOf(name) !== -1) {
                this.setPref("autoBackupLastRun", new Date().toISOString());
                return;
            }
            var ok = await this._snapshotTo(name, true);
            if (ok) {
                this.setPref("autoBackupLastRun", new Date().toISOString());
            }
        },

        async archiveSelected() {
            var items = this._selectedTops();
            if (!items.length) {
                this._alert("没有选中的论文。");
                return;
            }
            var name = this._promptArchiveName();
            if (!name) return;
            // 先记录待标记的条目 key，快照完成后再标记（避免「已归档」标签进入归档库）
            var keys = [];
            for (var j = 0; j < items.length; j++) keys.push(items[j].key);
            await this._write(this._archiveRoot() + "/_pending_mark.json", JSON.stringify(keys));
            await this._write(this._archiveRoot() + "/_pending_prune.json", JSON.stringify(keys));
            var done = await this._snapshotTo(name);
            if (done) {
                this._alert("已归档 " + items.length + " 篇论文到「" + name + "」。\n\nZotero 将重启进入归档库并清理未选中的论文，之后自动标记「已归档」。");
            } else {
                try { await this._remove(this._archiveRoot() + "/_pending_mark.json"); } catch (e) { /* ignore */ }
                try { await this._remove(this._archiveRoot() + "/_pending_prune.json"); } catch (e) { /* ignore */ }
            }
        },

        async _applyPendingMark() {
            try {
                if (this._isArchive()) return;  // 只在主库标记
                var f = this._archiveRoot() + "/_pending_mark.json";
                if (!(await this._exists(f))) return;
                var raw = await this._read(f);
                var keys = JSON.parse(raw);
                if (!keys || !keys.length) {
                    await this._remove(f);
                    return;
                }
                var libID = Zotero.Libraries.userLibraryID;
                var all = await Zotero.Items.getAll(libID);
                if (!all.length) return;  // 库还没加载完，稍后重试
                var byKey = {};
                for (var i = 0; i < all.length; i++) byKey[all[i].key] = all[i];
                for (var j = 0; j < keys.length; j++) {
                    var it = byKey[keys[j]];
                    if (!it || it.hasTag(ARCHIVE_TAG)) continue;
                    await Zotero.DB.executeTransaction(async function () {
                        it.addTag(ARCHIVE_TAG, 0);
                        await it.save();
                    });
                }
                await this._remove(f);  // 标记成功后再删除，失败可重试
            } catch (e) {
                Zotero.debug("Zotero Archiver mark failed: " + e);
            }
        },

        async _applyPendingPrune() {
            try {
                if (!this._isArchive()) return;  // 只在归档库清理
                var f = this._archiveRoot() + "/_pending_prune.json";
                if (!(await this._exists(f))) return;
                var raw = await this._read(f);
                var keys = JSON.parse(raw);
                if (!keys || !keys.length) {
                    await this._remove(f);
                    return;
                }
                var keySet = {};
                for (var i = 0; i < keys.length; i++) keySet[keys[i]] = true;
                var libID = Zotero.Libraries.userLibraryID;
                var all = await Zotero.Items.getAll(libID);
                if (!all.length) return;  // 库还没加载完，稍后重试
                var ids = [];
                for (var j = 0; j < all.length; j++) {
                    if (this._isRegularTop(all[j]) && !keySet[all[j].key]) ids.push(all[j].id);
                }
                if (ids.length) {
                    await Zotero.Items.erase(ids);
                }
                await this._remove(f);  // 清理成功后再删除
            } catch (e) {
                Zotero.debug("Zotero Archiver prune failed: " + e);
            }
        },
        async eraseAllArchived() {
            var all = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
            var tagged = [];
            for (var i = 0; i < all.length; i++) {
                if (this._isRegularTop(all[i]) && all[i].hasTag(ARCHIVE_TAG)) tagged.push(all[i]);
            }
            if (!tagged.length) {
                this._alert("没有找到标记「已归档」的论文。");
                return;
            }
            var archives = await this._listArchives();
            if (!archives.length) {
                this._alert("还没有归档库，删除不安全。\n\n请先归档论文再删除。");
                return;
            }
            var msg = "⚠️ 将【彻底删除】主库中全部 " + tagged.length + " 篇已归档论文及其附件文件（不可恢复）。\n\n归档库中的副本不受影响。\n\n确定吗？";
            if (!this._confirm(msg)) return;
            await this._deleteLinkedFiles(tagged);
            var ids = [];
            for (var j = 0; j < tagged.length; j++) ids.push(tagged[j].id);
            await Zotero.Items.erase(ids);
            this._alert("已彻底删除 " + tagged.length + " 篇已归档论文及其附件。");
        },

        async _deleteLinkedFiles(items) {
            for (var i = 0; i < items.length; i++) {
                try {
                    // getAttachments() 返回的是条目 ID 而非对象，这里直接查附件表
                    var rows = await Zotero.DB.queryAsync(
                        "SELECT linkMode, path FROM itemAttachments WHERE parentItemID=?",
                        [items[i].id]
                    );
                    for (var a = 0; a < rows.length; a++) {
                        var r = rows[a];
                        if (r.linkMode === 2 && r.path && r.path.indexOf("attachments:") === 0) {
                            var rel = r.path.substring("attachments:".length);
                            var full = this._baseAttachmentDir() + "/" + rel;
                            if (await this._exists(full)) await this._remove(full);
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        },

        // ---------- 导出（用于恢复） ----------
        async _exportItems(items, filePath) {
            var translate = new Zotero.Translate.Export();
            translate.setItems(items);
            translate.setTranslator(RDF_TRANSLATOR);
            translate.setDisplayOptions({
                exportNotes: true,
                exportFileData: false
            });
            // Zotero 10 不支持「导出到文件」，先导出到字符串再自己写文件
            await translate.translate();
            var output = translate.string || "";
            await this._write(filePath, output);
        },

        async restoreToMain() {
            var items = this._selectedTops();
            if (!items.length) {
                this._alert("请先选择要恢复的论文。");
                return;
            }
            if (!this._isArchive()) {
                this._alert("「恢复到主库」请在归档库中使用。\n\n请先切换到归档库，选中论文后右键 → 恢复到主库。");
                return;
            }
            var archiveName = this._currentArchiveName();
            var base = this.getPref("restoreDir");
            var dir = base + "/restore-" + timestamp();

            try { await this._remove(dir); } catch (e) { /* 忽略 */ }
            await this._mkdir(dir);

            var manifest = [];
            var failed = 0;
            var baseAttach = norm(this._namedAttachDir(archiveName));
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                var file = dir + "/" + i + "-" + it.key + ".rdf";
                try {
                    await this._exportItems([it], file);
                    var atts = [];
                    try {
                        var dataDir = this._namedDataDir(archiveName);
                        var rows = await Zotero.DB.queryAsync(
                            "SELECT i.key, a.linkMode, a.contentType, a.path FROM itemAttachments a JOIN items i ON a.itemID=i.itemID WHERE a.parentItemID=?",
                            [it.id]
                        );
                        for (var a = 0; a < rows.length; a++) {
                            var r = rows[a];
                            var path = r.path || "";
                            var rel = "";
                            var full = "";
                            if (r.linkMode === 2 && path.indexOf("attachments:") === 0) {
                                rel = path.substring("attachments:".length);
                                full = baseAttach + "/" + rel;
                            } else if (path.indexOf("storage:") === 0) {
                                full = dataDir + "/storage/" + r.key + "/" + path.substring("storage:".length);
                            }
                            atts.push({
                                linkMode: r.linkMode,
                                contentType: r.contentType || "application/pdf",
                                path: full,
                                rel: rel
                            });
                        }
                    } catch (e) {
                        Zotero.debug("Zotero Archiver attachment query failed: " + e);
                    }
                    manifest.push({
                        file: file,
                        attachments: atts
                    });
                } catch (e) {
                    failed++;
                    Zotero.debug("Zotero Archiver export failed: " + e);
                }
            }
            await this._write(dir + "/manifest.json", JSON.stringify(manifest, null, 2));
            if (!manifest.length) {
                this._alert("导出失败，未能恢复任何论文。");
                return;
            }
            await this._write(this._archiveRoot() + "/_pending_restore.json",
                JSON.stringify({ manifestPath: dir + "/manifest.json", collectionName: archiveName || "归档恢复" }));
            this._runHelper("switch-main");
        },

        // ---------- 导入恢复 ----------
        async _importFile(filePath, libID) {
            var translate = new Zotero.Translate.Import();
            translate.setLocation(this._file(filePath));
            translate.setTranslator(RDF_IMPORT_TRANSLATOR);
            await translate.translate({ libraryID: libID });
        },

        async _doRestore(manifestPath, collectionName) {
            var manifestText;
            try {
                manifestText = await this._read(manifestPath);
            } catch (e) {
                this._alert("未找到恢复清单：\n" + manifestPath);
                return;
            }
            var manifest;
            try {
                manifest = JSON.parse(manifestText);
            } catch (e) {
                this._alert("恢复清单解析失败：" + e);
                return;
            }

            var libID = Zotero.Libraries.userLibraryID;

            // 记录导入前的条目 ID，用于前后对比识别新条目
            var existing = await Zotero.Items.getAll(libID);
            var before = {};
            for (var i = 0; i < existing.length; i++) before[existing[i].id] = true;

            // 逐个导入 RDF
            var imported = 0;
            for (var j = 0; j < manifest.length; j++) {
                try {
                    await this._importFile(manifest[j].file, libID);
                    imported++;
                } catch (e) {
                    Zotero.debug("Zotero Archiver import failed: " + e);
                }
            }

            // 前后对比识别新导入的顶层条目
            var addedIds = [];
            try {
                var after = await Zotero.Items.getAll(libID);
                for (var k = 0; k < after.length; k++) {
                    if (!before[after[k].id] && this._isRegularTop(after[k])) addedIds.push(after[k].id);
                }
            } catch (e) { /* ignore */ }

            // 恢复附件（按顺序对应 manifest 中的条目）
            for (var j = 0; j < manifest.length && j < addedIds.length; j++) {
                var m = manifest[j];
                if (m.attachments && m.attachments.length) {
                    var parent = Zotero.Items.get(addedIds[j]);
                    if (parent) {
                        for (var a = 0; a < m.attachments.length; a++) {
                            await this._restoreAttachment(parent, m.attachments[a], libID);
                        }
                    }
                }
            }

            // 归入「归档库名」集合
            var addedCount = 0;
            if (addedIds.length) {
                var collName = collectionName || "🗂️ 归档恢复";
                try {
                    var coll = null;
                    var colls = Zotero.Collections.getByLibrary(libID);
                    for (var c = 0; c < colls.length; c++) {
                        if (colls[c].name === collName) { coll = colls[c]; break; }
                    }
                    if (!coll) {
                        coll = new Zotero.Collection();
                        coll.name = collName;
                        coll.libraryID = libID;
                        await coll.saveTx();
                    }
                    var collID = coll.id;
                    for (var x = 0; x < addedIds.length; x++) {
                        await Zotero.DB.queryAsync(
                            "INSERT OR IGNORE INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)",
                            [collID, addedIds[x], x]
                        );
                    }
                    addedCount = addedIds.length;
                } catch (e) {
                    Zotero.debug("Zotero Archiver collection failed: " + e);
                }
            }

            var msg = "恢复完成：导入 " + imported + " 条";
            if (addedCount) msg += "。\n已归入集合「" + (collectionName || "🗂️ 归档恢复") + "」。";
            this._alert(msg);
        },

        async _restoreAttachment(parentItem, info, libID) {
            try {
                var src = info.path;
                if (!src || !(await this._exists(src))) return;
                if (info.linkMode === 2 && info.rel) {
                    // 链接附件：复制文件到主库链接目录
                    var dest = this._baseAttachmentDir() + "/" + info.rel;
                    await this._mkdir(dest.substring(0, dest.lastIndexOf("/")));
                    var bytes = await IOUtils.read(win(src));
                    await IOUtils.write(win(dest), bytes);
                    await Zotero.Attachments.linkFromFile({
                        file: this._file(dest),
                        parentItemID: parentItem.id,
                        contentType: info.contentType
                    });
                } else {
                    // 存储附件：导入文件到主库 storage
                    await Zotero.Attachments.importFromFile({
                        file: this._file(src),
                        libraryID: libID,
                        parentItemID: parentItem.id,
                        contentType: info.contentType
                    });
                }
            } catch (e) {
                Zotero.debug("Zotero Archiver restore attachment failed: " + e);
            }
        },

        async _applyPendingRestore() {
            try {
                var f = this._archiveRoot() + "/_pending_restore.json";
                if (!(await this._exists(f))) return;
                var raw = await this._read(f);
                await this._remove(f);
                if (this._isArchive()) return;  // 只在主库恢复
                var info = JSON.parse(raw);
                await this._doRestore(info.manifestPath, info.collectionName);
            } catch (e) { /* ignore */ }
        }
    };

    return API;
})();

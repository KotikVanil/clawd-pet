// Clawd Pet Setup: a self-extracting installer. The app files are a zip appended to this exe:
//   [setup.exe][payload.zip][u64 LE payload length][b"CPPAYLD1"]
// The same exe (without the payload) is left behind as uninstall.exe.
// Based on the WilliLoad installer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MAGIC: &[u8; 8] = b"CPPAYLD1";
const APP: &str = "Clawd Pet";
const DIR_NAME: &str = "ClawdPet";
const EXE: &str = "ClawdPet.exe";
const HOOK_EXE: &str = "clawd-hook.exe";
const LNK: &str = "Clawd Pet.lnk";
const MANIFEST: &str = "install-files.txt";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\ClawdPet";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "ClawdPet";
const DATA_ID: &str = "clawd-pet";
const SETUP_ID: &str = "dev.kotikvanil.clawdpet.setup";
const HOOK_MARKS: &[&str] = &["clawd-hook", "permission-hook.js"];
const NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------- payload access

struct Region {
    f: File,
    start: u64,
    len: u64,
    pos: u64,
}

impl Read for Region {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.len - self.pos.min(self.len);
        if left == 0 {
            return Ok(0);
        }
        let n = (buf.len() as u64).min(left) as usize;
        self.f.seek(SeekFrom::Start(self.start + self.pos))?;
        let r = self.f.read(&mut buf[..n])?;
        self.pos += r as u64;
        Ok(r)
    }
}

impl Seek for Region {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let p = match to {
            SeekFrom::Start(x) => x as i64,
            SeekFrom::End(x) => self.len as i64 + x,
            SeekFrom::Current(x) => self.pos as i64 + x,
        };
        if p < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = p as u64;
        Ok(self.pos)
    }
}

/// (exe path, payload start, payload length)
fn payload() -> Option<(PathBuf, u64, u64)> {
    let exe = std::env::current_exe().ok()?;
    let mut f = File::open(&exe).ok()?;
    let total = f.metadata().ok()?.len();
    if total < 16 {
        return None;
    }
    f.seek(SeekFrom::End(-16)).ok()?;
    let mut tail = [0u8; 16];
    f.read_exact(&mut tail).ok()?;
    if &tail[8..] != MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(tail[..8].try_into().ok()?);
    let start = total.checked_sub(16 + len)?;
    Some((exe, start, len))
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    cmd
}

fn is_locked(exe: &Path) -> bool {
    exe.exists() && OpenOptions::new().write(true).open(exe).is_err()
}

/// Close a running Clawd Pet so its files can be replaced or removed.
fn stop_pet(dir: &Path) -> Result<(), String> {
    let exe = dir.join(EXE);
    if !is_locked(&exe) {
        return Ok(());
    }
    let _ = hidden(Command::new("taskkill").args(["/F", "/IM", EXE])).status();
    for _ in 0..40 {
        if !is_locked(&exe) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Clawd Pet всё ещё запущен. Закройте его через значок в трее и нажмите «Повторить».".into())
}

fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}

fn reg_value(name: &str) -> Option<String> {
    hkcu().open_subkey(UNINSTALL_KEY).ok()?.get_value(name).ok()
}

fn start_menu(app: &AppHandle) -> Option<PathBuf> {
    app.path().data_dir().ok().map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs"))
}

fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().data_dir().ok().map(|d| d.join(DATA_ID).join("settings.json"))
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

// ---------------------------------------------------------------- info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    version: String,
    default_dir: String,
    installed_dir: Option<String>,
    installed_version: Option<String>,
    has_payload: bool,
    payload_size: u64,
    uninstall: bool,
    /// started by Clawd Pet itself with --update: install over the old copy without asking
    update: bool,
    has_desktop: bool,
    has_start: bool,
    autostart: bool,
    perms: bool,
    claude_found: bool,
    /// dev: CP_SETUP_VIEW=welcome|progress|done|uninstall|error renders one screen for a screenshot
    view: Option<String>,
}

#[tauri::command]
fn info(app: AppHandle) -> Info {
    let installed_dir = reg_value("InstallLocation").filter(|d| Path::new(d).join(EXE).is_file());
    let fallback = app
        .path()
        .local_data_dir()
        .map(|d| d.join("Programs").join(DIR_NAME).display().to_string())
        .unwrap_or_else(|_| format!(r"C:\{DIR_NAME}"));
    let p = payload();
    let settings = app_settings_path(&app).and_then(|p| read_json(&p));
    let run = hkcu().open_subkey(RUN_KEY).ok().and_then(|k| k.get_value::<String, _>(RUN_NAME).ok());
    let home = app.path().home_dir().ok();
    Info {
        version: VERSION.into(),
        default_dir: installed_dir.clone().unwrap_or(fallback),
        installed_version: installed_dir.as_ref().and_then(|_| reg_value("DisplayVersion")),
        installed_dir: installed_dir.clone(),
        has_payload: p.is_some(),
        payload_size: p.map(|x| x.2).unwrap_or(0),
        uninstall: std::env::args().any(|a| a == "--uninstall"),
        update: std::env::args().any(|a| a == "--update"),
        // fresh install: both shortcuts on; reinstall: keep what the user had
        has_desktop: installed_dir.is_none() || app.path().desktop_dir().map(|d| d.join(LNK).is_file()).unwrap_or(false),
        has_start: installed_dir.is_none() || start_menu(&app).map(|d| d.join(LNK).is_file()).unwrap_or(false),
        autostart: if installed_dir.is_some() { run.is_some() } else { true },
        perms: settings.as_ref().and_then(|s| s.get("perms")).and_then(Value::as_bool).unwrap_or(true),
        claude_found: home.map(|h| h.join(".claude").is_dir()).unwrap_or(false),
        view: std::env::var("CP_SETUP_VIEW").ok(),
    }
}

#[tauri::command]
async fn pick_dir(app: AppHandle, start: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file().set_title("Папка для Clawd Pet");
        if let Some(s) = start.as_ref().map(PathBuf::from).and_then(|p| p.parent().map(Path::to_path_buf)).filter(|p| p.is_dir()) {
            d = d.set_directory(s);
        }
        d.blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| if p.ends_with(DIR_NAME) { p } else { p.join(DIR_NAME) })
            .map(|p| p.display().to_string())
    })
    .await
    .ok()
    .flatten()
}

// ---------------------------------------------------------------- Claude Code hook

fn is_our_hook(h: &Value) -> bool {
    let cmd = h.get("command").and_then(Value::as_str).unwrap_or("");
    HOOK_MARKS.iter().any(|m| cmd.contains(m))
}

/// Point the PermissionRequest hook in ~/.claude/settings.json at `exe`, or remove ours when `exe` is None.
/// Other hooks and the key order of the file are kept.
fn set_hook(app: &AppHandle, exe: Option<&Path>) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let path = home.join(".claude").join("settings.json");
    let raw = fs::read_to_string(&path).unwrap_or_default();
    if exe.is_none() && !HOOK_MARKS.iter().any(|m| raw.contains(m)) {
        return Ok(());
    }
    let mut v: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|_| "Файл настроек Claude Code повреждён, хук не прописан".to_string())?
    };
    let obj = v.as_object_mut().ok_or("Неожиданный формат settings.json")?;
    let mut hooks = obj.get("hooks").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut kept: Vec<Value> = hooks
        .get("PermissionRequest")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut g| {
            if let Some(arr) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                arr.retain(|h| !is_our_hook(h));
                if arr.is_empty() {
                    return None;
                }
            }
            Some(g)
        })
        .collect();
    if let Some(exe) = exe {
        let cmd = format!("\"{}\"", exe.display().to_string().replace('\\', "/"));
        kept.push(json!({ "matcher": "*", "hooks": [{ "type": "command", "command": cmd, "timeout": 300 }] }));
    }
    if kept.is_empty() {
        hooks.shift_remove("PermissionRequest");
    } else {
        hooks.insert("PermissionRequest".into(), Value::Array(kept));
    }
    if hooks.is_empty() {
        obj.shift_remove("hooks");
    } else {
        obj.insert("hooks".into(), Value::Object(hooks));
    }
    let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())? + "\n";
    if out.trim() == raw.trim() {
        return Ok(());
    }
    let backup = path.with_file_name("settings.json.clawd-backup");
    if !raw.is_empty() && !backup.exists() {
        let _ = fs::write(&backup, &raw);
    }
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, out).map_err(|e| format!("settings.json: {e}"))
}

// ---------------------------------------------------------------- install

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opts {
    dir: String,
    desktop: bool,
    start_menu: bool,
    autostart: bool,
    perms: bool,
    #[serde(default)]
    skip_register: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Prog {
    done: u64,
    total: u64,
    file: String,
}

fn shortcut(lnk: &Path, target: &Path, workdir: &Path) -> Result<(), String> {
    let q = |p: &Path| p.display().to_string().replace('\'', "''");
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.IconLocation='{},0';$s.Description='Clawd Pet: питомец для Claude Code';$s.Save()",
        q(lnk), q(target), q(workdir), q(target)
    );
    let status = hidden(Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]))
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("ярлык {} не создан", lnk.display())) }
}

fn register(dir: &Path, size_kb: u64) -> io::Result<()> {
    let (k, _) = hkcu().create_subkey(UNINSTALL_KEY)?;
    k.set_value("DisplayName", &APP)?;
    k.set_value("DisplayVersion", &VERSION)?;
    k.set_value("Publisher", &"KotikVanil")?;
    k.set_value("URLInfoAbout", &"https://github.com/KotikVanil/clawd-pet")?;
    k.set_value("DisplayIcon", &dir.join(EXE).display().to_string())?;
    k.set_value("InstallLocation", &dir.display().to_string())?;
    k.set_value("UninstallString", &format!("\"{}\" --uninstall", dir.join("uninstall.exe").display()))?;
    k.set_value("EstimatedSize", &(size_kb.min(u32::MAX as u64) as u32))?;
    k.set_value("NoModify", &1u32)?;
    k.set_value("NoRepair", &1u32)?;
    Ok(())
}

fn set_autostart(exe: Option<&Path>) -> io::Result<()> {
    let (k, _) = hkcu().create_subkey(RUN_KEY)?;
    match exe {
        // same format Electron's app.setLoginItemSettings writes, so the tray checkbox agrees
        Some(e) => k.set_value(RUN_NAME, &format!("\"{}\"", e.display())),
        None => match k.delete_value(RUN_NAME) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

/// The app reads these on start (autostart, permissions through Clawd).
fn write_app_settings(app: &AppHandle, opts: &Opts) -> Result<(), String> {
    let Some(path) = app_settings_path(app) else { return Ok(()) };
    let mut v = read_json(&path).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["autostart"] = json!(opts.autostart);
    v["perms"] = json!(opts.perms);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())
}

fn do_install(app: &AppHandle, opts: &Opts, progress: &dyn Fn(Prog)) -> Result<(), String> {
    let (exe, start, len) = payload().ok_or("В установщике нет файлов программы")?;
    let dir = PathBuf::from(&opts.dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать папку: {e}"))?;
    if !opts.skip_register {
        stop_pet(&dir)?;
    }

    let region = Region { f: File::open(&exe).map_err(|e| e.to_string())?, start, len, pos: 0 };
    let mut zip = zip::ZipArchive::new(BufReader::with_capacity(1 << 20, region)).map_err(|e| format!("Архив повреждён: {e}"))?;
    let total: u64 = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|f| f.size())).sum();
    let mut done = 0u64;
    let mut last = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    let mut manifest = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dir.join(&rel);
        if entry.is_dir() {
            let _ = fs::create_dir_all(&out);
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let name = rel.display().to_string();
        let mut w = File::create(&out).map_err(|e| format!("{name}: {e}"))?;
        loop {
            let n = entry.read(&mut buf).map_err(|e| format!("{name}: {e}"))?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n]).map_err(|e| format!("{name}: {e}"))?;
            done += n as u64;
            if done - last > (1 << 20) {
                last = done;
                progress(Prog { done, total, file: name.clone() });
            }
        }
        manifest.push(name);
    }
    progress(Prog { done: total, total, file: "Ярлыки и настройки".into() });
    manifest.push("uninstall.exe".into());
    fs::write(dir.join(MANIFEST), manifest.join("\n")).map_err(|e| e.to_string())?;

    // uninstaller: this very exe, cut before the payload
    let mut src = File::open(&exe).map_err(|e| e.to_string())?;
    let mut dst = File::create(dir.join("uninstall.exe")).map_err(|e| format!("uninstall.exe: {e}"))?;
    io::copy(&mut (&mut src).take(start), &mut dst).map_err(|e| e.to_string())?;

    if opts.skip_register {
        return Ok(());
    }
    let target = dir.join(EXE);
    if let Ok(desk) = app.path().desktop_dir() {
        if opts.desktop {
            shortcut(&desk.join(LNK), &target, &dir)?;
        } else {
            let _ = fs::remove_file(desk.join(LNK));
        }
    }
    if let Some(sm) = start_menu(app) {
        if opts.start_menu {
            let _ = fs::create_dir_all(&sm);
            shortcut(&sm.join(LNK), &target, &dir)?;
        } else {
            let _ = fs::remove_file(sm.join(LNK));
        }
    }
    set_autostart(opts.autostart.then_some(target.as_path())).map_err(|e| format!("Автозапуск: {e}"))?;
    write_app_settings(app, opts)?;
    let hook = dir.join(HOOK_EXE);
    set_hook(app, (opts.perms && hook.is_file()).then_some(hook.as_path()))?;
    register(&dir, total / 1024).map_err(|e| format!("Запись в реестр: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn install(app: AppHandle, opts: Opts, on_progress: Channel<Prog>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        do_install(&app, &opts, &|p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn launch(dir: String) -> Result<(), String> {
    let d = PathBuf::from(dir);
    Command::new(d.join(EXE)).current_dir(&d).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- uninstall

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnOpts {
    remove_data: bool,
}

fn install_dir() -> Option<PathBuf> {
    reg_value("InstallLocation")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)))
}

fn do_uninstall(app: &AppHandle, opts: &UnOpts) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = install_dir().ok_or("Не найдена папка Clawd Pet")?;
    stop_pet(&dir)?;
    if let Ok(desk) = app.path().desktop_dir() {
        let _ = fs::remove_file(desk.join(LNK));
    }
    if let Some(sm) = start_menu(app) {
        let _ = fs::remove_file(sm.join(LNK));
    }
    let _ = set_autostart(None);
    let _ = set_hook(app, None);

    // only touch what we installed: the files listed in the manifest
    let list = fs::read_to_string(dir.join(MANIFEST)).unwrap_or_default();
    let mut dirs = Vec::new();
    for rel in list.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains("..")) {
        let p = dir.join(rel);
        if p == me {
            continue;
        }
        let _ = fs::remove_file(&p);
        let mut parent = p.parent();
        while let Some(d) = parent.filter(|d| *d != dir.as_path() && d.starts_with(&dir)) {
            dirs.push(d.to_path_buf());
            parent = d.parent();
        }
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    dirs.dedup();
    for d in dirs {
        let _ = fs::remove_dir(d);
    }
    let _ = fs::remove_file(dir.join(MANIFEST));
    if me.parent() != Some(dir.as_path()) {
        let _ = fs::remove_file(dir.join("uninstall.exe"));
    }
    let _ = hkcu().delete_subkey_all(UNINSTALL_KEY);

    if let Ok(home) = app.path().home_dir() {
        let _ = fs::remove_file(home.join(".clawd-pet").join("endpoint.json"));
        if opts.remove_data {
            let _ = fs::remove_dir_all(home.join(".clawd-pet"));
        }
    }
    if opts.remove_data {
        if let Ok(d) = app.path().data_dir() {
            let _ = fs::remove_dir_all(d.join(DATA_ID));
        }
    }
    Ok(())
}

#[tauri::command]
async fn uninstall(app: AppHandle, opts: UnOpts) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_uninstall(&app, &opts))
        .await
        .map_err(|e| e.to_string())?
}

/// After the window closes: delete uninstall.exe, the (now empty) folder and the setup's WebView cache.
#[tauri::command]
fn schedule_cleanup(app: AppHandle) {
    let Ok(me) = std::env::current_exe() else { return };
    let dir = me.parent().map(Path::to_path_buf).unwrap_or_default();
    let webview = app.path().local_data_dir().map(|d| d.join(SETUP_ID)).unwrap_or_default();
    let script = format!(
        "ping 127.0.0.1 -n 3 >nul & del /f /q \"{}\" & rmdir \"{}\" & rmdir /s /q \"{}\"",
        me.display(),
        dir.display(),
        webview.display()
    );
    let _ = hidden(Command::new("cmd").args(["/c", &script])).spawn();
}

#[tauri::command]
fn open_url(url: String) {
    if url.starts_with("https://github.com/") {
        let _ = hidden(Command::new("cmd").args(["/c", "start", "", &url])).spawn();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // dev: CP_SETUP_SMOKE=<dir> extracts the payload there (no shortcuts, registry, hook) and quits
            if let Ok(dir) = std::env::var("CP_SETUP_SMOKE") {
                thread::spawn(move || {
                    let opts = Opts { dir, desktop: false, start_menu: false, autostart: false, perms: false, skip_register: true };
                    let last = std::sync::Mutex::new(0u64);
                    let r = do_install(&handle, &opts, &|p| *last.lock().unwrap() = p.done);
                    let mut log = format!("smoke: {:?}, bytes {}\n", r, last.lock().unwrap());
                    if let Ok(rd) = fs::read_dir(&opts.dir) {
                        for e in rd.flatten() {
                            log.push_str(&format!("  {}\n", e.file_name().to_string_lossy()));
                        }
                    }
                    let _ = fs::write(Path::new(&opts.dir).join("smoke.txt"), log);
                    handle.exit(0);
                });
            } else if let Some(secs) = std::env::var("CP_SETUP_EXIT").ok().and_then(|s| s.parse::<u64>().ok()) {
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(secs));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![info, pick_dir, install, launch, uninstall, schedule_cleanup, open_url])
        .run(tauri::generate_context!())
        .expect("failed to start Clawd Pet Setup");
}

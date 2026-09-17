//! Rust 侧只做三件本机特权动作：
//!   1. 保证本机有一个能连的 core daemon（连不上就自己拉起来，退出时只收自己拉起的那个）；
//!   2. 选目录对话框（由 dialog 插件提供，前端直接用，这里只声明权限）；
//!   3. 读本机 git 状态（仓库行与底部状态条要分支名与改动行数）。
//!      **只读**：`git status --porcelain` 与 `git diff --numstat`，一个写操作都没有。
//!      不是 git 仓库、或没装 git，就返回 `None`——前端按"整行不渲染"处理，不显示"无仓库"。
//!
//! 别的一律不做。壳与 core 之间只有一种传输：127.0.0.1 的 WebSocket，
//! 这样 Web 与 Android 端零改造。

use std::ffi::OsString;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, State};

/// core 的默认 WebSocket 端口（PROTOCOL.md §1）。`PULPO_WS_PORT` 可覆盖。
const DEFAULT_WS_PORT: u16 = 27183;

/// 我们自己拉起来的 daemon。**用户自己起的那个不在这里**——退出时只收这一个。
#[derive(Default)]
struct SpawnedCore(Mutex<Option<Child>>);

#[derive(serde::Serialize, Clone)]
struct CoreStatus {
    /// core 的 WebSocket 地址，前端拿它建连接
    url: String,
    port: u16,
    /// true = 这个 daemon 是壳拉起来的；false = 本来就有一个在跑
    spawned_by_shell: bool,
    /// 没连上时说明原因，不静默
    error: Option<String>,
}

fn ws_port() -> u16 {
    std::env::var("PULPO_WS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_WS_PORT)
}

/// GUI 启动的 app（Finder / Dock / `open`）**不继承登录 shell 的 PATH**——macOS 给的是
/// `/usr/bin:/bin:/usr/sbin:/sbin`。而 `bin/pulpo-core` 的 shebang 是 `#!/usr/bin/env node`，
/// 所以「自己拉一个 core」这件事在打包安装后必然失败（`env: node: No such file or directory`）。
/// 从终端跑 `tauri dev` 时 PATH 里有 node，因此开发期看不出这个问题。这里自己找。
///
/// 顺序：`PULPO_NODE_BIN`（直接给 node 可执行文件）> 常见前缀 >
/// `~/.nvm/versions/node/<ver>/bin`（版本号最大的优先）> 其它版本管理器。
fn node_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os("PULPO_NODE_BIN") {
        out.push(PathBuf::from(explicit));
    }
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        out.push(PathBuf::from(prefix).join("node"));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // nvm：一个版本一个目录，按版本号从大到小排
        let nvm = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|dir| dir.join("bin/node").is_file())
                .collect();
            versions.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
            out.extend(versions.into_iter().map(|dir| dir.join("bin/node")));
        }
        for other in [
            ".volta/bin/node",
            ".local/share/fnm/aliases/default/bin/node",
            ".asdf/shims/node",
        ] {
            out.push(home.join(other));
        }
    }
    out
}

/// 版本目录名的数字段，用来排序 `v24.11.1` / `9.1.0` 这种（按数字比，不按字典序——
/// 字典序下 `v9` 会赢过 `v24`）。
fn version_key(dir: &Path) -> Vec<u32> {
    dir.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.trim_start_matches('v')
                .split('.')
                .map(|part| part.parse::<u32>().unwrap_or(0))
                .collect()
        })
        .unwrap_or_default()
}

fn find_node() -> Option<PathBuf> {
    node_candidates().into_iter().find(|path| path.is_file())
}

/// 交给 core 子进程的 PATH：node 所在目录排最前，再补系统标准目录，最后接上继承来的 PATH。
///
/// 为什么必须补全：这条 PATH 会被 core 继续往下传——ZCode 引擎、以及引擎再拉起的
/// companion（`#!/usr/bin/env node`）都靠它找 node，`zcode-acp`（`#!/usr/bin/env python3`）
/// 靠它找 `/usr/bin/python3`。
fn child_path(node: Option<&Path>) -> OsString {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node.and_then(Path::parent) {
        parts.push(dir.to_path_buf());
    }
    for dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        parts.push(PathBuf::from(dir));
    }
    if let Some(inherited) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&inherited));
    }
    std::env::join_paths(parts).unwrap_or_default()
}

fn port_is_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// daemon 可执行文件的位置。
///
/// 优先级：`PULPO_CORE_BIN` > app 资源目录（打包安装）> 从 `src-tauri` 往上找到的仓库根
/// （开发期，`tauri dev` / 仓库里直接跑）。
///
/// 资源布局由 `scripts/bundle-runtime.mjs` 决定：`Contents/Resources/packages/…`，
/// 与仓库里的 `packages/…` **同形**——这样 core 自己的 `packageRoot()` / `packagesRoot()`
/// 照常解析得到 adapter 与 companion，一个环境变量都不用给。两种前缀都试，是为了
/// 容错 Tauri 资源映射把目录多套一层的情况。
fn locate_core(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("PULPO_CORE_BIN") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    for bundled in [
        "packages/core/bin/pulpo-core",
        "runtime/packages/core/bin/pulpo-core",
    ] {
        if let Ok(resource) = app
            .path()
            .resolve(bundled, tauri::path::BaseDirectory::Resource)
        {
            if resource.exists() {
                return Some(resource);
            }
        }
    }
    // 开发期：从 src-tauri 往上找到仓库根
    let mut dir: Option<&Path> = Some(Path::new(env!("CARGO_MANIFEST_DIR")));
    while let Some(current) = dir {
        let candidate = current.join("packages/core/bin/pulpo-core");
        if candidate.exists() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

fn wait_until_open(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_is_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

#[derive(serde::Serialize, Clone)]
struct GitStatus {
    branch: Option<String>,
    added: u32,
    removed: u32,
    /// 有多少个文件处于未提交状态（含未跟踪）
    dirty_files: u32,
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(cwd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// 本机 git 状态。只读，失败一律返回 None（不是 git 仓库是最常见的情况，不当错误报）。
#[tauri::command]
fn git_status(cwd: String) -> Option<GitStatus> {
    let inside = git(&cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return None;
    }
    let branch = git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|b| b.trim().to_string());
    let mut added = 0u32;
    let mut removed = 0u32;
    if let Some(numstat) = git(&cwd, &["diff", "HEAD", "--numstat"]) {
        for line in numstat.lines() {
            let mut parts = line.split_whitespace();
            added += parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
            removed += parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        }
    }
    let dirty_files = git(&cwd, &["status", "--porcelain"])
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);
    Some(GitStatus { branch, added, removed, dirty_files })
}

/// 保证本机有个能连的 core。已经有就直接用（**不抢、不杀**），没有才拉一个。
#[tauri::command]
fn ensure_core(app: tauri::AppHandle, state: State<'_, SpawnedCore>) -> CoreStatus {
    let port = ws_port();
    let url = format!("ws://127.0.0.1:{port}");

    if port_is_open(port) {
        return CoreStatus { url, port, spawned_by_shell: false, error: None };
    }
    if state.0.lock().expect("core 进程锁被污染").is_some() {
        // 我们已经拉过一个，但端口还没起来——再等等它
        let ok = wait_until_open(port, Duration::from_secs(10));
        return CoreStatus {
            url,
            port,
            spawned_by_shell: true,
            error: if ok { None } else { Some("已拉起 pulpo-core，但端口迟迟没监听".into()) },
        };
    }

    let Some(binary) = locate_core(&app) else {
        return CoreStatus {
            url,
            port,
            spawned_by_shell: false,
            error: Some(
                "找不到 pulpo-core 可执行文件。开发期请在仓库里构建 packages/core，\
                 或用 PULPO_CORE_BIN 指定路径。"
                    .into(),
            ),
        };
    };

    // 走 `node <bin>` 而不是直接执行 bin：直接执行要靠 shebang 里的 `env node` 去 PATH 里
    // 找 node，而 GUI 启动时 PATH 里没有（见 node_candidates 的注释）。
    let node = find_node();
    let mut command = match &node {
        Some(node) => {
            let mut c = Command::new(node);
            c.arg(&binary);
            c
        }
        None => Command::new(&binary),
    };
    command.env("PATH", child_path(node.as_deref()));

    match command.spawn() {
        Ok(child) => {
            *state.0.lock().expect("core 进程锁被污染") = Some(child);
            let ok = wait_until_open(port, Duration::from_secs(15));
            CoreStatus {
                url,
                port,
                spawned_by_shell: true,
                error: if ok {
                    None
                } else {
                    Some(format!("已启动 {}，但 15 秒内端口没起来", binary.display()))
                },
            }
        }
        Err(err) => CoreStatus {
            url,
            port,
            spawned_by_shell: false,
            error: Some(match &node {
                Some(node) => format!(
                    "启动 {} 失败：{err}（用的 node 是 {}）",
                    binary.display(),
                    node.display()
                ),
                None => format!(
                    "启动 {} 失败：{err}。本机没找到 node——装一个，或用 PULPO_NODE_BIN 指定。",
                    binary.display()
                ),
            }),
        },
    }
}

/// 收掉我们自己拉起来的那个 daemon。用户自己起的不在 `SpawnedCore` 里，动不到。
fn reap_spawned_core(app: &tauri::AppHandle) {
    let state: State<'_, SpawnedCore> = app.state();
    // 先把 Child 取出来再 kill（MutexGuard 在这一句结束就释放）
    let spawned = state.0.lock().expect("core 进程锁被污染").take();
    if let Some(mut child) = spawned {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SpawnedCore::default())
        .invoke_handler(tauri::generate_handler![ensure_core, git_status])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败");

    // 必须挂在 RunEvent::Exit 上：实测关窗口的 WindowEvent::Destroyed 在
    // ⌘Q / `quit` 这条路径上跑不到，daemon 会活过壳（实测残留 pid 仍在监听 27183）。
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            reap_spawned_core(handle);
        }
    });
}

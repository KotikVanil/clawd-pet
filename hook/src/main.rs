// Claude Code PermissionRequest hook for Clawd Pet.
//
// Claude Code runs this with the permission request as JSON on stdin. We pass
// it to the running pet over 127.0.0.1 (port and token from
// ~/.clawd-pet/endpoint.json) and wait until a button on the bubble is clicked.
// If the pet isn't running, the user doesn't answer in time, or anything goes
// wrong, we print nothing and exit 0: Claude then shows its normal dialog.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(130);
const PASS_THROUGH: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

fn endpoint() -> Option<(u16, String)> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let path = PathBuf::from(home).join(".clawd-pet").join("endpoint.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let token = v.get("token")?.as_str()?.to_string();
    Some((port, token))
}

fn ask(port: u16, token: &str, body: &str) -> Option<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(WAIT)).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    let req = format!(
        "POST /permission HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Clawd-Token: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        token,
        body
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).ok()?;
    let text = String::from_utf8_lossy(&resp);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    serde_json::from_str(body.trim()).ok()
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let input = input.trim_start_matches('\u{feff}').trim();
    let Ok(req) = serde_json::from_str::<Value>(input) else { return };
    let tool = req.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if PASS_THROUGH.contains(&tool) {
        return;
    }
    let Some((port, token)) = endpoint() else { return };
    let Some(answer) = ask(port, &token, input) else { return };

    let behavior = answer.get("behavior").and_then(Value::as_str).unwrap_or("");
    let mut decision = match behavior {
        "allow" => json!({ "behavior": "allow" }),
        "deny" => json!({ "behavior": "deny", "message": "Пользователь отклонил это через Clawd Pet." }),
        _ => return,
    };
    if behavior == "allow" {
        if let Some(p) = answer.get("updatedPermissions").filter(|p| p.as_array().is_some_and(|a| !a.is_empty())) {
            decision["updatedPermissions"] = p.clone();
        }
    }
    let out = json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } });
    print!("{out}");
}

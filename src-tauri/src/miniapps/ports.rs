//! Port Killer: which process is listening on which TCP port, and stop it.
//!
//! Safety: the UI can only ask to stop "the process listening on port P with PID X";
//! that pair is re-checked against the live port table right before stopping, so a
//! stale or crafted request can't end an arbitrary process. Windows' own processes
//! (anything running from the Windows folder, PID 0/4) and Fyn itself are never stopped.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr};

use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;

/// One listening socket from the OS table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub port: u16,
    pub pid: u32,
    pub address: String,
}

/// The port number in a MIB row: network byte order in the low 16 bits.
fn row_port(raw: u32) -> u16 {
    u16::from_be((raw & 0xFFFF) as u16)
}

/// Read a GetExtendedTcpTable table (v4 or v6): a u32 count followed by rows.
fn read_table<Row: Copy>(family: u32) -> Vec<Row> {
    let mut size = 0u32;
    // First call asks for the size; retry if it grows in between.
    for _ in 0..4 {
        let mut buf = vec![0u8; size as usize];
        let ptr = if buf.is_empty() { None } else { Some(buf.as_mut_ptr() as *mut _) };
        let rc = unsafe { GetExtendedTcpTable(ptr, &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) };
        if rc == ERROR_INSUFFICIENT_BUFFER.0 {
            continue;
        }
        if rc != NO_ERROR.0 || buf.len() < 4 {
            return Vec::new();
        }
        let count = u32::from_ne_bytes(buf[..4].try_into().unwrap()) as usize;
        // Rows start after the count, at the row type's alignment.
        let offset = std::mem::align_of::<Row>().max(4);
        let needed = offset + count * std::mem::size_of::<Row>();
        if buf.len() < needed {
            return Vec::new();
        }
        return (0..count)
            .map(|i| unsafe { std::ptr::read_unaligned(buf.as_ptr().add(offset + i * std::mem::size_of::<Row>()) as *const Row) })
            .collect();
    }
    Vec::new()
}

/// Every listening TCP socket (IPv4 and IPv6).
pub fn listeners() -> Vec<Listener> {
    let v4 = read_table::<MIB_TCPROW_OWNER_PID>(AF_INET).into_iter().map(|r| Listener {
        port: row_port(r.dwLocalPort),
        pid: r.dwOwningPid,
        address: Ipv4Addr::from(u32::from_be(r.dwLocalAddr)).to_string(),
    });
    let v6 = read_table::<MIB_TCP6ROW_OWNER_PID>(AF_INET6).into_iter().map(|r| Listener {
        port: row_port(r.dwLocalPort),
        pid: r.dwOwningPid,
        address: Ipv6Addr::from(r.ucLocalAddr).to_string(),
    });
    v4.chain(v6).collect()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub port: u16,
    pub pid: u32,
    /// "node", "postgres", … (or "PID 1234" if Windows won't say).
    pub name: String,
    pub path: Option<String>,
    /// e.g. ["127.0.0.1", "::1"]
    pub addresses: Vec<String>,
    /// Can't be stopped from Fyn (Windows itself, or Fyn).
    pub protected: bool,
    pub icon: Option<String>,
}

/// A process we must never stop: the System Idle/System pseudo-processes, Fyn itself,
/// and anything running from the Windows folder (services, drivers' helpers, …).
pub fn is_protected(pid: u32, path: Option<&str>, own_pid: u32, windows_dir: &str) -> bool {
    if pid == 0 || pid == 4 || pid == own_pid {
        return true;
    }
    match path {
        // Unreadable path: almost always a protected system process.
        None => true,
        Some(p) => {
            let p = p.to_lowercase();
            let win = format!("{}\\", windows_dir.trim_end_matches('\\').to_lowercase());
            p.starts_with(&win)
        }
    }
}

fn windows_dir() -> String {
    std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
}

/// Group sockets by (port, process), with names, paths and protection worked out.
pub fn group(
    listeners: &[Listener],
    path_of: impl Fn(u32) -> Option<String>,
    icon_of: impl Fn(&str) -> Option<String>,
    own_pid: u32,
    windows_dir: &str,
) -> Vec<PortEntry> {
    let mut by_key: BTreeMap<(u16, u32), Vec<String>> = BTreeMap::new();
    for l in listeners {
        let addrs = by_key.entry((l.port, l.pid)).or_default();
        if !addrs.contains(&l.address) {
            addrs.push(l.address.clone());
        }
    }
    by_key
        .into_iter()
        .map(|((port, pid), addresses)| {
            let path = if pid == 4 { None } else { path_of(pid) };
            let exe = path.as_deref().and_then(|p| p.rsplit(['\\', '/']).next()).map(str::to_lowercase);
            let name = match (pid, &exe) {
                (4, _) => "System".to_string(),
                (_, Some(e)) => e.trim_end_matches(".exe").to_string(),
                _ => format!("PID {pid}"),
            };
            PortEntry {
                port,
                pid,
                protected: is_protected(pid, path.as_deref(), own_pid, windows_dir),
                icon: exe.as_deref().and_then(&icon_of),
                name,
                path,
                addresses,
            }
        })
        .collect()
}

pub fn list(icon_of: impl Fn(&str) -> Option<String>) -> Vec<PortEntry> {
    group(&listeners(), crate::clipboard::process_path, icon_of, std::process::id(), &windows_dir())
}

/// Stop the process listening on `port`, but only if `pid` really is (right now) the
/// process listening there, and it isn't protected.
pub fn kill(port: u16, pid: u32) -> Result<String, String> {
    let live = listeners();
    if !live.iter().any(|l| l.port == port && l.pid == pid) {
        return Err(format!("Nothing with that ID is listening on port {port} any more"));
    }
    let path = crate::clipboard::process_path(pid);
    let name = path
        .as_deref()
        .and_then(|p| p.rsplit(['\\', '/']).next())
        .map(|f| f.trim_end_matches(".exe").to_string())
        .unwrap_or_else(|| format!("PID {pid}"));
    if is_protected(pid, path.as_deref(), std::process::id(), &windows_dir()) {
        return Err(format!("{name} is part of Windows and can't be stopped from Fyn"));
    }
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid)
            .map_err(|_| format!("{name} is running as administrator. Stop it from an elevated terminal"))?;
        let result = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        result.map_err(|e| format!("Couldn't stop {name}: {e}"))?;
    }
    Ok(format!("Stopped {name} (port {port} is free)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_are_read_in_network_byte_order() {
        // 3000 = 0x0BB8 is stored as bytes B8 0B -> raw low word 0xB80B on little-endian.
        assert_eq!(row_port(u32::from(u16::to_be(3000))), 3000);
        assert_eq!(row_port(u32::from(u16::to_be(443)) | 0xABCD_0000), 443, "high bits are ignored");
    }

    #[test]
    fn windows_processes_fyn_and_unreadable_ones_are_protected() {
        let win = r"C:\Windows";
        assert!(is_protected(0, None, 99, win));
        assert!(is_protected(4, Some("x"), 99, win));
        assert!(is_protected(99, Some(r"C:\Program Files\Fyn\fyn.exe"), 99, win), "Fyn itself");
        assert!(is_protected(1234, Some(r"C:\WINDOWS\system32\svchost.exe"), 99, win));
        assert!(is_protected(1234, None, 99, win), "unreadable = system");
        assert!(!is_protected(1234, Some(r"C:\Program Files\nodejs\node.exe"), 99, win));
        assert!(!is_protected(1234, Some(r"C:\WindowsApps\thing.exe"), 99, win), "only the Windows folder itself");
    }

    #[test]
    fn sockets_are_grouped_by_port_and_process() {
        let l = |port, pid, address: &str| Listener { port, pid, address: address.into() };
        let listeners = [
            l(5432, 300, "127.0.0.1"),
            l(3000, 200, "0.0.0.0"),
            l(3000, 200, "::"),
            l(3000, 200, "::"), // duplicate
            l(135, 900, "0.0.0.0"),
            l(445, 4, "0.0.0.0"),
        ];
        let paths = |pid: u32| match pid {
            200 => Some(r"C:\Program Files\nodejs\node.exe".to_string()),
            300 => Some(r"C:\Program Files\PostgreSQL\16\bin\postgres.exe".to_string()),
            900 => Some(r"C:\Windows\System32\svchost.exe".to_string()),
            _ => None,
        };
        let icons = |exe: &str| (exe == "node.exe").then(|| "node.png".to_string());
        let entries = group(&listeners, paths, icons, 1, r"C:\Windows");

        assert_eq!(entries.iter().map(|e| e.port).collect::<Vec<_>>(), vec![135, 445, 3000, 5432], "sorted by port");
        let node = entries.iter().find(|e| e.port == 3000).unwrap();
        assert_eq!(node.name, "node");
        assert_eq!(node.addresses, vec!["0.0.0.0", "::"]);
        assert_eq!(node.icon.as_deref(), Some("node.png"));
        assert!(!node.protected);
        assert!(entries.iter().find(|e| e.port == 135).unwrap().protected, "svchost");
        let system = entries.iter().find(|e| e.port == 445).unwrap();
        assert_eq!(system.name, "System");
        assert!(system.protected);
    }

    #[test]
    fn this_pc_has_a_readable_port_table() {
        // Smoke test against the real OS table: it must parse without panicking, and
        // every row must have a port.
        for l in listeners() {
            assert!(l.port > 0, "{l:?}");
        }
    }

    #[test]
    fn a_port_and_pid_that_dont_match_are_refused() {
        // PID 1 never listens; this must be refused before anything is stopped.
        assert!(kill(1, 1).is_err());
    }
}

//! Packaged (Store / MSIX) app discovery via the `shell:AppsFolder` virtual folder.

use windows::core::PWSTR;
use windows::Win32::Foundation::S_OK;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, SHGetKnownFolderItem,
    KF_FLAG_DEFAULT, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};

use super::{App, AppKind};
use crate::win::ComGuard;

pub fn scan() -> Vec<App> {
    let _com = ComGuard::new();
    unsafe { scan_inner() }.unwrap_or_default()
}

unsafe fn scan_inner() -> windows::core::Result<Vec<App>> {
    let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
    let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;

    let mut apps = Vec::new();
    loop {
        let mut slot: [Option<IShellItem>; 1] = [None];
        let mut fetched = 0u32;
        if items.Next(&mut slot, Some(&mut fetched)) != S_OK || fetched == 0 {
            break;
        }
        let Some(item) = slot[0].take() else { break };

        // Packaged apps are identified by "PackageFamilyName!AppId".
        // Everything else in AppsFolder is already covered by Start Menu shortcuts.
        let Some(aumid) = display_name(&item, SIGDN_PARENTRELATIVEPARSING) else { continue };
        if !aumid.contains('!') || aumid.contains('\\') {
            continue;
        }
        let Some(name) = display_name(&item, SIGDN_NORMALDISPLAY) else { continue };
        if name.trim().is_empty() {
            continue;
        }

        apps.push(App {
            id: format!("aumid:{}", aumid.to_lowercase()),
            name: name.trim().to_string(),
            kind: AppKind::Store,
            launch: format!(r"shell:AppsFolder\{aumid}"),
            target: None,
            icon: None,
            stamp: 0,
        });
    }
    Ok(apps)
}

fn display_name(item: &IShellItem, sigdn: SIGDN) -> Option<String> {
    unsafe {
        let raw: PWSTR = item.GetDisplayName(sigdn).ok()?;
        let s = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        s
    }
}

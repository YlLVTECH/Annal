; Custom NSIS installer hooks for Annal.
; Included by tauri-bundler when bundle.windows.nsis.installerHooks is set.
; Macro names must match the tauri NSIS template guards (!ifmacrodef).

!macro NSIS_HOOK_POSTINSTALL
  ; SHCNE_ASSOCCHANGED: tell Explorer that file associations and their icons
  ; changed, so .md files show the new icon right after upgrading.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ; Flush the per-user icon cache so shortcuts pick up a changed exe icon
  ; without a manual cache refresh or reboot.
  ExecWait 'ie4uinit.exe -show'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Associations were removed: refresh shell icons so .md files fall back
  ; to the default icon immediately instead of showing a stale one.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

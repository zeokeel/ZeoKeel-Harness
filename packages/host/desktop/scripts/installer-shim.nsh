; ZeoKeel Harness — installer compatibility shim (electron-builder include).
;
; Why this exists (2026-10-21 packaging review):
; the 2.8.x installers were assisted installers that allowed an all-users
; (per-machine) installation. The one-click installer only looks at HKCU, so an
; update over a legacy per-machine install would silently create a *second* copy
; under %LOCALAPPDATA%: the old uninstaller is never called, both entries show
; up in Apps, and the newly started process loses the single-instance race
; against the still-running old version — an update that "does nothing".
;
; Detecting the legacy layout and stopping with a visible message is the honest
; option: removing a Program Files installation needs elevation, which a
; per-user installer must not request. Operators can also read the diagnostic
; file written below.

!macro customInit
  ReadRegStr $0 HKLM "Software\${APP_GUID}" "InstallLocation"
  StrCmp $0 "" zk_no_legacy_install

  StrCpy $1 "$TEMP\zeokeel-harness-legacy-install.txt"
  FileOpen $2 "$1" w
  FileWrite $2 "ZeoKeel Harness found a legacy all-users installation:$\r$\n"
  FileWrite $2 "$0$\r$\n"
  FileWrite $2 "Uninstall it first (Settings > Apps), then run this installer again.$\r$\n"
  FileClose $2

  MessageBox MB_ICONEXCLAMATION|MB_OK \
    "检测到旧的「所有用户」安装：$\r$\n$0$\r$\n$\r$\n请先到「设置 > 应用」卸载旧版本，再重新运行安装/更新。$\r$\n（诊断记录：$1）"

  Quit

  zk_no_legacy_install:
!macroend

; ZeoKeel Harness — installer compatibility shim (electron-builder include).
;
; Why this exists:
; the 2.8.x line was an assisted installer that allowed an all-users
; (per-machine) installation, and everything released before the ZeoKeel rebrand
; belonged to the PicoAide product (`ai.deepseek.dsh.desktop`). electron-builder
; derives the NSIS install key from a UUID-v5 of the appId, so detecting only the
; *current* GUID misses every real legacy installation and silently installs a
; second copy under %LOCALAPPDATA% (2026-10-21 packaging review: the first
; version of this shim had exactly that hole).
;
; This shim refuses to continue when it finds a legacy layout, and it never
; blocks a silent (/S) update: in silent mode it writes the diagnostic, sets
; exit code 2 and quits — NSIS would otherwise *show* the message box and hang
; an unattended update forever (`/SD` is required to suppress it).
;
; Removing a Program Files installation needs elevation, which a per-user
; installer must not request, so the honest action is to stop and tell the user.
; The app also pre-checks the same keys before handing over to this installer,
; so an in-app update shows a native dialog instead of an exit code.

; PicoAide Harness (pre-rebrand) — UUID v5 of `ai.deepseek.dsh.desktop`.
!define ZK_LEGACY_APP_GUID "85820364-4c28-594e-b046-8896b3669248"

!macro customInit
  StrCpy $0 ""

  ; Current product, per-machine (customInit runs after initMultiUser decided
  ; the mode, so this catches an existing ZeoKeel all-users install as well).
  ReadRegStr $1 HKLM "Software\${APP_GUID}" "InstallLocation"
  StrCmp $1 "" 0 zk_legacy_found
  ; Legacy product, per-machine (HKLM) and per-user (HKCU).
  ReadRegStr $1 HKLM "Software\${ZK_LEGACY_APP_GUID}" "InstallLocation"
  StrCmp $1 "" 0 zk_legacy_found
  ReadRegStr $1 HKCU "Software\${ZK_LEGACY_APP_GUID}" "InstallLocation"
  StrCmp $1 "" 0 zk_legacy_found
  Goto zk_no_legacy_install

  zk_legacy_found:
  StrCpy $0 $1

  StrCpy $2 "$TEMP\zeokeel-harness-legacy-install.txt"
  FileOpen $3 "$2" w
  FileWrite $3 "ZeoKeel Harness found an existing installation that must not be upgraded silently:$\r$\n"
  FileWrite $3 "$0$\r$\n"
  FileWrite $3 "Uninstall it first (Settings > Apps), then run this installer again.$\r$\n"
  FileClose $3

  IfSilent zk_legacy_abort
  MessageBox MB_ICONEXCLAMATION|MB_OK \
    "ZeoKeel Harness found an existing installation that needs a manual upgrade:$\r$\n$0$\r$\n$\r$\nUninstall it first (Settings > Apps), then run this installer again.$\r$\n$\r$\n检测到旧版本安装：请先到「设置 > 应用」卸载旧版本，再重新运行安装/更新。$\r$\n（诊断记录：$2）"

  zk_legacy_abort:
  SetErrorLevel 2
  Quit

  zk_no_legacy_install:
!macroend

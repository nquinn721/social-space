; The app was called "Social Manager" before it became "Social Space". The NSIS install folder,
; shortcuts and uninstall entry are all named after productName, so the first install under the
; new name lands beside the old one. This removes the old copy so only Social Space is left.
; App data (keyed by the bundle identifier) and saved passwords (Windows Credential Manager)
; are not touched.
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $0 "$LOCALAPPDATA\Social Manager"
  ${If} $0 != $INSTDIR
  ${AndIf} ${FileExists} "$0\social-manager.exe"
    Delete "$DESKTOP\Social Manager.lnk"
    Delete "$SMPROGRAMS\Social Manager.lnk"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Social Manager"
    DeleteRegKey HKCU "Software\socialmanager\Social Manager"
    RMDir /r "$0"
  ${EndIf}
!macroend

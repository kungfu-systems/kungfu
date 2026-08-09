; SPDX-License-Identifier: Apache-2.0

; Native DLL/PYD files can be held briefly by Windows scanners after the
; packaged runtime exits. electron-builder's default recursive removal makes
; only one attempt, so retry this owned runtime subtree before the default
; uninstall section removes the rest of $INSTDIR.
!macro customUnInstall
  SetOutPath "$TEMP"
  Push $R8
  StrCpy $R8 60

kungfu_runtime_retry:
  RMDir /r "$INSTDIR\resources\kungfu"
  IfFileExists "$INSTDIR\resources\kungfu\*.*" 0 kungfu_runtime_removed
  Sleep 500
  IntOp $R8 $R8 - 1
  IntCmp $R8 0 kungfu_runtime_timeout kungfu_runtime_retry kungfu_runtime_retry

kungfu_runtime_timeout:
  DetailPrint "Kungfu runtime files remain busy; the default uninstall pass will retry once."

kungfu_runtime_removed:
  Pop $R8
!macroend

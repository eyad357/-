; Custom NSIS steps for the school-accreditation installer.
;
; Goal: the evidence folder must exist as a SIBLING of the .exe the moment
; setup finishes — not only after the app is launched for the first time.
; electron-builder already copies resources\evidence-template (via
; extraResources) into "$INSTDIR\resources\evidence-template" as part of the
; normal file-copy step; all this macro does is mirror that read-only
; template into a normal, writable folder next to the .exe, using $INSTDIR
; (never a hardcoded drive letter) so it always lands wherever the user
; chose to install — C:, D:, a USB drive, anywhere.
;
; It is safe to run on every install AND every upgrade/repair: CreateDirectory
; is a no-op if the folder already exists, and CopyFiles only ever adds the
; template's (empty) folder structure — the template itself ships with zero
; real files, so there is never anything to overwrite. Any real evidence
; files a school has already added are never touched.

!macro customInstall
  CreateDirectory "$INSTDIR\معايير التقويم والاعتماد المدرسي"
  IfFileExists "$INSTDIR\resources\evidence-template\*.*" 0 +2
    CopyFiles /SILENT "$INSTDIR\resources\evidence-template\*.*" "$INSTDIR\معايير التقويم والاعتماد المدرسي\"
!macroend

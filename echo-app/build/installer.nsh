!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "是否同时删除 Echo 的设置、音乐画像、聊天记忆和其他本地数据？$\r$\n$\r$\n选择“否”会保留数据，重新安装后可以继续使用。$\r$\n选择“是”会永久删除，无法恢复。" \
        IDNO echo_keep_app_data

      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}

      RMDir /r "$APPDATA\${APP_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
      !endif
      RMDir /r "$APPDATA\Echo"
      RMDir /r "$APPDATA\echo-app"
      RMDir /r "$APPDATA\echo-agent-kernel"
      RMDir /r "$LOCALAPPDATA\Echo"
      RMDir /r "$LOCALAPPDATA\echo-app"
      RMDir /r "$LOCALAPPDATA\echo-agent-kernel"
      RMDir /r "$INSTDIR\data"

      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}

      echo_keep_app_data:
    ${endif}
  ${endif}
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP

  Delete "$INSTDIR\Echo.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\uninstallerIcon.ico"
  Delete "$INSTDIR\Uninstall Echo.exe"

  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  RMDir "$INSTDIR"
!macroend

!macro customInstall
  RMDir /r "$INSTDIR\resources\prompts"
!macroend

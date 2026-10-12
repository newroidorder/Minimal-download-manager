; Uninstall: remove the browser connection the program registered
; (main/native.js). Settings and the download list stay.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.minimaldm.bridge"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.minimaldm.bridge"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.minimaldm.bridge"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.minimaldm.bridge"
!macroend
